import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { outboundIntentKey, outboundMirrorMessageSetKey } from "../packages/connectors/src/whatsapp-outbound-intents.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_WHATSAPP_PROGRESS_BACKFILL_WINDOW_MS: "1000",
    ORKESTR_WHATSAPP_REPLY_BACKFILL_WINDOW_MS: "1000",
    ORKESTR_WHATSAPP_LIVE_OUTPUT_RECOVERY_WINDOW_MS: String(60 * 60 * 1000),
    ...extra,
  };
}

async function createBoundThread(home, threadId) {
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: threadId,
    name: threadId,
    binding: {
      connector: "whatsapp",
      chatId: "chat-live-recovery",
      responderAccountId: "account-live-recovery",
      outboundAccountId: "account-live-recovery",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  return runtimeEnv;
}

async function writeCursorPast(home, threadId, cursor, extraState = {}) {
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [],
    outboundIntents: [],
    inboundEvents: [],
    ...extraState,
    outboundMirrorCursors: [{
      messageSetKey: outboundMirrorMessageSetKey({ kind: "thread", threadId }),
      kind: "thread",
      agentId: null,
      threadId,
      cursor,
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2));
}

test("whatsapp delivery recovers missed live app-server final output after the mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-live-recovery-"));
  const runtimeEnv = await createBoundThread(home, "thread-live-recovery");
  const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-live-recovery", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "please keep me posted",
    createdAt: oldAt,
  }, runtimeEnv);
  const progress = await appendThreadMessage("thread-live-recovery", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Checking the routing path.",
    createdAt: oldAt,
  }, runtimeEnv);
  const final = await appendThreadMessage("thread-live-recovery", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Routing is fixed.",
    createdAt: oldAt,
  }, runtimeEnv);
  await writeCursorPast(home, "thread-live-recovery", Number(final.cursor) + 1);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-${calls.length}`] });
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const reasons = state.outboundIntents
    .filter((intent) => [progress.id, final.id].includes(intent.messageId))
    .map((intent) => intent.createdReason);

  assert.equal(delivery.delivered.length, 1);
  assert.deepEqual(delivery.delivered.map((item) => item.deliveryType), ["final"]);
  assert.deepEqual(calls.map((call) => call.body.to), ["chat-live-recovery"]);
  assert.deepEqual(calls.map((call) => call.body.accountId), ["account-live-recovery"]);
  assert.deepEqual(calls.map((call) => call.body.text), ["Routing is fixed."]);
  assert.deepEqual(reasons, ["live_bound_recovery"]);
});

test("whatsapp delivery does not recover stale live progress outside the default recovery window", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-live-recovery-"));
  const runtimeEnv = await createBoundThread(home, "thread-stale-live-recovery");
  delete runtimeEnv.ORKESTR_WHATSAPP_LIVE_OUTPUT_RECOVERY_WINDOW_MS;
  const oldAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-stale-live-recovery", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "old routed request",
    createdAt: oldAt,
  }, runtimeEnv);
  const progress = await appendThreadMessage("thread-stale-live-recovery", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Old progress should not replay after restart.",
    createdAt: oldAt,
  }, runtimeEnv);
  await writeCursorPast(home, "thread-stale-live-recovery", Number(progress.cursor) + 1);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("stale live progress should not be recovered");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));

  assert.equal(delivery.delivered.length, 0);
  assert.equal((state.outboundIntents || []).some((intent) => intent.messageId === progress.id), false);
  assert.equal(delivery.skipped.find((item) => item.messageId === progress.id), undefined);
  assert.equal(delivery.skippedSummary.count, 0);
});

test("whatsapp delivery does not recover imported transcript output after the mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-import-recovery-"));
  const runtimeEnv = await createBoundThread(home, "thread-import-recovery");
  const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-import-recovery", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "historical request",
    createdAt: oldAt,
  }, runtimeEnv);
  const progress = await appendThreadMessage("thread-import-recovery", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "commentary",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Imported progress should stay inert.",
    createdAt: oldAt,
  }, runtimeEnv);
  const final = await appendThreadMessage("thread-import-recovery", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "final_answer",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Imported final should stay inert.",
    createdAt: oldAt,
  }, runtimeEnv);
  await writeCursorPast(home, "thread-import-recovery", Number(final.cursor) + 1);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("imported transcript output should not be recovered");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));

  assert.equal(delivery.delivered.length, 0);
  assert.equal((state.outboundIntents || []).some((intent) => [progress.id, final.id].includes(intent.messageId)), false);
  assert.deepEqual(
    [progress.id, final.id].map((id) => delivery.skipped.find((item) => item.messageId === id)?.reason),
    [undefined, undefined],
  );
  assert.equal(delivery.skippedSummary.count, 0);
});

test("whatsapp delivery recovers history-synced app-server finals after the mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-history-sync-recovery-"));
  const runtimeEnv = await createBoundThread(home, "thread-history-sync-recovery");
  const oldAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-history-sync-recovery", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "historical request with recovered final",
    createdAt: oldAt,
  }, runtimeEnv);
  const final = await appendThreadMessage("thread-history-sync-recovery", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "final_answer",
    observedVia: "codex_app_server_history_sync",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Recovered imported final should send.",
    createdAt: oldAt,
  }, runtimeEnv);
  await writeCursorPast(home, "thread-history-sync-recovery", Number(final.cursor) + 1);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-${calls.length}`] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.deepEqual(delivery.delivered.map((item) => item.deliveryType), ["final"]);
  assert.deepEqual(calls.map((call) => call.body.text), ["Recovered imported final should send."]);
});

test("whatsapp delivery ignores old terminal skipped intents after the mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-old-terminal-intent-"));
  const runtimeEnv = await createBoundThread(home, "thread-old-terminal-intent");
  const oldAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-old-terminal-intent", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "historical request with terminal skip",
    createdAt: oldAt,
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-old-terminal-intent", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "final_answer",
    state: "completed",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    parentMessageId: parent.id,
    text: "Historical answer had already been quarantined.",
    createdAt: oldAt,
  }, runtimeEnv);
  const intent = {
    status: "skipped",
    kind: "thread",
    deliveryType: "final",
    threadId: "thread-old-terminal-intent",
    messageSetKey: outboundMirrorMessageSetKey({ kind: "thread", threadId: "thread-old-terminal-intent" }),
    messageCursor: Number(reply.cursor),
    messageId: reply.id,
    parentMessageId: parent.id,
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    error: "quarantined_stale_pending_progress",
    createdAt: oldAt,
    updatedAt: oldAt,
    skippedAt: oldAt,
    lastChangedAt: oldAt,
  };
  intent.intentId = outboundIntentKey(intent);
  await writeCursorPast(home, "thread-old-terminal-intent", Number(reply.cursor) + 1, {
    outboundIntents: [intent],
  });

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("old terminal skipped intent should not be retried or reported");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.skippedSummary.count, 0);
  assert.deepEqual(delivery.skipped, []);
});

test("whatsapp delivery ignores old router update notices after the mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-old-router-update-"));
  const runtimeEnv = await createBoundThread(home, "thread-old-router-update");
  const oldAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const message = await appendThreadMessage("thread-old-router-update", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    accountId: "account-live-recovery",
    text: "/safe-reset",
    observedVia: "orkestr_safe_reset_command",
    createdAt: oldAt,
  }, runtimeEnv);
  await writeCursorPast(home, "thread-old-router-update", Number(message.cursor) + 1);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("old router update notice should not be sent or reported");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.skippedSummary.count, 0);
  assert.deepEqual(delivery.skipped, []);
});

test("whatsapp delivery summarizes repeated stale skipped replies with a bounded sample", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-skip-summary-"));
  const runtimeEnv = await createBoundThread(home, "thread-stale-skip-summary");
  runtimeEnv.ORKESTR_WHATSAPP_DELIVERY_SKIPPED_SAMPLE_LIMIT = "2";
  delete runtimeEnv.ORKESTR_WHATSAPP_LIVE_OUTPUT_RECOVERY_WINDOW_MS;
  const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const replies = [];

  for (let index = 0; index < 5; index += 1) {
    const parent = await appendThreadMessage("thread-stale-skip-summary", {
      role: "user",
      source: "whatsapp_inbound",
      state: "completed",
      connector: "whatsapp",
      chatId: "chat-live-recovery",
      accountId: "account-live-recovery",
      text: `historical request ${index}`,
      createdAt: oldAt,
    }, runtimeEnv);
    replies.push(await appendThreadMessage("thread-stale-skip-summary", {
      role: "assistant",
      source: "codex-app-server-import",
      phase: "final_answer",
      state: "completed",
      chatId: "chat-live-recovery",
      accountId: "account-live-recovery",
      parentMessageId: parent.id,
      text: `Historical answer ${index} should stay inert.`,
      createdAt: oldAt,
    }, runtimeEnv));
  }
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("stale transcript output should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.skipped.filter((item) => item.reason === "stale_untracked_reply").length, 2);
  assert.deepEqual(
    delivery.skipped.map((item) => item.messageId),
    replies.slice(0, 2).map((reply) => reply.id),
  );
  assert.equal(delivery.skippedSummary.count, 5);
  assert.equal(delivery.skippedSummary.sampled, 2);
  assert.equal(delivery.skippedSummary.omitted, 3);
  assert.deepEqual(delivery.skippedSummary.reasons, { stale_untracked_reply: 5 });

  const second = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("already-cursored stale transcript output should not be sent");
  });
  assert.equal(second.delivered.length, 0);
  assert.equal(second.skippedSummary.count, 0);
  assert.deepEqual(second.skipped, []);
});
