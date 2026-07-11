import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConnectorOutboxJob, listConnectorOutboxJobs, readConnectorOutbox, releaseConnectorOutboxClaim } from "../packages/connectors/src/connector-outbox.js";
import { doctorWhatsAppRouter } from "../packages/core/src/router-doctor.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";

function runtimeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_ROUTER_DOCTOR_STALE_QUEUE_MS: "15000",
    ORKESTR_ROUTER_DOCTOR_OUTBOX_CLAIM_MS: "15000",
    ORKESTR_WHATSAPP_ENABLED: "0",
    ...extra,
  };
}

async function createWhatsAppThread(env) {
  return createThread({
    id: "wa-doctor-thread",
    ownerUserId: "otcan",
    name: "WA Doctor Thread",
    state: "sleeping",
    binding: { connector: "whatsapp", chatId: "chat-1", outboundAccountId: "responder" },
  }, env);
}

function readyWhatsAppStatus() {
  return { ready: true, accounts: [{ accountId: "responder", ready: true }] };
}

function downWhatsAppStatus() {
  return { ready: false, state: "disabled" };
}

test("WhatsApp router doctor treats runtime account aliases as ready", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-alias-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);

  const report = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    whatsappStatusFn: async () => ({
      state: "paired",
      ready: true,
      accounts: [{
        id: "905555154214",
        accountId: "905555154214",
        runtimeAccountId: "responder",
        legacyRoleAliases: ["responder"],
        ready: true,
        state: "ready",
      }],
    }),
  });

  assert.equal(report.checks.some((check) => check.code === "transport_down"), false);
});

test("WhatsApp router doctor treats scoped tenant send bridge as ready", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-scoped-send-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);

  const report = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    whatsappStatusFn: async () => ({
      state: "send_ready_scoped",
      summary: "WhatsApp parent bridge is configured for scoped sending.",
      accounts: [],
    }),
  });

  assert.equal(report.checks.some((check) => check.code === "transport_down"), false);
});

test("WhatsApp router doctor detects and requeues terminal user input without runtime evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-terminal-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const user = await appendThreadMessage(thread.id, {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-msg-1",
    text: "Will you now push all the messages?",
    state: "completed",
    deliveryState: "delivered",
  }, env);

  const before = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: downWhatsAppStatus });
  assert.equal(before.ok, false);
  assert.equal(before.checks.some((check) => check.code === "queued_whatsapp_input_marked_terminal_without_runtime_delivery" && check.messageId === user.id), true);

  const repaired = await doctorWhatsAppRouter({ thread: thread.id, repair: true, env, whatsappStatusFn: downWhatsAppStatus });
  const messages = await listThreadMessages(thread.id, env);
  const updated = messages.find((message) => message.id === user.id);

  assert.equal(repaired.repairs.some((repair) => repair.code === "requeue_swallowed_input" && repair.messageId === user.id), true);
  assert.equal(updated.state, "queued");
  assert.equal(updated.deliveryState, "retrying_delivery");
});

test("WhatsApp router doctor releases stale connector outbox claims", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-outbox-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const stale = new Date(Date.now() - 60_000).toISOString();
  const expired = new Date(Date.now() - 30_000).toISOString();
  const created = await ensureConnectorOutboxJob({
    tenantId: "otcan",
    ownerUserId: "otcan",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "chat-1",
    threadId: thread.id,
    sourceEventId: "assistant-1",
    sourceMessageId: "assistant-1",
    sourceRevision: "1",
    deliveryType: "final",
    payload: { text: "reply" },
    state: "claimed",
    claimedBy: "worker-a",
    claimedAt: stale,
    claimExpiresAt: expired,
  }, env);

  const before = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
  });
  assert.equal(before.checks.some((check) => check.code === "stale_outbox_claim" && check.outboxJobId === created.job.id), true);

  const repaired = await doctorWhatsAppRouter({
    thread: thread.id,
    repair: true,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
    releaseConnectorOutboxClaimFn: releaseConnectorOutboxClaim,
  });
  const store = await readConnectorOutbox(env);
  const job = store.jobs.find((item) => item.id === created.job.id);

  assert.equal(repaired.repairs.some((repair) => repair.code === "release_stale_outbox_claim" && repair.outboxJobId === created.job.id), true);
  assert.equal(job.state, "pending");
  assert.equal(job.claimedBy, "");
});

test("WhatsApp router doctor reports queued input while runtime is sleeping", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-sleeping-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  await appendThreadMessage(thread.id, {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-msg-queued",
    text: "Run this later",
    state: "queued",
    deliveryState: "waiting_runtime_start",
  }, env);
  await updateThread(thread.id, { state: "sleeping", runtime: { state: "sleeping" } }, env);

  const report = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: downWhatsAppStatus });
  assert.equal(report.checks.some((check) => check.code === "sleeping_thread_has_queued_whatsapp_input"), true);
  assert.equal(report.checks.some((check) => check.code === "transport_down"), true);
});

test("WhatsApp router doctor does not treat a working runtime as ready for stale delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-working-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const stale = new Date(Date.now() - 60_000).toISOString();
  await appendThreadMessage(thread.id, {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-msg-working",
    text: "Keep working",
    state: "queued",
    deliveryState: "waiting_runtime_ready",
    createdAt: stale,
    updatedAt: stale,
  }, env);

  const report = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    runtimeStatusFn: async () => ({ state: "working", promptReady: true, working: true }),
    whatsappStatusFn: async () => ({ ready: true, accounts: [{ accountId: "responder", ready: true }] }),
  });

  assert.equal(report.checks.some((check) => check.code === "stale_queued_whatsapp_input_ready_runtime"), false);
});

test("WhatsApp router doctor requeues stale non-ack input before retrying delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-stale-requeue-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const stale = new Date(Date.now() - 60_000).toISOString();
  const input = await appendThreadMessage(thread.id, {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-msg-running",
    text: "Keep working",
    state: "running",
    deliveryState: "runtime_delivery_started",
    createdAt: stale,
    updatedAt: stale,
  }, env);

  const repaired = await doctorWhatsAppRouter({
    thread: thread.id,
    repair: true,
    env,
    runtimeStatusFn: async () => ({ state: "ready", promptReady: true, working: false }),
    whatsappStatusFn: async () => ({ ready: true, accounts: [{ accountId: "responder", ready: true }] }),
  });
  const messages = await listThreadMessages(thread.id, env);
  const updated = messages.find((message) => message.id === input.id);
  const repair = repaired.repairs.find((item) => item.code === "retry_runtime_delivery" && item.messageId === input.id);

  assert.equal(Boolean(repair), true);
  assert.equal(repair.requeued, true);
  assert.equal(updated.state, "queued");
  assert.equal(updated.deliveryState, "waiting_runtime_start");
});
