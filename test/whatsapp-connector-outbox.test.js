import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, deleteThreadMessage, updateThreadMessage } from "../packages/core/src/threads.js";
import { applyConnectorOutboxJobAction, ensureConnectorOutboxJob, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { applyWhatsAppConnectorOutboxAction, deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { retryRecoverableWhatsAppOutboxJobsForAccounts } from "../packages/connectors/src/whatsapp-outbox-recovery.js";
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

test("whatsapp connector outbox auto-retries recoverable bridge failures after account recovery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-auto-retry-"));
  const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "60000" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-auto-retry",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Auto Retry Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-auto-retry", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-auto-retry", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Recovered automatically.",
  }, runtimeEnv);

  const calls = [];
  const failed = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    throw new Error("whatsapp_local_bridge_not_ready");
  });
  const outboxAfterFailure = await readConnectorOutbox(runtimeEnv);
  const failedJob = outboxAfterFailure.jobs.find((item) => item.sourceMessageId === reply.id);

  assert.equal(failed.failed.length, 1);
  assert.equal(failedJob?.state, "failed_retryable");
  assert.equal(failedJob.claimedBy, "retry_backoff");

  const autoRetry = await retryRecoverableWhatsAppOutboxJobsForAccounts({
    accountIds: ["responder"],
    reason: "test_account_recovered",
  }, runtimeEnv);
  const outboxAfterRecovery = await readConnectorOutbox(runtimeEnv);
  const retriedJob = outboxAfterRecovery.jobs.find((item) => item.id === failedJob.id);

  assert.equal(autoRetry.retried.length, 1);
  assert.equal(retriedJob.state, "pending");
  assert.equal(retriedJob.claimedBy, "");
  assert.equal(retriedJob.claimExpiresAt, "");

  const delivered = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    return response({ ok: true, ids: ["wa-sent-after-auto-retry"] });
  });

  assert.equal(calls.filter((item) => item === "/send-text").length, 2);
  assert.equal(delivered.delivered.length, 1);
  const outboxAfterDelivery = await readConnectorOutbox(runtimeEnv);
  assert.equal(outboxAfterDelivery.jobs.find((item) => item.id === failedJob.id)?.state, "delivered");
});

test("whatsapp connector outbox quarantines uncertain sends instead of retrying", async () => {
  const cases = [
    { name: "unconfirmed", error: "whatsapp_send_not_confirmed" },
    { name: "send-recovery", error: "whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error" },
  ];
  for (const item of cases) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-wa-connector-outbox-${item.name}-`));
    const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" });
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
    const threadId = `thread-wa-outbox-${item.name}`;
    await createThread({
      id: threadId,
      ownerUserId: "tenant-a",
      name: `WA Connector Outbox ${item.name} Thread`,
      binding: {
        connector: "whatsapp",
        chatId: "shared-chat",
        responderAccountId: "responder",
        outboundAccountId: "responder",
        mirrorToWhatsApp: true,
      },
    }, runtimeEnv);
    const parent = await appendThreadMessage(threadId, {
      role: "user",
      source: "whatsapp_inbound",
      state: "completed",
      connector: "whatsapp",
      chatId: "shared-chat",
      accountId: "responder",
      text: "status?",
    }, runtimeEnv);
    const outboundText = `Maybe sent once ${item.name}.`;
    const reply = await appendThreadMessage(threadId, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      state: "completed",
      parentMessageId: parent.id,
      chatId: "shared-chat",
      accountId: "responder",
      text: outboundText,
    }, runtimeEnv);

    const sentTexts = [];
    const failed = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      sentTexts.push(body.text || "");
      if (body.text === outboundText) throw new Error(item.error);
      return response({ ok: true, ids: [`wa-sent-${sentTexts.length}`] });
    });
    const outboxAfterFailure = await readConnectorOutbox(runtimeEnv);
    const uncertainJob = outboxAfterFailure.jobs.find((job) => job.sourceMessageId === reply.id);
    const stateAfterFailure = await readJson(dataPaths(runtimeEnv).whatsapp, { outboundIntents: [] });
    const intent = (stateAfterFailure.outboundIntents || []).find((entry) => entry.messageId === reply.id);

    assert.equal(failed.failed.length, 1);
    assert.equal(sentTexts.filter((text) => text === outboundText).length, 1);
    assert.equal(uncertainJob?.state, "delivery_uncertain");
    assert.equal(uncertainJob.claimedBy, "");
    assert.equal(uncertainJob.claimExpiresAt, "");
    assert.equal(uncertainJob.terminalAt.length > 0, true);
    assert.equal(uncertainJob.metadata.deliveryUncertain, true);
    assert.equal(uncertainJob.metadata.retrySuppressed, true);
    assert.equal(intent?.status, "skipped");
    assert.equal(intent?.error, item.error);

    const second = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      sentTexts.push(body.text || "");
      if (body.text === outboundText) throw new Error(`${item.name} send must not be replayed`);
      return response({ ok: true, ids: [`wa-sent-${sentTexts.length}`] });
    });

    assert.equal(sentTexts.filter((text) => text === outboundText).length, 1);
    assert.equal(second.failed.length, 0);
    assert.ok(second.skipped.some((entry) =>
      entry.messageId === reply.id &&
      [item.error, "connector_outbox_delivery_uncertain"].includes(entry.reason)
    ));
  }
});

test("whatsapp connector outbox suppresses later progress for an uncertain turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-progress-turn-"));
  const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-progress-turn",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Progress Turn Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-progress-turn", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const firstProgress = await appendThreadMessage("thread-wa-outbox-progress-turn", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Still working.",
  }, runtimeEnv);

  const sentTexts = [];
  const failed = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    sentTexts.push(body.text || "");
    throw new Error("whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error");
  });
  const outboxAfterFailure = await readConnectorOutbox(runtimeEnv);
  const firstJob = outboxAfterFailure.jobs.find((job) => job.sourceMessageId === firstProgress.id);

  assert.equal(failed.failed.length, 1);
  assert.equal(sentTexts.includes("Still working."), true);
  assert.equal(firstJob?.state, "delivery_uncertain");
  assert.equal(firstJob.metadata.parentMessageId, parent.id);

  const secondProgress = await appendThreadMessage("thread-wa-outbox-progress-turn", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Still working, more context.",
  }, runtimeEnv);
  const second = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    sentTexts.push(body.text || "");
    throw new Error("later same-turn progress must not be sent");
  });
  const outboxAfterSecond = await readConnectorOutbox(runtimeEnv);
  const secondJob = outboxAfterSecond.jobs.find((job) => job.sourceMessageId === secondProgress.id);

  assert.equal(sentTexts.includes("Still working, more context."), false);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.find((entry) => entry.messageId === secondProgress.id)?.reason, "connector_outbox_delivery_uncertain");
  assert.equal(secondJob?.state, "delivery_uncertain");
  assert.equal(secondJob.metadata.priorDeliveryUncertainJobId, firstJob.id);
});

test("whatsapp connector outbox suppresses repeated progress body after an uncertain send", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-progress-body-"));
  const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-progress-body",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Progress Body Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const firstParent = await appendThreadMessage("thread-wa-outbox-progress-body", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const firstProgress = await appendThreadMessage("thread-wa-outbox-progress-body", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    parentMessageId: firstParent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Still checking the WA runtime.",
  }, runtimeEnv);

  const sentTexts = [];
  const first = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    sentTexts.push(body.text || "");
    throw new Error("whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error");
  });
  const outboxAfterFirst = await readConnectorOutbox(runtimeEnv);
  const firstJob = outboxAfterFirst.jobs.find((job) => job.sourceMessageId === firstProgress.id);

  assert.equal(first.failed.length, 1);
  assert.equal(sentTexts.filter((text) => text === "Still checking the WA runtime.").length, 1);
  assert.equal(firstJob?.state, "delivery_uncertain");

  const secondParent = await appendThreadMessage("thread-wa-outbox-progress-body", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status again?",
  }, runtimeEnv);
  const secondProgress = await appendThreadMessage("thread-wa-outbox-progress-body", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    parentMessageId: secondParent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Still checking the WA runtime.",
  }, runtimeEnv);

  const second = await deliverWhatsAppReplies(runtimeEnv, async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    sentTexts.push(body.text || "");
    throw new Error("same body after uncertain send must not be sent again");
  });
  const outboxAfterSecond = await readConnectorOutbox(runtimeEnv);

  assert.equal(sentTexts.filter((text) => text === "Still checking the WA runtime.").length, 1);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.find((entry) => entry.messageId === secondProgress.id)?.reason, "duplicate_recent_body");
  assert.equal(outboxAfterSecond.jobs.some((job) => job.sourceMessageId === secondProgress.id), false);
});

test("whatsapp connector outbox terminalizes legacy uncertain retry rows before claim", async () => {
  const cases = [
    { name: "unconfirmed", error: "whatsapp_send_not_confirmed" },
    { name: "send-recovery", error: "whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error" },
  ];
  for (const item of cases) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-wa-connector-outbox-legacy-${item.name}-`));
    const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" });
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
    const threadId = `thread-wa-outbox-legacy-${item.name}`;
    await createThread({
      id: threadId,
      ownerUserId: "tenant-a",
      name: `WA Connector Outbox Legacy ${item.name} Thread`,
      binding: {
        connector: "whatsapp",
        chatId: "shared-chat",
        responderAccountId: "responder",
        outboundAccountId: "responder",
        mirrorToWhatsApp: true,
      },
    }, runtimeEnv);
    const parent = await appendThreadMessage(threadId, {
      role: "user",
      source: "whatsapp_inbound",
      state: "completed",
      connector: "whatsapp",
      chatId: "shared-chat",
      accountId: "responder",
      text: "status?",
    }, runtimeEnv);
    const outboundText = `Legacy maybe sent ${item.name}.`;
    const reply = await appendThreadMessage(threadId, {
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      state: "completed",
      parentMessageId: parent.id,
      chatId: "shared-chat",
      accountId: "responder",
      text: outboundText,
    }, runtimeEnv);
    const { job: legacyJob } = await ensureConnectorOutboxJob({
      tenantId: "tenant-a",
      ownerUserId: "tenant-a",
      connector: "whatsapp",
      accountId: "responder",
      chatId: "shared-chat",
      threadId,
      sourceMessageId: reply.id,
      sourceRevision: reply.revision || reply.updatedAt || reply.createdAt || "1",
      deliveryType: "final",
      payload: { text: outboundText },
      state: "failed_retryable",
      failedAt: new Date().toISOString(),
      error: item.error,
    }, runtimeEnv);

    const autoRetry = await retryRecoverableWhatsAppOutboxJobsForAccounts({
      accountIds: ["responder"],
      reason: "account_ready",
    }, runtimeEnv);
    assert.equal(autoRetry.retried.length, 0);
    assert.equal(autoRetry.skipped.find((entry) => entry.id === legacyJob.id)?.reason, "not_recoverable");

    const sentTexts = [];
    const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, init = {}) => {
      const endpoint = String(url || "");
      if (endpoint.endsWith("/send-text")) {
        const body = JSON.parse(String(init.body || "{}"));
        sentTexts.push(body.text || "");
        if (body.text === outboundText) throw new Error(`${item.name} legacy row must not be replayed`);
      }
      return response({ ok: true, ids: [`wa-sent-${sentTexts.length}`], messages: [] });
    });
    const outboxAfterDelivery = await readConnectorOutbox(runtimeEnv);
    const terminalized = outboxAfterDelivery.jobs.find((entry) => entry.id === legacyJob.id);

    assert.equal(sentTexts.includes(outboundText), false);
    assert.equal(delivery.delivered.length, 0);
    assert.equal(delivery.failed.length, 0);
    assert.equal(delivery.skipped.find((entry) => entry.messageId === reply.id)?.reason, "connector_outbox_delivery_uncertain");
    assert.equal(terminalized.state, "delivery_uncertain");
    assert.equal(terminalized.metadata.deliveryUncertain, true);
  }
});

test("whatsapp connector outbox suppresses stale pending final jobs without resending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-stale-pending-"));
  const runtimeEnv = env(home, { ORKESTR_WHATSAPP_OUTBOX_PENDING_MAX_AGE_MS: "60000" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-stale-pending",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Stale Pending Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-stale-pending", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-stale-pending", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "This stale answer must not be replayed.",
  }, runtimeEnv);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { job } = await ensureConnectorOutboxJob({
    tenantId: "tenant-a",
    ownerUserId: "tenant-a",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "shared-chat",
    threadId: "thread-wa-outbox-stale-pending",
    sourceMessageId: reply.id,
    sourceRevision: "1",
    deliveryType: "final",
    payload: { text: "This stale answer must not be replayed." },
    state: "pending",
    createdAt: old,
    updatedAt: old,
  }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(String(options.body || "{}")) });
    return response({ ok: true, ids: ["unexpected-stale-send"] });
  });
  const outboxAfterDelivery = await readConnectorOutbox(runtimeEnv);
  const suppressed = outboxAfterDelivery.jobs.find((entry) => entry.id === job.id);

  assert.equal(calls.length, 0);
  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(delivery.skipped.find((entry) => entry.messageId === reply.id)?.reason, "connector_outbox_pending_stale");
  assert.equal(suppressed.state, "suppressed");
  assert.equal(suppressed.createdAt, old);
  assert.equal(suppressed.error, "connector_outbox_pending_stale");
  assert.equal(suppressed.metadata.stalePendingSuppressed, true);
});

test("whatsapp connector outbox suppresses over-retried bridge failures without resending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-retry-limit-"));
  const runtimeEnv = env(home, { ORKESTR_WHATSAPP_OUTBOX_MAX_RETRY_ATTEMPTS: "20" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-retry-limit",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Retry Limit Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-retry-limit", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-retry-limit", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "This over-retried answer must not be replayed.",
  }, runtimeEnv);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { job } = await ensureConnectorOutboxJob({
    tenantId: "tenant-a",
    ownerUserId: "tenant-a",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "shared-chat",
    threadId: "thread-wa-outbox-retry-limit",
    sourceMessageId: reply.id,
    sourceRevision: "1",
    deliveryType: "final",
    payload: { text: "This over-retried answer must not be replayed." },
    state: "failed_retryable",
    attemptCount: 35,
    failedAt: old,
    claimExpiresAt: old,
    error: "whatsapp_local_bridge_not_ready",
    createdAt: old,
    updatedAt: old,
    metadata: { retryAfterAt: old },
  }, runtimeEnv);

  let sendTextCalls = 0;
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    if (url.pathname === "/send-text") sendTextCalls += 1;
    return response({ ok: true, ids: ["unexpected-retry-limit-send"], messages: [] });
  });
  const outboxAfterDelivery = await readConnectorOutbox(runtimeEnv);
  const suppressed = outboxAfterDelivery.jobs.find((entry) => entry.id === job.id);

  assert.equal(sendTextCalls, 0);
  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(delivery.skipped.find((entry) => entry.messageId === reply.id)?.reason, "connector_outbox_retry_limit_exceeded");
  assert.equal(suppressed.state, "suppressed");
  assert.equal(suppressed.attemptCount, 35);
  assert.equal(suppressed.error, "connector_outbox_retry_limit_exceeded");
  assert.equal(suppressed.metadata.staleRetryableSuppressed, true);
  assert.equal(suppressed.metadata.retryAttemptCount, 35);
  assert.equal(suppressed.metadata.maxRetryAttempts, 20);
});

test("whatsapp connector outbox dead-letters unknown account failures", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-unknown-account-"));
  const runtimeEnv = env(home, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "60000" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox-unknown-account",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Unknown Account Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "missing-account",
      outboundAccountId: "missing-account",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox-unknown-account", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "missing-account",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox-unknown-account", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "missing-account",
    text: "This cannot be sent.",
  }, runtimeEnv);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("unknown_whatsapp_account");
  });
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id);
  const state = await readJson(dataPaths(runtimeEnv).whatsapp, { outboundIntents: [] });
  const intent = (state.outboundIntents || []).find((item) => item.messageId === reply.id);

  assert.equal(delivery.failed.length, 1);
  assert.equal(job?.state, "dead_letter");
  assert.equal(job.claimedBy, "");
  assert.equal(job.claimExpiresAt, "");
  assert.equal(job.terminalAt.length > 0, true);
  assert.equal(job.metadata.nonRetryable, true);
  assert.equal(intent?.status, "skipped");
  assert.equal(intent?.error, "unknown_whatsapp_account");

  let retryBridgeCalls = 0;
  const second = await deliverWhatsAppReplies(runtimeEnv, async () => {
    retryBridgeCalls += 1;
    throw new Error("dead-lettered unknown account should not be retried");
  });
  assert.equal(retryBridgeCalls, 0);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.find((item) => item.messageId === reply.id)?.reason, "unknown_whatsapp_account");
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
