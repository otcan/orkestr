import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConnectorOutboxJob, listConnectorOutboxJobs, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { doctorWhatsAppRouter } from "../packages/core/src/router-doctor.js";
import { partitionHistoricalChecks, whatsappDoctorWindowHours } from "../packages/core/src/router-doctor-history-window.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours) {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

async function setup(prefix, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ENABLED: "0",
    ...extraEnv,
  };
  const thread = await createThread({
    id: "wa-window-thread",
    ownerUserId: "owner-1",
    name: "WA Window Thread",
    state: "ready",
    binding: { connector: "whatsapp", chatId: "chat-example", outboundAccountId: "responder" },
  }, env);
  return { env, thread };
}

async function appendOrphanFinal(thread, env, id, createdAt) {
  return appendThreadMessage(thread.id, {
    id,
    role: "assistant",
    source: "codex-app-server",
    connector: "whatsapp",
    chatId: "chat-example",
    accountId: "responder",
    phase: "final_answer",
    state: "completed",
    text: `Final ${id} was never mirrored.`,
    routerTraceId: `rt_${id}`,
    createdAt,
    updatedAt: createdAt,
  }, env);
}

function runDoctor(thread, env, extra = {}) {
  return doctorWhatsAppRouter({
    thread: thread.id,
    env,
    recordRunEvent: false,
    whatsappStatusFn: () => ({ ready: true, accounts: [{ accountId: "responder", ready: true }] }),
    listConnectorOutboxJobsFn: listConnectorOutboxJobs,
    ...extra,
  });
}

function orphanChecks(report) {
  return report.checks.filter((check) => check.code === "orphaned_whatsapp_final_answer");
}

test("doctor window defaults to 72 hours and honors a valid env override", () => {
  assert.equal(whatsappDoctorWindowHours({}), 72);
  assert.equal(whatsappDoctorWindowHours({ ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS: "6" }), 6);
  assert.equal(whatsappDoctorWindowHours({ ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS: "0" }), 72);
  assert.equal(whatsappDoctorWindowHours({ ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS: "nope" }), 72);
});

test("in-window orphaned WhatsApp final is reported as an error", async () => {
  const { env, thread } = await setup("orkestr-doctor-window-recent-");
  const final = await appendOrphanFinal(thread, env, "wa-final-recent", hoursAgo(2));

  const report = await runDoctor(thread, env);

  assert.equal(orphanChecks(report).some((check) => check.messageId === final.id && check.severity === "error"), true);
  assert.equal(report.status, "broken");
  assert.equal(report.ok, false);
  assert.equal(report.counts.historical, 0);
  assert.equal(report.checks.some((check) => check.code === "historical_orphaned_whatsapp_finals"), false);
});

test("old orphaned WhatsApp finals are aggregated as historical info, not errors", async () => {
  const { env, thread } = await setup("orkestr-doctor-window-old-");
  await appendOrphanFinal(thread, env, "wa-final-old-1", hoursAgo(24 * 30));
  await appendOrphanFinal(thread, env, "wa-final-old-2", hoursAgo(24 * 10));
  await appendOrphanFinal(thread, env, "wa-final-old-3", hoursAgo(80));

  const report = await runDoctor(thread, env);
  const summaries = report.checks.filter((check) => check.code === "historical_orphaned_whatsapp_finals");

  assert.equal(orphanChecks(report).length, 0);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].severity, "info");
  assert.equal(summaries[0].count, 3);
  assert.equal(summaries[0].threads, 1);
  assert.equal(summaries[0].windowHours, 72);
  assert.deepEqual(summaries[0].byCode, { orphaned_whatsapp_final_answer: 3 });
  assert.equal(report.counts.errors, 0);
  assert.equal(report.counts.historical, 3);
  assert.equal(report.counts.historicalOrphanedFinals, 3);
  assert.equal(report.threads[0].historical.orphanedFinals.count, 3);
  assert.equal(report.threads[0].checks.some((check) => check.code === "orphaned_whatsapp_final_answer"), false);
  assert.equal(report.threads[0].historicalChecks, undefined);
});

test("status is ok when only historical findings exist and only in-window errors break it", async () => {
  const { env, thread } = await setup("orkestr-doctor-window-status-");
  await appendOrphanFinal(thread, env, "wa-final-history", hoursAgo(24 * 60));

  const historicalOnly = await runDoctor(thread, env);
  assert.equal(historicalOnly.status, "ok");
  assert.equal(historicalOnly.ok, true);
  assert.equal(historicalOnly.counts.errors, 0);
  assert.equal(historicalOnly.counts.warnings, 0);
  assert.equal(historicalOnly.counts.historical, 1);

  const fresh = await appendOrphanFinal(thread, env, "wa-final-fresh", hoursAgo(1));
  const mixed = await runDoctor(thread, env);
  assert.equal(mixed.status, "broken");
  assert.equal(mixed.counts.errors, 1);
  assert.equal(orphanChecks(mixed)[0].messageId, fresh.id);
  assert.equal(mixed.counts.historical, 1);
});

test("ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS overrides the window", async () => {
  const { env, thread } = await setup("orkestr-doctor-window-env-", { ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS: "6" });
  const older = await appendOrphanFinal(thread, env, "wa-final-12h", hoursAgo(12));
  const recent = await appendOrphanFinal(thread, env, "wa-final-1h", hoursAgo(1));

  const narrow = await runDoctor(thread, env);
  assert.deepEqual(orphanChecks(narrow).map((check) => check.messageId), [recent.id]);
  assert.equal(narrow.counts.historicalOrphanedFinals, 1);
  assert.equal(narrow.windowHours, 6);

  const wide = await runDoctor(thread, { ...env, ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS: "24" });
  assert.deepEqual(orphanChecks(wide).map((check) => check.messageId).sort(), [older.id, recent.id].sort());
  assert.equal(wide.counts.historical, 0);
});

test("repair leaves historical orphaned finals alone unless explicitly requested", async () => {
  const { env, thread } = await setup("orkestr-doctor-window-repair-");
  const final = await appendOrphanFinal(thread, env, "wa-final-old-repair", hoursAgo(24 * 20));
  const recent = await appendOrphanFinal(thread, env, "wa-final-new-repair", hoursAgo(1));
  const finalJobs = async (id) => (await readConnectorOutbox(env)).jobs.filter((job) => job.sourceMessageId === id && job.deliveryType === "final");

  const repaired = await runDoctor(thread, env, { repair: true, ensureConnectorOutboxJobFn: ensureConnectorOutboxJob });
  assert.equal(repaired.repairs.some((item) => item.messageId === final.id), false);
  assert.equal(repaired.repairs.some((item) => item.code === "enqueue_orphaned_final_answer_mirror" && item.messageId === recent.id), true);
  assert.equal((await finalJobs(final.id)).length, 0, "a default repair must not re-send an old final");
  assert.equal((await finalJobs(recent.id)).length, 1);

  const explicit = await runDoctor(thread, env, { repair: true, repairHistorical: true, ensureConnectorOutboxJobFn: ensureConnectorOutboxJob });
  assert.equal(explicit.repairs.some((item) => item.code === "enqueue_orphaned_final_answer_mirror" && item.messageId === final.id), true);
  assert.equal((await finalJobs(final.id)).length, 1);
});

test("partition keeps non per-message checks and untimestamped checks current", () => {
  const nowMs = Date.parse("2026-01-10T00:00:00.000Z");
  const messages = [
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-01-09T12:00:00.000Z" },
  ];
  const traces = [{ routerTraceId: "rt_old", createdAt: "2026-01-01T00:00:00.000Z" }];
  const checks = [
    { code: "transport_down", severity: "error" },
    { code: "stale_outbox_claim", severity: "error", messageId: "old" },
    { code: "orphaned_whatsapp_final_answer", severity: "error", messageId: "old" },
    { code: "orphaned_whatsapp_final_answer", severity: "error", messageId: "new" },
    { code: "orphaned_whatsapp_final_answer", severity: "error", messageId: "unknown" },
    { code: "missing_router_trace_phase", severity: "error", routerTraceId: "rt_old" },
  ];
  const { current, historical } = partitionHistoricalChecks(checks, { messages, traces, env: {}, nowMs });
  assert.deepEqual(historical.map((check) => `${check.code}:${check.messageId || check.routerTraceId}`), [
    "orphaned_whatsapp_final_answer:old",
    "missing_router_trace_phase:rt_old",
  ]);
  assert.equal(current.length, 4);
});
