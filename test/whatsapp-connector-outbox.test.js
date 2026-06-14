import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, deleteThreadMessage, updateThreadMessage } from "../packages/core/src/threads.js";
import { applyConnectorOutboxJobAction, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { applyWhatsAppConnectorOutboxAction, deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { readJson, writeJson } from "../packages/storage/src/store.js";

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
    ...extra,
  };
}

test("whatsapp delivery terminalizes a tenant-scoped connector outbox job", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "All routed messages are accounted for.",
  }, runtimeEnv);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-1"] }));
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(job?.state, "delivered");
  assert.equal(job.tenantId, "tenant-a");
  assert.equal(job.connector, "whatsapp");
  assert.equal(job.accountId, "responder");
  assert.equal(job.chatId, "shared-chat");
  assert.equal(job.threadId, "thread-wa-outbox");
  assert.equal(job.deliveryType, "final");
  assert.equal(job.payload.text, "All routed messages are accounted for.");
  assert.equal(job.brokerAck.ids[0], "wa-sent-1");
});

test("whatsapp connector outbox backs off retryable bridge failures", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-backoff-"));
  const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "60000" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-backoff",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Backoff Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-backoff", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-backoff", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Retry later.",
  }, runtimeEnv);

  const calls = [];
  const first = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    throw new Error("whatsapp_local_bridge_not_ready");
  });
  const outboxAfterFailure = await readConnectorOutbox(runtimeEnv);
  const failedJob = outboxAfterFailure.jobs.find((item) => item.sourceMessageId === reply.id);

  assert.equal(first.failed.length, 1);
  assert.equal(calls.filter((item) => item === "/send-text").length, 1);
  assert.equal(failedJob.state, "failed_retryable");
  assert.equal(failedJob.claimedBy, "retry_backoff");
  assert.ok(Date.parse(failedJob.claimExpiresAt) > Date.now());
  assert.equal(failedJob.metadata.retryAfterAt, failedJob.claimExpiresAt);

  const second = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    throw new Error("retry backoff should prevent immediate bridge send");
  });

  assert.equal(calls.filter((item) => item === "/send-text").length, 1);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.find((item) => item.messageId === reply.id)?.reason, "connector_outbox_retry_scheduled");

  await applyConnectorOutboxJobAction(failedJob.id, "retry", { reason: "operator retry", operator: "tester" }, runtimeEnv);
  const retry = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    return response({ ok: true, ids: ["wa-sent-after-backoff"] });
  });

  assert.equal(calls.filter((item) => item === "/send-text").length, 2);
  assert.equal(retry.delivered.length, 1);
});

test("whatsapp connector outbox does not mirror watcher alerts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-watcher-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-watcher",
    ownerUserId: "tenant-a",
    name: "WA Watcher Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  await appendThreadMessage("thread-wa-outbox-watcher", {
    role: "assistant",
    source: "watcher-alert",
    state: "completed",
    chatId: "shared-chat",
    accountId: "responder",
    text: "[watcher:error] router.mirror_failed\ncode: router_trace_failure",
  }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(outbox.jobs.length, 0);
});

test("whatsapp connector outbox replay resets intent and delivered ledger", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-replay-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-replay",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Replay Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-replay", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "again?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-replay", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Replayable answer.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-1"] }));
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id);
  assert.equal(job?.state, "delivered");

  const replay = await applyConnectorOutboxJobAction(job.id, "replay", { reason: "operator replay", operator: "tester" }, runtimeEnv);
  const whatsapp = await applyWhatsAppConnectorOutboxAction(replay.job, "replay", { reason: "operator replay" }, runtimeEnv);
  assert.equal(replay.job.state, "pending");
  assert.equal(whatsapp.matchedIntents, 1);
  assert.equal(whatsapp.removedDeliveries, 1);

  const calls = [];
  const second = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["wa-sent-2"] });
  });
  const refreshed = await readConnectorOutbox(runtimeEnv);
  const replayedJob = refreshed.jobs.find((item) => item.id === job.id);

  assert.equal(second.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, "Replayable answer.");
  assert.equal(replayedJob.state, "delivered");
  assert.equal(replayedJob.brokerAck.ids[0], "wa-sent-2");
});

test("whatsapp connector outbox retry reconciles already-delivered ledger without resending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-reconcile-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-reconcile",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Reconcile Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-reconcile", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-reconcile", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Already sent answer.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-1"] }));
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id);
  assert.equal(job?.state, "delivered");

  const retry = await applyConnectorOutboxJobAction(job.id, "retry", { reason: "operator retry", operator: "tester" }, runtimeEnv);
  assert.equal(retry.job.state, "pending");

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected-resend"] });
  });
  const refreshed = await readConnectorOutbox(runtimeEnv);
  const reconciledJob = refreshed.jobs.find((item) => item.id === job.id);

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(reconciledJob.state, "delivered");
  assert.equal(reconciledJob.brokerAck.ids[0], "wa-sent-1");
});

test("whatsapp mirrors edited assistant replies as revisioned correction notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-edit-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-edit",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Edit Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-edit", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-edit", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Original answer.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-original"] }));
  await updateThreadMessage("thread-wa-outbox-edit", reply.id, { text: "Corrected answer." }, runtimeEnv);

  const calls = [];
  const correction = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["wa-sent-correction"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id && item.deliveryType === "edit_notice");

  assert.equal(correction.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /^Correction to my previous message:/);
  assert.match(calls[0].body.text, /Corrected answer\./);
  assert.equal(job?.state, "delivered");
  assert.equal(job.sourceRevision, "2");
  assert.equal(job.payload.text, calls[0].body.text);
  assert.equal(job.brokerAck.ids[0], "wa-sent-correction");
});

test("whatsapp suppresses edit notices for attachment-only assistant updates", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-attachment-edit-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-attachment-edit",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Attachment Edit Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-attachment-edit", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-attachment-edit", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Same visible answer.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-original"] }));
  await updateThreadMessage("thread-wa-outbox-attachment-edit", reply.id, {
    attachments: [{
      name: "summary.csv",
      path: "/tmp/summary.csv",
      size: 32,
    }],
  }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected-correction"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);

  assert.equal(delivery.delivered.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(outbox.jobs.some((item) => item.sourceMessageId === reply.id && item.deliveryType === "edit_notice"), false);
});

test("whatsapp does not backfill edit notices for legacy deliveries without source revisions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-legacy-edit-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-legacy-edit",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Legacy Edit Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-legacy-edit", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-legacy-edit", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Original answer.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-original"] }));
  const statePath = dataPaths(runtimeEnv).whatsapp;
  const state = await readJson(statePath, {});
  state.outboundDeliveries = (state.outboundDeliveries || []).map((delivery) => {
    if (delivery.messageId !== reply.id) return delivery;
    const legacy = { ...delivery };
    delete legacy.sourceRevision;
    return legacy;
  });
  await writeJson(statePath, state);
  await updateThreadMessage("thread-wa-outbox-legacy-edit", reply.id, { text: "Corrected answer." }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected-correction"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);

  assert.equal(delivery.delivered.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(outbox.jobs.some((item) => item.sourceMessageId === reply.id && item.deliveryType === "edit_notice"), false);
});

test("whatsapp mirrors deleted assistant replies as tombstone notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-delete-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-delete",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Delete Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-delete", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-delete", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Answer to delete.",
  }, runtimeEnv);

  await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-original"] }));
  await deleteThreadMessage("thread-wa-outbox-delete", reply.id, { deletedBy: "tester", reason: "wrong chat" }, runtimeEnv);

  const calls = [];
  const tombstone = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["wa-sent-tombstone"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id && item.deliveryType === "delete_notice");

  assert.equal(tombstone.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /previous Orkestr message was deleted/);
  assert.match(calls[0].body.text, /Reason: wrong chat/);
  assert.equal(job?.state, "delivered");
  assert.equal(job.sourceRevision, "2");
  assert.equal(job.payload.text, calls[0].body.text);
});

test("whatsapp records unsupported delete mutation when original was never delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-delete-unsupported-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-delete-unsupported",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Delete Unsupported Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-delete-unsupported", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-delete-unsupported", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Never sent.",
  }, runtimeEnv);
  await deleteThreadMessage("thread-wa-outbox-delete-unsupported", reply.id, { deletedBy: "tester" }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected"] });
  });
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id && item.deliveryType === "delete_notice");

  assert.equal(delivery.delivered.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(job?.state, "skipped");
  assert.equal(job.error, "unsupported_connector_action_original_not_delivered");
  assert.equal(job.metadata.unsupportedConnectorAction, true);
});
