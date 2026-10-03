// Mixed reply authority through the real Claude Code coalescing path: MCP
// send_message inputs (default WhatsApp delivery vs deliver_to_whatsapp=false)
// arriving while a turn runs must never share one answer, in either order.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { CLAUDE_CODE_INTERRUPT_RESUME_NOTE, replyAuthorityKey } from "../packages/core/src/claude-code-interrupt-resume.js";
import { deliverClaudeCodePendingInputs, hasActiveClaudeCodeSupervisor, resetClaudeCodeRuntimeForTest, startClaudeCodeThread } from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";
import { createUiReplyDeliveryIntent, createWorkerReplyDeliveryIntent } from "../packages/core/src/reply-delivery-intent.js";
import { createUser } from "../packages/core/src/users.js";
import { sendBridgeMessage } from "../packages/core/src/thread-bridge-messaging.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const principal = { kind: "delegated-agent", ownerUserId: "owner", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  scopes: ["threads:read", "threads:comment", "threads:message"] };
const binding = { connector: "whatsapp", chatId: "synthetic-chat-a", enabled: true, routeEligible: true,
  responderAccountId: "synthetic-account-a", outboundAccountId: "synthetic-account-a", mirrorToWhatsApp: true };
const steer = { steerActiveTurn: true, codexDeliveryMode: "instant_steer" };
const NO_KICK = { deliver() {} };

async function fixture(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-bridge-coalesce-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(entry) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (args[0] === "auth") { emit({ authenticated: true, status: "logged_in" }); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const session = resumeAt >= 0 ? args[resumeAt + 1] : "claude_session_fresh";
  record({ turn: true, prompt: prompt.trim() });
  emit({ type: "system", subtype: "init", session_id: session });
  const result = () => emit({ type: "result", session_id: session, is_error: false, result: "Reply: " + prompt.trim() });
  if (prompt.includes("long task")) {
    process.on("SIGINT", () => { record({ signal: "SIGINT" }); setTimeout(() => process.exit(130), 100); });
    record({ started: true });
    setTimeout(() => { result(); process.exit(0); }, 1500);
    return;
  }
  result();
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home, ORKESTR_CLAUDE_CODE_ENABLED: "1", ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_CODE_INTERRUPT_GRACE_MS: "2000", ORKESTR_CLAUDE_GRACE_PERIOD_MS: "200",
    ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_DEBUG_FOOTER: "0", ORKESTR_ADMIN_USER_ID: "owner",
  };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    await closeThreadMessageRegistryCache();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await createUser({ id: "owner" }, env).catch(() => null);
  await fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify([{ id: "grant-a", ownerUserId: "owner", agentId: "agent-a", issuer: "orkestr",
    authMethod: "orkestr-oauth", enabled: true, expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all" }]));
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://fixture.invalid" }, env);
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Coalesce", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  const created = await createThread({
    id: `claude-${name}`, name: `Bridge coalesce ${name}`, ownerUserId: "owner", executorId: "claude-code", runtimeKind: "claude-code", binding,
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
  }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  return { env, calls, thread };
}

async function readCalls(calls) {
  const raw = await fs.readFile(calls, "utf8").catch(() => "");
  return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function waitForStarted(calls, threadId) {
  for (let started = Date.now(); Date.now() - started < 8000;) {
    if (hasActiveClaudeCodeSupervisor(threadId) && (await readCalls(calls)).some((entry) => entry.started)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("turn did not start");
}

async function whatsAppPosts(env) {
  const posts = [];
  await deliverWhatsAppReplies(env, async (url, options = {}) => {
    if (options.method === "POST") posts.push(String(options.body || ""));
    return { ok: true, status: 200, async json() { return { ok: true, ids: ["synthetic-receipt"] }; } };
  });
  return posts;
}

// Runs a long turn, queues two inputs while it runs, drains, and returns the
// turn prompts, the finals by parent and every WhatsApp POST body.
async function runMixed(t, name, enqueue) {
  const { env, calls, thread } = await fixture(t, name);
  await enqueueThreadInput(thread.id, { text: "long task first", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  const [first, second] = await enqueue(thread, env);
  await deliverClaudeCodePendingInputs(thread, env);
  await owner;
  // Drain like the delivery scheduler: keep delivering until nothing is pending.
  for (let round = 0; round < 200; round += 1) {
    const open = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "user" && !["completed", "failed", "cancelled"].includes(message.state));
    if (!open.length && !hasActiveClaudeCodeSupervisor(thread.id)) break;
    if (!hasActiveClaudeCodeSupervisor(thread.id)) await deliverClaudeCodePendingInputs(thread, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const prompts = (await readCalls(calls)).filter((entry) => entry.turn).map((entry) => entry.prompt);
  const messages = await listThreadMessages(thread.id, env);
  const finals = messages.filter((message) => message.role === "assistant" && message.phase === "final_answer");
  return { env, prompts, messages, finals, first, second, posts: await whatsAppPosts(env) };
}

for (const order of ["default-then-optout", "optout-then-default"]) {
  test(`MCP /now messages with mixed WhatsApp opt-out never share a turn (${order})`, async (t) => {
    const optOutFirst = order === "optout-then-default";
    const result = await runMixed(t, `mcp-${order}`, async (thread, env) => {
      const send = (text, requestId, deliverToWhatsApp) => sendBridgeMessage(thread.id, { text, requestId, ...(deliverToWhatsApp === false ? { deliverToWhatsApp: false } : {}) }, principal, env, NO_KICK);
      const a = () => send("/now synthetic-default-request", "req-a", true);
      const b = () => send("/now synthetic-optout-secret", "req-b", false);
      return optOutFirst ? [await b(), await a()] : [await a(), await b()];
    });
    // Commands are literal text for MCP: no interrupt, no coalescing.
    assert.equal(result.prompts.length, 3, "one turn per request");
    assert.ok(result.prompts.every((prompt) => !prompt.startsWith(CLAUDE_CODE_INTERRUPT_RESUME_NOTE)), "an MCP /now never interrupts the running turn");
    assert.ok(result.prompts.some((prompt) => prompt === "/now synthetic-optout-secret"));
    assert.ok(!result.prompts.some((prompt) => prompt.includes("synthetic-default-request") && prompt.includes("synthetic-optout-secret")));
    const inputs = result.messages.filter((message) => message.source === "thread_bridge_message");
    assert.ok(inputs.every((message) => message.commandProcessing === "disabled" && !message.coalescedIntoMessageId));
    for (const sent of [result.first, result.second]) {
      assert.equal(result.finals.filter((final) => final.parentMessageId === sent.messageId).length, 1, "each request has its own answer");
    }
    assert.ok(result.posts.length >= 1, "the default-delivery answer is sent");
    assert.ok(result.posts.every((body) => !body.includes("synthetic-optout-secret")), "opted-out content never reaches WhatsApp");
  });
}

for (const order of ["default-then-optout", "optout-then-default"]) {
  test(`queued MCP inputs from before the fix still never coalesce across opt-out (${order})`, async (t) => {
    // Inputs stored before commandProcessing existed: the source alone keeps
    // their "/now" literal, and the authority fence is a second barrier.
    const optOutFirst = order === "optout-then-default";
    const result = await runMixed(t, `legacy-${order}`, async (thread, env) => {
      const send = async (text, requestId, deliverToWhatsApp) => {
        const sent = await sendBridgeMessage(thread.id, { text, requestId, ...(deliverToWhatsApp === false ? { deliverToWhatsApp: false } : {}) }, principal, env, NO_KICK);
        await updateThreadMessage(thread.id, sent.messageId, { commandProcessing: "" }, env);
        return sent;
      };
      const a = () => send("/now synthetic-default-request", "legacy-a", true);
      const b = () => send("/now synthetic-optout-secret", "legacy-b", false);
      return optOutFirst ? [await b(), await a()] : [await a(), await b()];
    });
    assert.ok(!result.prompts.some((prompt) => prompt.includes("synthetic-default-request") && prompt.includes("synthetic-optout-secret")), "never one shared turn");
    for (const sent of [result.first, result.second]) {
      assert.equal(result.finals.filter((final) => final.parentMessageId === sent.messageId).length, 1);
    }
    assert.ok(result.posts.every((body) => !body.includes("synthetic-optout-secret")), "opted-out content never reaches WhatsApp");
  });
}

test("steer inputs with distinct reply authority are not coalesced; matching authority still is", async (t) => {
  const result = await runMixed(t, "distinct-authority", async (thread, env) => {
    const one = await enqueueThreadInput(thread.id, { text: "steer from chat one", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-chat-a", accountId: "synthetic-account-a", ...steer }, env);
    const two = await enqueueThreadInput(thread.id, { text: "steer from chat two", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-chat-b", accountId: "synthetic-account-a", ...steer }, env);
    return [{ messageId: one.id }, { messageId: two.id }];
  });
  assert.ok(!result.prompts.some((prompt) => prompt.includes("chat one") && prompt.includes("chat two")), "different chats get separate turns");
  assert.equal(result.finals.filter((final) => final.parentMessageId === result.first.messageId).length, 1);
  assert.equal(result.finals.filter((final) => final.parentMessageId === result.second.messageId).length, 1);

  const same = await runMixed(t, "same-authority", async (thread, env) => {
    const one = await enqueueThreadInput(thread.id, { text: "steer alpha", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-chat-a", accountId: "synthetic-account-a", ...steer }, env);
    const two = await enqueueThreadInput(thread.id, { text: "steer beta", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-chat-a", accountId: "synthetic-account-a", ...steer }, env);
    return [{ messageId: one.id }, { messageId: two.id }];
  });
  assert.ok(same.prompts.includes([CLAUDE_CODE_INTERRUPT_RESUME_NOTE, "steer alpha", "steer beta"].join("\n\n")), "same authority still coalesces");
});

test("replyAuthorityKey distinguishes opt-out, agent, chat and reply route", () => {
  const base = { source: "thread_bridge_message", bridgeAgentId: "agent-a", replyDeliveryIntent: { issuedFor: "mcp-send-message", mode: "bound_whatsapp", target: { threadId: "t", ownerUserId: "o", chatId: "c", accountId: "a", bindingRevision: "r1" } } };
  assert.equal(replyAuthorityKey(base), replyAuthorityKey({ ...base }));
  assert.notEqual(replyAuthorityKey(base), replyAuthorityKey({ ...base, bridgeWhatsAppReply: false, replyDeliveryIntent: undefined }));
  assert.notEqual(replyAuthorityKey(base), replyAuthorityKey({ ...base, bridgeAgentId: "agent-b" }));
  assert.notEqual(replyAuthorityKey(base), replyAuthorityKey({ ...base, replyDeliveryIntent: { ...base.replyDeliveryIntent, target: { ...base.replyDeliveryIntent.target, bindingRevision: "r2" } } }));
  assert.notEqual(replyAuthorityKey({ source: "ui" }), replyAuthorityKey({ source: "whatsapp_inbound", connector: "whatsapp", chatId: "c" }));
});

// Cross-origin: a WhatsApp, UI or worker request (each with its real captured
// reply route) next to an MCP request that opted out of WhatsApp.
const primaries = {
  whatsapp: (thread, env) => enqueueThreadInput(thread.id, { text: "/now synthetic-whatsapp-request", source: "whatsapp_inbound", connector: "whatsapp",
    chatId: binding.chatId, accountId: binding.responderAccountId }, env),
  ui: async (thread, env) => enqueueThreadInput(thread.id, { text: "synthetic-ui-request", source: "ui", originSurface: "webui", ...steer,
    replyDeliveryIntent: createUiReplyDeliveryIntent(await getThread(thread.id, env), { mode: "bound_whatsapp", ownerUserId: "owner", env }) }, env),
  worker: async (thread, env) => enqueueThreadInput(thread.id, { text: "synthetic-worker-request", source: "worker_assignment", ...steer,
    replyDeliveryIntent: createWorkerReplyDeliveryIntent(await getThread(thread.id, env), { mode: "bound_whatsapp", ownerUserId: "owner" }) }, env),
};

async function legacyOptOut(thread, env, requestId) {
  const sent = await sendBridgeMessage(thread.id, { text: "/now synthetic-optout-secret", requestId, deliverToWhatsApp: false }, principal, env, NO_KICK);
  await updateThreadMessage(thread.id, sent.messageId, { commandProcessing: "" }, env);
  return sent;
}

for (const [origin, enqueuePrimary] of Object.entries(primaries)) {
  for (const mcpFirst of [false, true]) {
    test(`${origin} request and an opted-out MCP request never share a turn (${mcpFirst ? "MCP first" : `${origin} first`})`, async (t) => {
      const result = await runMixed(t, `${origin}-${mcpFirst ? "mcp-first" : "primary-first"}`, async (thread, env) => {
        if (mcpFirst) {
          const b = await legacyOptOut(thread, env, `cross-${origin}-b`);
          const a = await enqueuePrimary(thread, env);
          return [b, { messageId: a.id }];
        }
        const a = await enqueuePrimary(thread, env);
        const b = await legacyOptOut(thread, env, `cross-${origin}-b`);
        return [{ messageId: a.id }, b];
      });
      assert.ok(!result.prompts.some((prompt) => prompt.includes("synthetic-optout-secret") && /synthetic-(whatsapp|ui|worker)-request/.test(prompt)), "never one shared prompt");
      const optOut = result.messages.find((message) => message.source === "thread_bridge_message");
      assert.equal(optOut.coalescedIntoMessageId || "", "");
      assert.equal(result.finals.filter((final) => final.parentMessageId === optOut.id).length, 1, "the MCP request has its own answer");
      assert.ok(result.posts.every((body) => !body.includes("synthetic-optout-secret")), "opted-out content never reaches WhatsApp");
    });
  }
}

test("same-origin steer inputs with different captured owners or binding revisions are not coalesced", async (t) => {
  const owners = await runMixed(t, "owners", async (thread, env) => {
    const current = await getThread(thread.id, env);
    const one = await enqueueThreadInput(thread.id, { text: "steer owner one", source: "worker_assignment", ...steer,
      replyDeliveryIntent: createWorkerReplyDeliveryIntent(current, { mode: "bound_whatsapp", ownerUserId: "owner" }) }, env);
    const two = await enqueueThreadInput(thread.id, { text: "steer owner two", source: "worker_assignment", ...steer,
      replyDeliveryIntent: createWorkerReplyDeliveryIntent(current, { mode: "bound_whatsapp", ownerUserId: "synthetic-other-owner" }) }, env);
    return [{ messageId: one.id }, { messageId: two.id }];
  });
  assert.ok(!owners.prompts.some((prompt) => prompt.includes("owner one") && prompt.includes("owner two")));

  const revisions = await runMixed(t, "revisions", async (thread, env) => {
    const one = await enqueueThreadInput(thread.id, { text: "steer before rebind", source: "worker_assignment", ...steer,
      replyDeliveryIntent: createWorkerReplyDeliveryIntent(await getThread(thread.id, env), { mode: "bound_whatsapp", ownerUserId: "owner" }) }, env);
    await updateThread(thread.id, { binding: { ...binding, chatId: "synthetic-chat-rebound" } }, env);
    const two = await enqueueThreadInput(thread.id, { text: "steer after rebind", source: "worker_assignment", ...steer,
      replyDeliveryIntent: createWorkerReplyDeliveryIntent(await getThread(thread.id, env), { mode: "bound_whatsapp", ownerUserId: "owner" }) }, env);
    return [{ messageId: one.id }, { messageId: two.id }];
  });
  assert.ok(!revisions.prompts.some((prompt) => prompt.includes("before rebind") && prompt.includes("after rebind")));
  for (const result of [owners, revisions]) {
    assert.equal(result.finals.filter((final) => final.parentMessageId === result.first.messageId).length, 1);
    assert.equal(result.finals.filter((final) => final.parentMessageId === result.second.messageId).length, 1);
  }
});

test("MCP text is never a control command, whatever its stored metadata", async () => {
  const { parseThreadInputCommand } = await import("../packages/core/src/thread-commands.js");
  for (const text of ["/now do it", "/stop", "/reset", "/model gpt-x", "/claude"]) {
    assert.equal(parseThreadInputCommand({ source: "thread_bridge_message", text }).command, null, text);
    assert.equal(parseThreadInputCommand({ source: "thread_bridge_message", text, commandProcessing: "" }).command, null, text);
  }
  assert.equal(parseThreadInputCommand({ source: "whatsapp_inbound", text: "/stop" }).command, "stop", "other sources keep their commands");
  const { completeLegacySettingsCommand } = await import("../packages/core/src/codex-settings-command-legacy.js");
  assert.equal(await completeLegacySettingsCommand({ id: "t" }, { id: "m", source: "thread_bridge_message", text: "/model gpt-x" }, {}, async () => { throw new Error("must not run"); }), null);
});

// Records queued before the source rule, whose "/now" was already rewritten
// by normalizeClaudeCodeNowInputs into a forced instant steer.
async function alreadyNormalizedOptOut(thread, env, requestId) {
  const sent = await sendBridgeMessage(thread.id, { text: "synthetic-optout-secret", requestId, deliverToWhatsApp: false }, principal, env, NO_KICK);
  await updateThreadMessage(thread.id, sent.messageId, {
    commandProcessing: "", forceDeliveryAfterInterrupt: true, steerActiveTurn: true, codexDeliveryMode: "instant_steer",
    deliveryState: "interrupt_resume_pending", observedVia: "claude_code_now_command",
  }, env);
  return sent;
}

test("an already-normalized queued MCP input neither interrupts nor steers", async (t) => {
  const result = await runMixed(t, "normalized-alone", async (thread, env) => {
    const b = await alreadyNormalizedOptOut(thread, env, "normalized-alone");
    return [b, b];
  });
  const calls = result.prompts;
  assert.equal(calls[0], "long task first");
  assert.equal(calls[1], "synthetic-optout-secret", "it runs afterwards as its own plain turn, not as an interrupt resume");
  assert.equal(result.messages.find((message) => message.text === "long task first").observedVia === "claude_code_interrupted", false, "the running turn was not interrupted");
  assert.ok(result.posts.every((body) => !body.includes("synthetic-optout-secret")));
});

for (const mcpFirst of [false, true]) {
  test(`an already-normalized opted-out MCP input never joins a WhatsApp steer turn (${mcpFirst ? "MCP first" : "WhatsApp first"})`, async (t) => {
    const result = await runMixed(t, `normalized-${mcpFirst ? "mcp-first" : "wa-first"}`, async (thread, env) => {
      const whatsapp = () => enqueueThreadInput(thread.id, { text: "synthetic-whatsapp-request", source: "whatsapp_inbound", connector: "whatsapp",
        chatId: binding.chatId, accountId: binding.responderAccountId, ...steer }, env);
      if (mcpFirst) {
        const b = await alreadyNormalizedOptOut(thread, env, "normalized-b1");
        const a = await whatsapp();
        return [b, { messageId: a.id }];
      }
      const a = await whatsapp();
      const b = await alreadyNormalizedOptOut(thread, env, "normalized-b2");
      return [{ messageId: a.id }, b];
    });
    assert.ok(!result.prompts.some((prompt) => prompt.includes("synthetic-optout-secret") && prompt.includes("synthetic-whatsapp-request")), "never one shared prompt");
    const optOut = result.messages.find((message) => message.source === "thread_bridge_message");
    assert.equal(optOut.coalescedIntoMessageId || "", "");
    assert.equal(result.finals.filter((final) => final.parentMessageId === optOut.id).length, 1);
    assert.ok(!result.prompts.some((prompt) => prompt.startsWith(CLAUDE_CODE_INTERRUPT_RESUME_NOTE) && prompt.includes("synthetic-optout-secret")), "the MCP input never runs as an interrupt resume");
    assert.ok(result.posts.every((body) => !body.includes("synthetic-optout-secret")), "opted-out content never reaches WhatsApp");
  });
}

test("a legacy queued MCP /stop is literal text, not a stop", async (t) => {
  const result = await runMixed(t, "legacy-stop", async (thread, env) => {
    const sent = await sendBridgeMessage(thread.id, { text: "/stop", requestId: "legacy-stop" }, principal, env, NO_KICK);
    await updateThreadMessage(thread.id, sent.messageId, { commandProcessing: "" }, env);
    return [sent, sent];
  });
  assert.equal(result.messages.find((message) => message.text === "long task first").observedVia === "claude_code_interrupted", false, "the running turn was not stopped");
  assert.ok(result.prompts.includes("/stop"), "delivered to the agent as literal text");
  const stop = result.messages.find((message) => message.source === "thread_bridge_message");
  assert.notEqual(stop.observedVia, "claude_code_control_command");
});

test("a steer input does not interrupt a turn answering an MCP request; it runs next", async (t) => {
  const { env, calls, thread } = await fixture(t, "steer-after-mcp");
  const sent = await sendBridgeMessage(thread.id, { text: "long task synthetic-mcp-request", requestId: "steer-after-mcp", deliverToWhatsApp: false }, principal, env, NO_KICK);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  const ui = await primaries.ui(thread, env);
  await deliverClaudeCodePendingInputs(thread, env);
  await owner;
  for (let round = 0; round < 200; round += 1) {
    const open = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "user" && !["completed", "failed", "cancelled"].includes(message.state));
    if (!open.length && !hasActiveClaudeCodeSupervisor(thread.id)) break;
    if (!hasActiveClaudeCodeSupervisor(thread.id)) await deliverClaudeCodePendingInputs(thread, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const entries = await readCalls(calls);
  assert.ok(!entries.some((entry) => entry.signal), "the MCP turn was not interrupted");
  const prompts = entries.filter((entry) => entry.turn).map((entry) => entry.prompt);
  assert.deepEqual(prompts, ["long task synthetic-mcp-request", "synthetic-ui-request"]);
  const finals = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.equal(finals.filter((final) => final.parentMessageId === sent.messageId).length, 1, "the MCP request has its own answer");
  assert.equal(finals.filter((final) => final.parentMessageId === ui.id).length, 1, "the steer input has its own answer");
});
