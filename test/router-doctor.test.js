import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConnectorOutboxJob, listConnectorOutboxJobs, readConnectorOutbox, releaseConnectorOutboxClaim } from "../packages/connectors/src/connector-outbox.js";
import { doctorWhatsAppRouter } from "../packages/core/src/router-doctor.js";
import { listRouterTraces, recordRouterTraceEvent } from "../packages/core/src/router-traces.js";
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

test("WhatsApp router doctor backfills missing runtime delivery phases from assistant reply evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-trace-backfill-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const routerTraceId = "rt_missing_delivery_phases";
  const turnId = "turn_missing_delivery_phases";
  const user = await appendThreadMessage(thread.id, {
    id: "wa-user-1",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-msg-1",
    routerTraceId,
    text: "Please handle this",
    state: "completed",
    deliveryState: "delivered",
    createdAt: "2026-07-12T18:00:00.000Z",
    updatedAt: "2026-07-12T18:00:00.000Z",
  }, env);
  await appendThreadMessage(thread.id, {
    id: "wa-assistant-1",
    role: "assistant",
    source: "codex",
    connector: "whatsapp",
    chatId: "chat-1",
    text: "Handled.",
    state: "completed",
    deliveryState: "delivered",
    createdAt: "2026-07-12T18:00:30.000Z",
    updatedAt: "2026-07-12T18:00:30.000Z",
  }, env);

  const traceBase = {
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId: "responder",
    chatId: "chat-1",
    sourceEventId: "wa-msg-1",
    threadId: thread.id,
    messageId: user.id,
  };
  await recordRouterTraceEvent({ ...traceBase, phase: "received", ts: "2026-07-12T18:00:00.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "routed", ts: "2026-07-12T18:00:00.100Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "queued", ts: "2026-07-12T18:00:00.200Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "assistant_seen", ts: "2026-07-12T18:00:30.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "mirror_sent", ts: "2026-07-12T18:00:31.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "completed", ts: "2026-07-12T18:00:31.500Z", terminal: true }, env);

  const before = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });
  assert.deepEqual(
    before.checks.find((check) => check.routerTraceId === routerTraceId)?.missingPhases,
    ["delivery_started", "delivered_to_runtime"],
  );

  const repaired = await doctorWhatsAppRouter({ thread: thread.id, repair: true, env, whatsappStatusFn: readyWhatsAppStatus });
  const repair = repaired.repairs.find((item) => item.code === "backfill_router_trace_phases" && item.routerTraceId === routerTraceId);
  assert.deepEqual(repair?.phases, ["delivery_started", "delivered_to_runtime"]);
  assert.equal(repair?.currentPhase, "completed");

  const after = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });
  const trace = (await listRouterTraces({ routerTraceId }, env))[0];
  const phaseNames = trace.phases.map((phase) => phase.phase);

  assert.equal(after.checks.some((check) => check.routerTraceId === routerTraceId), false);
  assert.equal(trace.currentPhase, "completed");
  assert.equal(trace.terminal, true);
  assert.equal(phaseNames.includes("delivery_started"), true);
  assert.equal(phaseNames.includes("delivered_to_runtime"), true);
});

test("WhatsApp router doctor does not require inbound phases for outbound-only mirror traces", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-outbound-only-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const routerTraceId = "rt_outbound_only_mirror";
  const traceBase = {
    routerTraceId,
    turnId: "turn_outbound_only_mirror",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "chat-1",
    threadId: thread.id,
    messageId: "assistant-outbound-only-1",
    deliveryType: "final",
  };
  await recordRouterTraceEvent({ ...traceBase, phase: "assistant_seen", ts: "2026-07-12T18:00:30.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "mirror_claimed", ts: "2026-07-12T18:00:30.500Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "mirror_sent", ts: "2026-07-12T18:00:31.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "completed", ts: "2026-07-12T18:00:31.500Z", terminal: true }, env);

  const report = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });

  assert.equal(report.checks.some((check) => check.code === "missing_router_trace_phase" && check.routerTraceId === routerTraceId), false);
});

test("WhatsApp router doctor does not require runtime delivery for local terminal commands", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-local-terminal-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const routerTraceId = "rt_google_connect_terminal";
  const user = await appendThreadMessage(thread.id, {
    id: "wa-connect-1",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-connect-1",
    routerTraceId,
    text: "/connect google",
    state: "completed",
    deliveryState: "delivered",
  }, env);
  const traceBase = {
    routerTraceId,
    turnId: "turn_google_connect_terminal",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "chat-1",
    sourceEventId: "wa-connect-1",
    threadId: thread.id,
    messageId: user.id,
  };
  await recordRouterTraceEvent({ ...traceBase, phase: "received" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "routed" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "completed", reason: "google_workspace_connect", terminal: true }, env);

  const report = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });

  assert.equal(report.checks.some((check) => check.code === "missing_router_trace_phase" && check.routerTraceId === routerTraceId), false);
  assert.equal(report.checks.some((check) => check.code === "queued_whatsapp_input_marked_terminal_without_runtime_delivery" && check.routerTraceId === routerTraceId), false);
});

test("WhatsApp router doctor backfills app-server delivered input without requiring an assistant reply", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-app-server-delivered-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const routerTraceId = "rt_app_server_delivered";
  const deliveredAt = "2026-07-12T18:00:20.000Z";
  const user = await appendThreadMessage(thread.id, {
    id: "wa-app-server-1",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    externalId: "wa-app-server-1",
    routerTraceId,
    text: "You did not fix it yet",
    state: "completed",
    deliveryState: "delivered",
    deliveredAt,
    observedVia: "codex_app_server_turn_steer",
    codexThreadId: "codex-thread-1",
    codexTurnId: "codex-turn-1",
    steerActiveTurn: true,
    createdAt: "2026-07-12T18:00:00.000Z",
    updatedAt: deliveredAt,
  }, env);
  const traceBase = {
    routerTraceId,
    turnId: "turn_app_server_delivered",
    connector: "whatsapp",
    accountId: "responder",
    chatId: "chat-1",
    sourceEventId: "wa-app-server-1",
    threadId: thread.id,
    messageId: user.id,
  };
  await recordRouterTraceEvent({ ...traceBase, phase: "received", ts: "2026-07-12T18:00:00.000Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "routed", ts: "2026-07-12T18:00:00.100Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "queued", ts: "2026-07-12T18:00:00.200Z" }, env);
  await recordRouterTraceEvent({ ...traceBase, phase: "skipped", reason: "duplicate_event_id", ts: "2026-07-12T18:00:30.000Z", terminal: true }, env);

  const before = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });
  assert.deepEqual(
    before.checks.find((check) => check.routerTraceId === routerTraceId)?.missingPhases,
    ["delivery_started", "delivered_to_runtime"],
  );
  assert.equal(before.checks.some((check) => check.code === "queued_whatsapp_input_marked_terminal_without_runtime_delivery" && check.routerTraceId === routerTraceId), false);
  assert.equal(before.checks.some((check) => check.code === "older_reply_completed_newer_user_message" && check.routerTraceId === routerTraceId), false);

  const repaired = await doctorWhatsAppRouter({ thread: thread.id, repair: true, env, whatsappStatusFn: readyWhatsAppStatus });
  const repair = repaired.repairs.find((item) => item.code === "backfill_router_trace_phases" && item.routerTraceId === routerTraceId);
  assert.deepEqual(repair?.phases, ["delivery_started", "delivered_to_runtime"]);

  const after = await doctorWhatsAppRouter({ thread: thread.id, env, whatsappStatusFn: readyWhatsAppStatus });
  assert.equal(after.checks.some((check) => check.routerTraceId === routerTraceId), false);
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

test("WhatsApp router doctor repairs orphaned WhatsApp final answers by enqueuing one outbox job", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-orphan-final-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const final = await appendThreadMessage(thread.id, {
    id: "wa-final-orphan-1",
    role: "assistant",
    source: "codex-app-server",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    phase: "final_answer",
    state: "completed",
    text: "This final was never mirrored.",
    routerTraceId: "rt_orphan_final",
    createdAt: "2026-07-12T18:00:30.000Z",
    updatedAt: "2026-07-12T18:00:30.000Z",
  }, env);

  const before = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
  });
  assert.equal(before.checks.some((check) => check.code === "orphaned_whatsapp_final_answer" && check.messageId === final.id), true);

  const repaired = await doctorWhatsAppRouter({
    thread: thread.id,
    repair: true,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
    ensureConnectorOutboxJobFn: ensureConnectorOutboxJob,
  });
  const repair = repaired.repairs.find((item) => item.code === "enqueue_orphaned_final_answer_mirror" && item.messageId === final.id);
  const outbox = await readConnectorOutbox(env);
  const finalJobs = outbox.jobs.filter((job) => job.sourceMessageId === final.id && job.deliveryType === "final");
  const messages = await listThreadMessages(thread.id, env);
  const updatedFinal = messages.find((message) => message.id === final.id);

  assert.equal(Boolean(repair), true);
  assert.equal(finalJobs.length, 1);
  assert.equal(finalJobs[0].state, "pending");
  assert.equal(finalJobs[0].payload.text, "This final was never mirrored.");
  assert.equal(updatedFinal.mirrorOutboxJobId, finalJobs[0].id);
  assert.equal(updatedFinal.deliveryState, "pending_whatsapp_mirror");

  const repairedAgain = await doctorWhatsAppRouter({
    thread: thread.id,
    repair: true,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
    ensureConnectorOutboxJobFn: ensureConnectorOutboxJob,
  });
  const outboxAgain = await readConnectorOutbox(env);
  const finalJobsAgain = outboxAgain.jobs.filter((job) => job.sourceMessageId === final.id && job.deliveryType === "final");

  assert.equal(repairedAgain.checks.some((check) => check.code === "orphaned_whatsapp_final_answer" && check.messageId === final.id), false);
  assert.equal(finalJobsAgain.length, 1);
});

test("WhatsApp router doctor ignores historical finals without live mirror intent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-historical-final-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const final = await appendThreadMessage(thread.id, {
    id: "wa-historical-final-1",
    role: "assistant",
    source: "codex-app-server-import",
    connector: "whatsapp",
    chatId: "chat-1",
    accountId: "responder",
    phase: "final_answer",
    state: "completed",
    text: "Historical final with no routed WhatsApp turn.",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
  }, env);

  const report = await doctorWhatsAppRouter({
    thread: thread.id,
    env,
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
  });

  assert.equal(report.checks.some((check) => check.code === "orphaned_whatsapp_final_answer" && check.messageId === final.id), false);
});

test("WhatsApp router doctor scopes orphan checks to the selected trace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-trace-scope-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const user = await appendThreadMessage(thread.id, {
    id: "wa-selected-user",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    routerTraceId: "rt_selected",
    text: "Selected trace",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "codex_app_server_user_input",
  }, env);
  await recordRouterTraceEvent({ routerTraceId: "rt_selected", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase: "received" }, env);
  await recordRouterTraceEvent({ routerTraceId: "rt_selected", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase: "routed" }, env);
  await recordRouterTraceEvent({ routerTraceId: "rt_selected", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase: "queued" }, env);
  await recordRouterTraceEvent({ routerTraceId: "rt_selected", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase: "delivery_started" }, env);
  await recordRouterTraceEvent({ routerTraceId: "rt_selected", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase: "delivered_to_runtime" }, env);
  await appendThreadMessage(thread.id, {
    id: "wa-unrelated-orphan",
    role: "assistant",
    source: "codex-app-server",
    connector: "whatsapp",
    chatId: "chat-1",
    phase: "final_answer",
    state: "completed",
    routerTraceId: "rt_unrelated",
    text: "Unrelated orphan final",
  }, env);

  const report = await doctorWhatsAppRouter({
    trace: "rt_selected",
    env,
    runtimeStatusFn: async () => ({ state: "working", working: true }),
    whatsappStatusFn: readyWhatsAppStatus,
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
  });

  assert.equal(report.checks.some((check) => check.messageId === "wa-unrelated-orphan"), false);
});

test("WhatsApp router doctor requeues runtime-delivered input after an idle turn produced no answer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-router-doctor-missing-answer-"));
  const env = runtimeEnv(home);
  const thread = await createWhatsAppThread(env);
  const stale = new Date(Date.now() - 60_000).toISOString();
  const user = await appendThreadMessage(thread.id, {
    id: "wa-runtime-no-answer",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-1",
    routerTraceId: "rt_runtime_no_answer",
    text: "This reached Codex but got no answer",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "codex_app_server_user_input",
    createdAt: stale,
    updatedAt: stale,
  }, env);
  for (const phase of ["received", "routed", "queued", "delivery_started", "delivered_to_runtime"]) {
    await recordRouterTraceEvent({ routerTraceId: "rt_runtime_no_answer", connector: "whatsapp", threadId: thread.id, messageId: user.id, phase }, env);
  }
  const status = async () => ({ state: "ready", promptReady: true, working: false });
  const before = await doctorWhatsAppRouter({ thread: thread.id, env, runtimeStatusFn: status, whatsappStatusFn: readyWhatsAppStatus });
  assert.equal(before.checks.some((check) => check.code === "runtime_delivery_completed_without_assistant" && check.messageId === user.id), true);

  const repaired = await doctorWhatsAppRouter({ thread: thread.id, repair: true, env, runtimeStatusFn: status, whatsappStatusFn: readyWhatsAppStatus });
  const messages = await listThreadMessages(thread.id, env);
  const updated = messages.find((message) => message.id === user.id);
  assert.equal(repaired.repairs.some((item) => item.code === "requeue_runtime_delivery_without_assistant" && item.messageId === user.id), true);
  assert.equal(["queued", "running"].includes(updated.state), true);
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
