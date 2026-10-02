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
import { createThread, enqueueThreadInput, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
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
    // Inputs stored before commandProcessing was set: /now is still parsed and
    // they become steer inputs, so only the authority fence keeps them apart.
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
