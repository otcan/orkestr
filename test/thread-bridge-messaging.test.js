import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { listBridgeThreads, readBridgeChanges, readBridgeHistory } from "../packages/core/src/thread-bridge.js";
import { bridgeThreadStatus, sendBridgeMessage, waitForBridgeReply } from "../packages/core/src/thread-bridge-messaging.js";
import { callThreadBridgeTool } from "../packages/core/src/thread-bridge-mcp.js";
import { runMcpEventDelivery } from "../packages/core/src/mcp-event-delivery.js";
import { subscribeEvent } from "../packages/core/src/mcp-events.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  scopes: ["threads:read", "threads:comment", "threads:message"] };
const NO_DELIVERY = { deliver: () => {} };
const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth", enabled: true,
  expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all" };

async function fixture(t, grantOverride = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bridge-messaging-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1", ORKESTR_AUTO_RUN_THREAD_INPUT: "0" };
  await fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify([{ ...grant, ...grantOverride }]));
  await createUser({ id: "owner-a" }, env);
  await createThread({ id: "thread-a", ownerUserId: "owner-a", name: "Sales", binding: { connector: "whatsapp", chatId: "1203@g.us" } }, env);
  t.after(async () => { await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return env;
}

test("messaging needs the message grant scope and the token scope", async (t) => {
  const env = await fixture(t, { message: undefined });
  await assert.rejects(sendBridgeMessage("thread-a", { text: "Do it", requestId: "r1" }, principal, env), /bridge_thread_not_found/);
  const env2 = await fixture(t);
  const noScope = await callThreadBridgeTool("send_message", { thread_id: "thread-a", text: "Do it" }, { ...principal, scopes: ["threads:read", "threads:comment"] }, env2);
  assert.equal(noScope.isError, true);
  assert.match(noScope.content[0].text, /insufficient_scope/);
});

test("a sent message is queued as labelled, internal input and is idempotent", async (t) => {
  const env = await fixture(t);
  const { checkpoint } = await listBridgeThreads(principal, env);
  const sent = await sendBridgeMessage("thread-a", { text: "Prepare the offer", requestId: "req-1" }, principal, env, NO_DELIVERY);
  const again = await sendBridgeMessage("thread-a", { text: "Prepare the offer", requestId: "req-1" }, principal, env, NO_DELIVERY);
  assert.equal(again.messageId, sent.messageId);
  assert.equal(again.duplicate, true);
  const inputs = (await listThreadMessages("thread-a", env)).filter((message) => message.role === "user");
  assert.equal(inputs.length, 1);
  const [input] = inputs;
  assert.equal(input.source, "thread_bridge_message");
  assert.equal(input.state, "queued");
  assert.notEqual(input.visibility, "internal", "the owner sees the request in the thread");
  assert.equal(input.chatId || "", "", "the answer is not routed to WhatsApp");
  assert.equal(input.bridgeAgentId, "agent-a");
  // Internal input is not part of the visible history; status shows it queued.
  assert.equal((await bridgeThreadStatus("thread-a", principal, env)).state, "queued");
  await updateThreadMessage("thread-a", input.id, { state: "running" }, env);
  assert.equal((await bridgeThreadStatus("thread-a", principal, env)).state, "working");
  await updateThreadMessage("thread-a", input.id, { state: "completed" }, env);
  const answer = await appendThreadMessage("thread-a", { role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Offer prepared.", parentMessageId: input.id }, env);
  const status = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(status.state, "idle");
  assert.equal(status.lastAnswer.messageId, answer.id);
  const waited = await waitForBridgeReply("thread-a", sent.messageId, principal, { timeoutSeconds: 1 }, env);
  assert.equal(waited.status, "answered");
  assert.equal(waited.reply.text, "Offer prepared.");
  const changes = await readBridgeChanges(principal, { cursor: checkpoint }, env);
  assert.deepEqual(changes.events.map((event) => event.messageId), [answer.id], "own message is not echoed, the answer is");
});

test("wait_for_reply reports failures and keeps waiting bounded", async (t) => {
  const env = await fixture(t);
  const sent = await sendBridgeMessage("thread-a", { text: "Slow task", requestId: "slow" }, principal, env, NO_DELIVERY);
  const pending = await waitForBridgeReply("thread-a", sent.messageId, principal, { timeoutSeconds: 1, pollMs: 100 }, env);
  assert.equal(pending.status, "still_working");
  await updateThreadMessage("thread-a", sent.messageId, { state: "failed", error: "Selected model is at capacity" }, env);
  const failed = await waitForBridgeReply("thread-a", sent.messageId, principal, { timeoutSeconds: 1 }, env);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /capacity/);
  const other = await appendThreadMessage("thread-a", { role: "user", source: "ui", text: "Owner input", state: "completed" }, env);
  await assert.rejects(waitForBridgeReply("thread-a", other.id, principal, { timeoutSeconds: 1 }, env), /bridge_message_not_found/);
});

test("the delegated message shows as the assistant's in history and is not delivered back as an event", async (t) => {
  const env = await fixture(t);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const json = JSON.parse(options.body);
    calls.push(json);
    return json.type === "verification" ? { status: 200, text: JSON.stringify({ challenge: json.challenge }) } : { status: 200, text: "" };
  };
  await subscribeEvent({ name: "thread.message.created", arguments: { actors: ["assistant", "automation", "human"] },
    delivery: { mode: "webhook", url: "https://receiver.example.com/cb", secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}` } }, principal, { env, fetchImpl });
  const sent = await sendBridgeMessage("thread-a", { text: "Visible request", requestId: "vis" }, principal, env, NO_DELIVERY);
  await updateThreadMessage("thread-a", sent.messageId, { state: "completed" }, env);
  await appendThreadMessage("thread-a", { role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Done.", parentMessageId: sent.messageId }, env);
  await runMcpEventDelivery(env, { fetchImpl });
  assert.deepEqual(calls.filter((entry) => entry.data).map((entry) => entry.data.text), ["Done."]);
  const history = await readBridgeHistory("thread-a", principal, {}, env);
  const request = history.messages.find((message) => message.text === "Visible request");
  assert.deepEqual(request.actor, { kind: "delegated-agent", agentId: "agent-a" });
});

test("sending is rate-limited per assistant", async (t) => {
  const env = await fixture(t);
  const limited = { ...principal, agentId: "agent-rate" };
  await fs.writeFile(path.join(env.ORKESTR_HOME, "thread-bridge-grants.json"), JSON.stringify([{ ...grant, agentId: "agent-rate" }]));
  for (let index = 0; index < 30; index += 1) await sendBridgeMessage("thread-a", { text: `m${index}`, requestId: `rate-${index}` }, limited, env, NO_DELIVERY);
  await assert.rejects(sendBridgeMessage("thread-a", { text: "one more", requestId: "rate-31" }, limited, env), /bridge_message_rate_limited/);
});
