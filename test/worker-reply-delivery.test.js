import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, appendThreadMessage, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { createWorkerReplyDeliveryIntent, replyDeliveryProjectionParent } from "../packages/core/src/reply-delivery-intent.js";
import { createClaudeCodeProgressReporter } from "../packages/core/src/claude-code-progress.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { assertLiveReplyDeliveryBinding } from "../packages/core/src/reply-delivery-live-fence.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-worker-delivery-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_DEBUG_FOOTER: "0" };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://fixture.invalid" }, env);
  const thread = await createThread({ id: "worker", name: "Worker", ownerUserId: "admin", binding: {
    connector: "whatsapp", chatId: "worker-chat", responderAccountId: "account-a", enabled: true, mirrorToWhatsApp: true,
  } }, env);
  const parent = await appendThreadMessage(thread.id, {
    role: "user", text: "Implement a task", state: "completed", source: "worker_assignment",
    originSurface: "orkestr-worker", originTransport: "authenticated-http",
    replyDeliveryIntent: createWorkerReplyDeliveryIntent(thread, { mode: "bound_whatsapp" }),
  }, env);
  const progress = createClaudeCodeProgressReporter({ thread, parentMessage: parent, attemptId: "attempt-a" }, env);
  await progress.start();
  const sends = [];
  const fetchImpl = async (_url, options) => {
    sends.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, ids: [`wa-${sends.length}`] }) };
  };
  const final = async () => {
    const route = replyDeliveryProjectionParent(parent);
    return appendThreadMessage(thread.id, {
      role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Task completed.",
      parentMessageId: parent.id, connector: route.connector, chatId: route.chatId, accountId: route.accountId,
    }, env);
  };
  return { env, thread, parent, sends, fetchImpl, final };
}

test("delegated progress and final reach the worker group once, including repeated delivery passes", async t => {
  const f = await fixture(t);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.equal(f.sends.length, 1);
  assert.equal((await listThreadMessages(f.thread.id, f.env)).find(m => m.id === f.parent.id).replyDeliveryIntent.status, "pending_reply");
  await f.final();
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.deepEqual(f.sends.map(m => m.text), ["Claude Code started working on your request.", "Task completed."]);
  assert.equal((await listThreadMessages(f.thread.id, f.env)).find(m => m.id === f.parent.id).replyDeliveryIntent.status, "delivered");
});

for (const [name, patch] of [
  ["rebound chat", { binding: { connector: "whatsapp", chatId: "other-chat", responderAccountId: "account-a" } }],
  ["changed account", { binding: { connector: "whatsapp", chatId: "worker-chat", responderAccountId: "other-account" } }],
  ["disabled mirroring", { binding: { connector: "whatsapp", chatId: "worker-chat", responderAccountId: "account-a", mirrorToWhatsApp: false } }],
  ["changed owner", { ownerUserId: "other-owner" }],
]) {
  test(`delegated progress and final fail closed after ${name}`, async t => {
    const f = await fixture(t);
    await f.final();
    await updateThread(f.thread.id, patch, f.env);
    await deliverWhatsAppReplies(f.env, f.fetchImpl);
    await deliverWhatsAppReplies(f.env, f.fetchImpl);
    assert.equal(f.sends.length, 0);
  });
}

test("disable/re-enable and rebind-back cannot revive old worker reply authority", async t => {
  const f = await fixture(t);
  await f.final();
  const args = { parent: f.parent, threadId: f.thread.id, chatId: "worker-chat", accountId: "account-a" };
  await assertLiveReplyDeliveryBinding(args, f.env);
  await updateThread(f.thread.id, { binding: { enabled: false } }, f.env);
  await updateThread(f.thread.id, { binding: { enabled: true }, replyDeliveryEpoch: "" }, f.env);
  await assert.rejects(assertLiveReplyDeliveryBinding(args, f.env), e => e.retryable === false && /binding_generation_changed/.test(e.message));
  await updateThread(f.thread.id, { binding: { chatId: "other-chat" } }, f.env);
  await updateThread(f.thread.id, { binding: { chatId: "worker-chat" } }, f.env);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.equal(f.sends.length, 0);
});

test("late worker progress after its final is delivered never sends", async t => {
  const f = await fixture(t);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  await f.final();
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  const reporter = createClaudeCodeProgressReporter({ thread: f.thread, parentMessage: f.parent, attemptId: "late-attempt" }, f.env);
  await reporter.start();
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.equal(f.sends.length, 2);
});

test("retryable transport outage keeps one durable worker final and recovers without duplicates", async t => {
  const f = await fixture(t);
  f.env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS = "0";
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  await f.final();
  await deliverWhatsAppReplies(f.env, async () => ({ ok: false, status: 503, json: async () => ({ error: "bridge_unavailable" }) }));
  assert.equal((await listThreadMessages(f.thread.id, f.env)).find(m => m.id === f.parent.id).replyDeliveryIntent.status, "queued");
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.equal(f.sends.length, 2);
  assert.equal((await listThreadMessages(f.thread.id, f.env)).find(m => m.id === f.parent.id).replyDeliveryIntent.status, "delivered");
});
