import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { applyConnectorOutboxJobAction, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { retryRecoverableWhatsAppOutboxJobsForAccounts } from "../packages/connectors/src/whatsapp-outbox-recovery.js";
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
    ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "60000",
    ...extra,
  };
}

async function createRecoveryThread(home, id) {
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id,
    ownerUserId: "tenant-a",
    name: "WhatsApp recovery test thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage(id, {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage(id, {
    role: "assistant",
    source: "codex-app-server-import",
    observedVia: "codex_app_server_history_sync",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "Recovered after the bridge restart.",
  }, runtimeEnv);
  return { runtimeEnv, reply };
}

test("whatsapp auto-recovery invalidates a cached retry-backoff scan before redelivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-outbox-recovery-cache-"));
  const { runtimeEnv, reply } = await createRecoveryThread(home, "thread-wa-outbox-recovery-cache");

  const failed = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error");
  });
  assert.equal(failed.failed.length, 1);

  // This reproduces the production sequence: the retry-backoff scan caches a
  // pending intent before the local WhatsApp account reports ready again.
  const backoff = await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("retry backoff should not send");
  });
  assert.equal(backoff.delivered.length, 0);
  assert.deepEqual(backoff.skipped.find((item) => item.messageId === reply.id)?.reason, "connector_outbox_retry_scheduled");

  const retried = await retryRecoverableWhatsAppOutboxJobsForAccounts({
    accountIds: ["responder"],
    reason: "test_account_recovered",
  }, runtimeEnv);
  assert.equal(retried.retried.length, 1);
  assert.equal(retried.retried[0].mirrorStateSynced, true);

  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === reply.id);
  assert.equal(intent.status, "pending");
  assert.ok(intent.retryRequestedAt);

  const calls = [];
  const delivered = await deliverWhatsAppReplies(runtimeEnv, async (url) => {
    calls.push(url.pathname);
    return response({ ok: true, ids: ["wa-sent-after-cached-auto-retry"] });
  });

  assert.equal(calls.filter((item) => item === "/send-text").length, 1);
  assert.equal(delivered.delivered.length, 1);
  const outbox = await readConnectorOutbox(runtimeEnv);
  assert.equal(outbox.jobs.find((item) => item.sourceMessageId === reply.id)?.state, "delivered");
});

test("whatsapp auto-recovery repairs pending jobs stranded by an earlier recovery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-outbox-recovery-stranded-"));
  const { runtimeEnv, reply } = await createRecoveryThread(home, "thread-wa-outbox-recovery-stranded");

  await deliverWhatsAppReplies(runtimeEnv, async () => {
    throw new Error("whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error");
  });
  const failedOutbox = await readConnectorOutbox(runtimeEnv);
  const failedJob = failedOutbox.jobs.find((item) => item.sourceMessageId === reply.id);
  await applyConnectorOutboxJobAction(failedJob.id, "retry", {
    reason: "whatsapp_local_account_ready",
    operator: "whatsapp-auto-recovery",
  }, runtimeEnv);

  const recovered = await retryRecoverableWhatsAppOutboxJobsForAccounts({
    accountIds: ["responder"],
    reason: "whatsapp_local_account_ready",
  }, runtimeEnv);
  assert.equal(recovered.retried.length, 1);
  assert.equal(recovered.retried[0].previousState, "pending");

  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  assert.equal(state.outboundIntents.find((item) => item.messageId === reply.id)?.status, "pending");
  const delivered = await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-after-legacy-repair"] }));
  assert.equal(delivered.delivered.length, 1);
});
