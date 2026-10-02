import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { replyToBridgeThread } from "../packages/core/src/thread-bridge.js";
import { sendBridgeMessage } from "../packages/core/src/thread-bridge-messaging.js";
import { threadBridgeToolDefinitions } from "../packages/core/src/thread-bridge-mcp.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { threadBridgeWhatsAppReplyOrigin } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
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

const eligibleBinding = {
  connector: "whatsapp", chatId: "synthetic-chat-a", enabled: true, routeEligible: true,
  responderAccountId: "synthetic-account-a", outboundAccountId: "synthetic-account-a", mirrorToWhatsApp: true,
};

test("MCP send_message answers use only the existing thread binding and the durable mirror sends once", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const sent = await sendBridgeMessage("thread-a", { text: "Run the synthetic task", requestId: "request-1" }, principal, env, { deliver() {} });
  const duplicate = await sendBridgeMessage("thread-a", { text: "Run the synthetic task", requestId: "request-1" }, principal, env, { deliver() {} });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.messageId, sent.messageId);

  const [input] = (await listThreadMessages("thread-a", env)).filter((message) => message.id === sent.messageId);
  assert.equal(input.source, "thread_bridge_message");
  assert.equal(input.bridgeAgentId, principal.agentId, "delegated-agent attribution is preserved");
  assert.equal(input.bridgeWhatsAppReply, true, "WhatsApp delivery defaults on");
  assert.equal(input.replyDeliveryIntent.target.ownerUserId, "owner-a", "delivery authority is captured at request time");
  assert.equal(input.replyDeliveryIntent.target.chatId, eligibleBinding.chatId);
  assert.equal(input.replyDeliveryIntent.target.accountId, "synthetic-account-a");
  assert.equal(input.chatId || "", "", "the MCP input carries no caller-selected destination");
  const answer = await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "Synthetic task complete.",
  }, env);

  const sends = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") sends.push({ pathname: new URL(url).pathname, body: JSON.parse(String(options.body || "{}")) });
    return response({ ok: true, ids: ["synthetic-wa-receipt"] });
  };
  const first = await deliverWhatsAppReplies(env, fetchImpl);
  const second = await deliverWhatsAppReplies(env, fetchImpl);

  assert.equal(first.delivered.some((delivery) => delivery.messageId === answer.id), true);
  assert.equal(second.delivered.length, 0);
  assert.equal(sends.length, 1, "the durable outbox suppresses duplicate answer delivery");
  assert.equal(sends[0].body.to, eligibleBinding.chatId, "destination comes from the server-owned thread binding");
  assert.notEqual(sends[0].body.to, "caller-selected-chat");
});

test("an ineligible or absent WhatsApp binding never creates a fallback destination", async (t) => {
  const noBindingEnv = await fixture(t);
  const noBindingParent = { source: "thread_bridge_message", bridgeWhatsAppReply: true };
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: noBindingParent, thread: { id: "thread-a" }, kind: "thread" }), false);

  const disabledEnv = await fixture(t, { binding: { ...eligibleBinding, enabled: false } });
  const disabledThread = { id: "thread-a", binding: { ...eligibleBinding, enabled: false } };
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: noBindingParent, thread: disabledThread, kind: "thread" }), false);

  const sent = await sendBridgeMessage("thread-a", { text: "No implicit destination", requestId: "no-binding" }, principal, noBindingEnv, { deliver() {} });
  const [input] = (await listThreadMessages("thread-a", noBindingEnv)).filter((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", { role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed", parentMessageId: input.id, text: "No route." }, noBindingEnv);
  const calls = [];
  const result = await deliverWhatsAppReplies(noBindingEnv, async (_url, options = {}) => {
    if (options.method === "POST") calls.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: noBindingParent, thread: disabledThread, kind: "thread" }), false);
});

test("send_message supports an explicit WhatsApp opt-out without exposing recipient fields", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const sent = await sendBridgeMessage("thread-a", { text: "Keep this in thread", requestId: "opt-out", deliverToWhatsApp: false }, principal, env, { deliver() {} });
  const [input] = (await listThreadMessages("thread-a", env)).filter((message) => message.id === sent.messageId);
  assert.equal(input.bridgeWhatsAppReply, false);
  assert.equal(input.replyDeliveryIntent, undefined);
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: input, thread: { id: "thread-a", binding: eligibleBinding }, kind: "thread" }), false);

  const definition = threadBridgeToolDefinitions().find((tool) => tool.name === "send_message");
  assert.equal(definition.inputSchema.properties.deliver_to_whatsapp.type, "boolean");
  assert.equal("chat_id" in definition.inputSchema.properties, false);
  assert.equal("recipient" in definition.inputSchema.properties, false);
});

test("reply parent lookup survives more than the mirror cursor overlap of passive comments", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const sent = await sendBridgeMessage("thread-a", { text: "Keep the request in the full history", requestId: "long-thread" }, principal, env, { deliver() {} });
  for (let index = 0; index < 30; index += 1) {
    await replyToBridgeThread("thread-a", { requestId: `comment-${index}`, text: `Synthetic context ${index}` }, principal, env);
  }
  const transport = async (_url, options = {}) => response({ ok: true, ids: ["synthetic-wa-receipt"] });
  await deliverWhatsAppReplies(env, transport);
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  const answer = await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "Answer after many comments.",
  }, env);
  const result = await deliverWhatsAppReplies(env, transport);
  assert.equal(result.delivered.some((delivery) => delivery.messageId === answer.id), true);
});

test("request-time owner, WhatsApp binding and account changes fence delivery", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  await createUser({ id: "owner-b" }, env);
  const sent = await sendBridgeMessage("thread-a", { text: "Do not follow a changed binding", requestId: "stale-authority" }, principal, env, { deliver() {} });
  await updateThread("thread-a", {
    ownerUserId: "owner-b",
    binding: { ...eligibleBinding, chatId: "synthetic-chat-b", responderAccountId: "synthetic-account-b", outboundAccountId: "synthetic-account-b" },
  }, env);
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "Must not reach the replacement owner.",
  }, env);
  const calls = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") calls.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(calls.length, 0, "a changed request-time authority is rejected before transport");
});

test("authority is rechecked after account resolution immediately before dispatch", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  await createUser({ id: "owner-b" }, env);
  const sent = await sendBridgeMessage("thread-a", { text: "Recheck after transport setup", requestId: "pre-dispatch-authority" }, principal, env, { deliver() {} });
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "Must not dispatch after the account probe changes authority.",
  }, env);
  let changed = false;
  const sends = [];
  const result = await deliverWhatsAppReplies(env, async (url, options = {}) => {
    if (new URL(url).pathname === "/health" && !changed) {
      changed = true;
      await updateThread("thread-a", {
        ownerUserId: "owner-b",
        binding: { ...eligibleBinding, chatId: "synthetic-chat-b", responderAccountId: "synthetic-account-b", outboundAccountId: "synthetic-account-b" },
      }, env);
      return response({ ok: true, accounts: [{ id: "synthetic-account-a", ready: true }] });
    }
    if (options.method === "POST") sends.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(changed, true, "the synthetic account-resolution probe ran");
  assert.equal(result.delivered.length, 0);
  assert.equal(sends.length, 0, "the request is revalidated after setup and before transport dispatch");
});

test("transport_send fault-boundary binding disable fails before any mocked POST", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const sent = await sendBridgeMessage("thread-a", { text: "Validate at the send boundary", requestId: "fault-boundary-authority" }, principal, env, { deliver() {} });
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "Must stop at the send boundary.",
  }, env);
  let changed = false;
  env.ORKESTR_TEST_RUNTIME_FAULT_INJECTOR = {
    transport_send: async () => {
      if (changed) return;
      changed = true;
      await updateThread("thread-a", {
        binding: { ...eligibleBinding, enabled: false, routeEligible: false },
      }, env);
    },
  };
  const posts = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") posts.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(changed, true, "the fault hook ran immediately before the live fence");
  assert.equal(result.delivered.length, 0);
  assert.equal(posts.length, 0, "a disabled request-time binding cannot reach transport");
});

test("a binding change during transport never redirects or retries to the replacement owner", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  await createUser({ id: "owner-b" }, env);
  const sent = await sendBridgeMessage("thread-a", { text: "Fence transport-time authority", requestId: "in-flight-authority" }, principal, env, { deliver() {} });
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, text: "In-flight synthetic answer.",
  }, env);
  const calls = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      calls.push(body);
      await updateThread("thread-a", {
        ownerUserId: "owner-b",
        binding: { ...eligibleBinding, chatId: "synthetic-chat-b", responderAccountId: "synthetic-account-b", outboundAccountId: "synthetic-account-b" },
      }, env);
    }
    return response({ ok: true, ids: ["synthetic-wa-receipt"] });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, eligibleBinding.chatId);
  assert.equal(calls[0].accountId, "synthetic-account-a");
  assert.notEqual(calls[0].to, "synthetic-chat-b");
  assert.equal(result.delivered.length, 0, "authority mutation during transport is not recorded as a current delivery");
  const retry = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") calls.push(JSON.parse(String(options.body || "{}")));
    return response({ ok: true, ids: ["unexpected-retry"] });
  });
  assert.equal(retry.delivered.length, 0);
  assert.equal(calls.length, 1, "stale in-flight authority is terminal and cannot be redirected on retry");
});

test("explicit opt-out cannot be bypassed by a matching projected chatId", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  const sent = await sendBridgeMessage("thread-a", { text: "Stay in Orkestr", requestId: "projection-opt-out", deliverToWhatsApp: false }, principal, env, { deliver() {} });
  const input = (await listThreadMessages("thread-a", env)).find((message) => message.id === sent.messageId);
  await appendThreadMessage("thread-a", {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    parentMessageId: input.id, connector: "whatsapp", chatId: eligibleBinding.chatId,
    accountId: "synthetic-account-a", text: "This projected target must be ignored.",
  }, env);
  const calls = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") calls.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(calls.length, 0);
});

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

test("passive comments never qualify for execution-answer WhatsApp delivery", async (t) => {
  const env = await fixture(t, { binding: eligibleBinding });
  await replyToBridgeThread("thread-a", { requestId: "comment-1", text: "Context only" }, principal, env);
  const comment = (await listThreadMessages("thread-a", env)).find((message) => message.source === "thread_bridge_agent");
  assert.ok(comment);
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: comment, thread: { id: "thread-a", binding: eligibleBinding }, kind: "thread" }), false);
  const calls = [];
  const result = await deliverWhatsAppReplies(env, async (_url, options = {}) => {
    if (options.method === "POST") calls.push(options);
    return response({ ok: true, ids: ["unexpected"] });
  });
  assert.equal(result.delivered.length, 0);
  assert.equal(calls.length, 0, "a passive comment is never forwarded to WhatsApp");
});

test("MCP approval copy distinguishes passive comments from WhatsApp-delivered execution answers", async () => {
  const controller = await fs.readFile(new URL("../apps/server/src/modules/threads/thread-bridge-mcp.controller.ts", import.meta.url), "utf8");
  assert.match(controller, /Comments are context only and are not sent to WhatsApp/);
  assert.match(controller, /agent's answer is also sent through the thread's existing eligible WhatsApp binding by default/);
  assert.match(controller, /no WhatsApp message is sent when the thread has no eligible binding/);
  assert.doesNotMatch(controller, /agent's answer stays in Orkestr and is not sent to WhatsApp/);
});
