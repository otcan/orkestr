import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { replyToBridgeThread } from "../packages/core/src/thread-bridge.js";
import { sendBridgeMessage } from "../packages/core/src/thread-bridge-messaging.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";
import { dataPaths, ensureDataDirs } from "../packages/storage/src/paths.js";
import { syncActiveRuntimeRolloutMessages } from "../packages/core/src/runtime-leases.js";

const principal = {
  kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a",
  issuer: "orkestr", authMethod: "orkestr-oauth", scopes: ["threads:read", "threads:comment", "threads:message"],
};
const grant = {
  id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  enabled: true, expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all",
};

function response(payload, ok = true, status = 200) {
  return { ok, status, async json() { return payload; } };
}

async function fixture(t, { binding = undefined, generation = "" } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mcp-wa-replies-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "sqlite",
    ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_THREAD_BRIDGE_ENABLED: "1",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
  };
  await fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify([grant]));
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://fixture.invalid" }, env);
  await createUser({ id: "owner-a" }, env);
  await createThread({
    id: "thread-a", ownerUserId: "owner-a", name: "Synthetic thread", ...(binding ? { binding } : {}),
    ...(generation ? {
      state: "working", codexThreadId: generation,
      executor: { type: "codex", codexThreadId: generation },
      runtime: { runtimeKind: "codex-app-server", codexThreadId: generation, runtimeGeneration: generation },
    } : {}),
  }, env);
  t.after(async () => {
    await closeThreadMessageRegistryCache();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return env;
}

async function writeRolloutProjection(env, generation, { phase, text, filename }) {
  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, filename);
  const timestamp = new Date(Date.now() + 1000).toISOString();
  const entry = phase === "final_answer"
    ? {
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] },
    }
    : {
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase, message: text },
    };
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify(entry),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: `synthetic-${filename}`, threadId: "thread-a", sessionName: `synthetic-${filename}`,
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  return syncActiveRuntimeRolloutMessages(env);
}

const eligibleBinding = {
  connector: "whatsapp", chatId: "synthetic-chat-a", enabled: true, routeEligible: true,
  responderAccountId: "synthetic-account-a", outboundAccountId: "synthetic-account-a", mirrorToWhatsApp: true,
};


test("active runtime rollout preserves MCP opt-out before WhatsApp mirror routing", async (t) => {
  const generation = "93f4314a-e4fc-45e1-8137-e1ba7412001d";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const sent = await sendBridgeMessage("thread-a", {
    text: "Synthetic opt-out rollout request", requestId: "rollout-opt-out", deliverToWhatsApp: false,
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", sent.messageId, {
    codexThreadId: generation,
    codexTurnId: "turn-mcp-opt-out",
  }, env);

  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message", role: "assistant", phase: "final_answer", turn_id: "turn-mcp-opt-out",
        content: [{ type: "output_text", text: "Synthetic private final." }],
      },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-rollout-lease", threadId: "thread-a", sessionName: "synthetic-rollout-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");

  const projection = await syncActiveRuntimeRolloutMessages(env);
  assert.equal(projection.appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic private final.");
  assert.equal(projected.parentMessageId, sent.messageId);
  assert.equal(projected.chatId, eligibleBinding.chatId, "fixture reproduces binding-derived rollout projection");
  assert.equal(projected.bridgeWhatsAppReply, false, "the projection carries authoritative opt-out state");

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "opt-out is enforced before every mirror/router origin path");
});

test("active runtime commentary without a turn id retains MCP opt-out and cannot enter progress recovery", async (t) => {
  const generation = "60bfb2e7-8690-49b9-bbb5-62ad910fc1bd";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const sent = await sendBridgeMessage("thread-a", {
    text: "Synthetic opt-out commentary request", requestId: "rollout-commentary-opt-out", deliverToWhatsApp: false,
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", sent.messageId, { state: "running" }, env);
  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-commentary.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic private progress without a turn id." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-commentary-lease", threadId: "thread-a", sessionName: "synthetic-commentary-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");

  const projection = await syncActiveRuntimeRolloutMessages(env);
  assert.equal(projection.appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic private progress without a turn id.");
  assert.equal(projected.parentMessageId, sent.messageId, "the active generation supplies the durable execution parent when rollout commentary omits turn_id");
  assert.equal(projected.bridgeWhatsAppReply, false, "progress projection preserves the MCP request's authoritative opt-out");

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "progress, cursor recovery and fallback origin paths all honor MCP opt-out");
});

test("active runtime progress delivery fails closed when the captured MCP owner or binding changes", async (t) => {
  const generation = "8d6f2e99-b5e5-4c09-ad24-d15b32c5a1de";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  await createUser({ id: "owner-b" }, env);
  const sent = await sendBridgeMessage("thread-a", {
    text: "Synthetic opted-in commentary request", requestId: "rollout-commentary-fenced",
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", sent.messageId, { state: "running" }, env);
  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-commentary-fenced.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic progress for the captured owner only." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-fenced-commentary-lease", threadId: "thread-a", sessionName: "synthetic-fenced-commentary-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  assert.equal((await syncActiveRuntimeRolloutMessages(env)).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic progress for the captured owner only.");
  assert.equal(projected.parentMessageId, sent.messageId);
  assert.equal(projected.replyDeliveryIntent, undefined);

  await updateThread("thread-a", {
    ownerUserId: "owner-b",
    binding: { ...eligibleBinding, chatId: "synthetic-chat-b", responderAccountId: "synthetic-account-b", outboundAccountId: "synthetic-account-b" },
  }, env);
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-b", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "recovery must not redirect an MCP progress update to a replacement owner or binding");
});

test("progress recovery durably resolves old MCP parent and never mixes its destination with a replacement account", async (t) => {
  const generation = "d0378d6e-3163-4c71-9539-1e88ae1c896d";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  await createUser({ id: "owner-b" }, env);
  const sent = await sendBridgeMessage("thread-a", {
    text: "Synthetic old-parent progress request", requestId: "rollout-commentary-old-parent",
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", sent.messageId, { codexThreadId: generation, state: "running" }, env);
  for (let index = 0; index < 30; index += 1) {
    await replyToBridgeThread("thread-a", { requestId: `old-parent-comment-${index}`, text: `Synthetic aged context ${index}` }, principal, env);
  }

  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-commentary-old-parent.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic progress must not cross owner boundaries." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-old-parent-commentary-lease", threadId: "thread-a", sessionName: "synthetic-old-parent-commentary-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  assert.equal((await syncActiveRuntimeRolloutMessages(env)).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic progress must not cross owner boundaries.");
  assert.equal(projected.parentMessageId, sent.messageId);
  assert.equal(projected.chatId, eligibleBinding.chatId, "projection retains the request-time chat snapshot");

  await updateThread("thread-a", {
    ownerUserId: "owner-b",
    binding: { ...eligibleBinding, chatId: "synthetic-chat-b", responderAccountId: "synthetic-account-b", outboundAccountId: "synthetic-account-b" },
  }, env);
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push({ options, body: JSON.parse(String(options.body || "{}")) });
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-b", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "durable parent lookup restores the MCP fence before any account/chat combination can be dispatched");
});

test("rollout commentary belongs to the unique running MCP input, never a later queued default-delivery request", async (t) => {
  const generation = "c69ee3f2-2bd8-4e65-9409-63275f79cf93";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const requestA = await sendBridgeMessage("thread-a", {
    text: "Synthetic private request A", requestId: "running-optout-a", deliverToWhatsApp: false,
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", requestA.messageId, { codexThreadId: generation, state: "running" }, env);
  const requestB = await sendBridgeMessage("thread-a", {
    text: "Synthetic later queued request B", requestId: "queued-default-b",
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", requestB.messageId, { codexThreadId: generation }, env);
  const b = (await listThreadMessages("thread-a", env)).find((message) => message.id === requestB.messageId);
  assert.equal(b.state, "queued");

  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-running-a-queued-b.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic private commentary for running A." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-running-a-queued-b-lease", threadId: "thread-a", sessionName: "synthetic-running-a-queued-b-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  assert.equal((await syncActiveRuntimeRolloutMessages(env)).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic private commentary for running A.");
  assert.equal(projected.parentMessageId, requestA.messageId, "only the unique running input can own rollout commentary");
  assert.equal(projected.bridgeWhatsAppReply, false, "request A's opt-out is preserved instead of inheriting request B's default");

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "queued request B cannot authorize delivery of request A's private progress");
});

test("a unique running opted-in MCP input retains the default progress route", async (t) => {
  const generation = "40a2f464-c658-4e7e-ae25-a78f8b5ff6f8";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const request = await sendBridgeMessage("thread-a", {
    text: "Synthetic opted-in running request", requestId: "running-default-progress",
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", request.messageId, { codexThreadId: generation, state: "running" }, env);
  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-running-default.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic progress for the opted-in active request." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-running-default-lease", threadId: "thread-a", sessionName: "synthetic-running-default-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  assert.equal((await syncActiveRuntimeRolloutMessages(env)).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic progress for the opted-in active request.");
  assert.equal(projected.parentMessageId, request.messageId);

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(JSON.parse(String(options.body || "{}")));
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["synthetic-wa-progress"] });
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to, eligibleBinding.chatId, "the destination stays bound to the single active request's captured authority");
  assert.equal(result.delivered.some((delivery) => delivery.messageId === projected.id), true);
});

test("ambiguous active MCP inputs fail closed instead of inheriting the thread's WhatsApp binding", async (t) => {
  const generation = "44971559-dab7-4608-a3d8-c39ef6d30cf0";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  for (const [requestId, text] of [["ambiguous-a", "Synthetic active A"], ["ambiguous-b", "Synthetic active B"]]) {
    const sent = await sendBridgeMessage("thread-a", { text, requestId }, principal, env, { deliver() {} });
    await updateThreadMessage("thread-a", sent.messageId, { codexThreadId: generation, state: "running" }, env);
  }
  await ensureDataDirs(env);
  const rolloutPath = path.join(env.ORKESTR_HOME, "rollout-ambiguous-active-inputs.jsonl");
  const timestamp = new Date().toISOString();
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Synthetic commentary has no unambiguous active parent." },
    }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{
    id: "synthetic-ambiguous-active-lease", threadId: "thread-a", sessionName: "synthetic-ambiguous-active-session",
    rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: timestamp,
  }]), "utf8");
  assert.equal((await syncActiveRuntimeRolloutMessages(env)).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic commentary has no unambiguous active parent.");
  assert.equal(projected.parentMessageId, null);
  assert.equal(projected.chatId || "", "", "ambiguous MCP authority cannot inherit a binding-derived destination");
  assert.equal(projected.accountId || "", "", "ambiguous MCP authority cannot inherit a binding-derived account");

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0);
});

test("late no-turn commentary keeps a completed MCP opt-out parent and stays out of WhatsApp", async (t) => {
  const generation = "ca05f6a9-f7fb-4e4e-b642-01f977c7364b";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const request = await sendBridgeMessage("thread-a", {
    text: "Synthetic completed opt-out request", requestId: "completed-optout-late-commentary", deliverToWhatsApp: false,
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", request.messageId, {
    codexThreadId: generation, codexTurnId: "turn-completed-optout-late-commentary", state: "completed",
  }, env);
  assert.equal((await writeRolloutProjection(env, generation, {
    phase: "commentary", text: "Synthetic late output from the completed private request.", filename: "rollout-completed-optout-late.jsonl",
  })).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic late output from the completed private request.");
  assert.equal(projected.parentMessageId, request.messageId);
  assert.equal(projected.bridgeWhatsAppReply, false, "completion before sync does not erase request-time opt-out authority");

  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0);
});

test("ordinary unparented progress safely uses its existing bound-thread route", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const progress = await appendThreadMessage("thread-a", {
    role: "assistant", source: "codex-rollout", phase: "commentary", state: "completed",
    chatId: eligibleBinding.chatId, accountId: "synthetic-account-a", text: "Synthetic unparented legacy progress.",
  }, env);
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(JSON.parse(String(options.body || "{}")));
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["synthetic-progress-receipt"] });
  });
  assert.equal(result.delivered.some((delivery) => delivery.messageId === progress.id), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to, eligibleBinding.chatId);
});

test("late no-turn commentary and final preserve opt-out across completed, failed and interrupted lifecycle states", async (t) => {
  for (const state of ["completed", "failed", "interrupted"]) {
    for (const phase of ["commentary", "final_answer"]) {
      await t.test(`${state} ${phase}`, async (subtest) => {
        const generation = `synthetic-${state}-${phase}-generation`;
        const env = await fixture(subtest, { binding: eligibleBinding, generation });
        const request = await sendBridgeMessage("thread-a", {
          text: `Synthetic ${state} opt-out ${phase}`, requestId: `${state}-${phase}-optout`, deliverToWhatsApp: false,
        }, principal, env, { deliver() {} });
        await updateThreadMessage("thread-a", request.messageId, {
          codexThreadId: generation,
          codexTurnId: `turn-${state}-${phase}`,
          state,
          deliveryState: state === "completed" ? "delivered" : state,
        }, env);
        const text = `Synthetic late ${phase} for ${state} opt-out.`;
        assert.equal((await writeRolloutProjection(env, generation, {
          phase, text, filename: `rollout-${state}-${phase}.jsonl`,
        })).appended, 1);
        const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === text);
        assert.equal(projected.parentMessageId, request.messageId, "recorded MCP turn identity preserves the late output's original authority");
        assert.equal(projected.bridgeWhatsAppReply, false);

        const posts = [];
        const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
          if (options.method === "POST") posts.push(options);
          return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
        });
        assert.equal(result.delivered.length, 0);
        assert.equal(posts.length, 0, "terminal lifecycle state cannot turn an MCP opt-out into binding fallback delivery");
      });
    }
  }
});

test("ordinary unparented final safely uses its existing bound-thread route", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const final = await appendThreadMessage("thread-a", {
    role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    chatId: eligibleBinding.chatId, accountId: "synthetic-account-a", text: "Synthetic unparented legacy final.",
  }, env);
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(JSON.parse(String(options.body || "{}")));
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["synthetic-final-receipt"] });
  });
  assert.equal(result.delivered.some((delivery) => delivery.messageId === final.id), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to, eligibleBinding.chatId);
});

test("late no-turn final output keeps the completed MCP opt-out parent", async (t) => {
  const generation = "74fb9ee6-8fbd-4da7-8681-8f46dad0dc2c";
  const env = await fixture(t, { binding: eligibleBinding, generation });
  const request = await sendBridgeMessage("thread-a", {
    text: "Synthetic completed final opt-out request", requestId: "completed-optout-late-final", deliverToWhatsApp: false,
  }, principal, env, { deliver() {} });
  await updateThreadMessage("thread-a", request.messageId, {
    codexThreadId: generation, codexTurnId: "turn-completed-optout-late-final", state: "completed",
  }, env);
  assert.equal((await writeRolloutProjection(env, generation, {
    phase: "final_answer", text: "Synthetic late private final.", filename: "rollout-completed-optout-final.jsonl",
  })).appended, 1);
  const projected = (await listThreadMessages("thread-a", env)).find((message) => message.text === "Synthetic late private final.");
  assert.equal(projected.parentMessageId, request.messageId);
  assert.equal(projected.bridgeWhatsAppReply, false);
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ready: true, accounts: [{ id: "synthetic-account-a", ready: true }], ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0);
});
