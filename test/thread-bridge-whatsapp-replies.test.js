import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { replyToBridgeThread } from "../packages/core/src/thread-bridge.js";
import { sendBridgeMessage } from "../packages/core/src/thread-bridge-messaging.js";
import { threadBridgeToolDefinitions } from "../packages/core/src/thread-bridge-mcp.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { threadBridgeWhatsAppReplyOrigin } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

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

async function fixture(t, { binding = undefined } = {}) {
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
  await createThread({ id: "thread-a", ownerUserId: "owner-a", name: "Synthetic thread", ...(binding ? { binding } : {}) }, env);
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
  assert.equal(threadBridgeWhatsAppReplyOrigin({ parent: input, thread: { id: "thread-a", binding: eligibleBinding }, kind: "thread" }), false);

  const definition = threadBridgeToolDefinitions().find((tool) => tool.name === "send_message");
  assert.equal(definition.inputSchema.properties.deliver_to_whatsapp.type, "boolean");
  assert.equal("chat_id" in definition.inputSchema.properties, false);
  assert.equal("recipient" in definition.inputSchema.properties, false);
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
