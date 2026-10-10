// Sealed audit record (G9) and notification intents (G10) for Agent Job runs.
// The audit record is built from the journal when a run becomes terminal and
// stored with the run in the same transaction. Notification intents are
// written in the same transaction as the state change they announce, keyed
// H(run, event, channel, target); packages/connectors/src/
// agent-job-notification-relay.js moves them into the connector outbox, whose
// idempotency key is the same, so each notification is enqueued at most once.
import { listApprovalsSync, listEffectsSync, redactValue } from "./agent-job-ledger.js";
import {
  appendCheckpointSync,
  getRunSync,
  listAttemptsSync,
  listCheckpointsSync,
  nowIso,
  openAgentJobDb,
  sha256,
  tx,
  updateRunSync,
} from "./agent-job-store.js";

// Owner default: WhatsApp and email are notification channels only; approval
// decisions come from the CLI/API/UI. Configurable via env for later.
export function notificationChannelsEnabled(env = process.env) {
  const raw = String(env.ORKESTR_AGENT_JOB_NOTIFY_CHANNELS || "thread,webhook,email,whatsapp");
  return new Set(raw.split(/[,\s]+/).filter(Boolean));
}

export function buildAuditRecordSync(db, runId, secretValues = []) {
  const run = getRunSync(db, runId);
  const checkpoints = listCheckpointsSync(db, runId);
  const record = {
    run_id: run.id,
    job: run.job,
    spec_hash: run.specHash,
    trigger: { type: run.trigger.type, name: run.trigger.name || null, dedupe_key: run.trigger.dedupeKey || null },
    state: run.state,
    reason: run.reason,
    attempts: listAttemptsSync(db, runId).map((attempt) => ({
      n: attempt.n,
      provider: attempt.provider,
      state: attempt.state,
      end_reason: attempt.endReason,
      resumed_from_seq: attempt.resumedFromSeq,
      error: attempt.error,
    })),
    tool_decisions: checkpoints.filter((entry) => entry.kind === "tool_decision")
      .map((entry) => ({ seq: entry.seq, tool: entry.data.tool, decision: entry.data.decision })),
    effects: listEffectsSync(db, runId).map((effect) => ({
      effect_key: effect.effectKey,
      tool: effect.tool,
      args_hash: effect.argsHash,
      state: effect.state,
      outcome: effect.outcome,
      ref: effect.ref,
      reconciled: effect.reconciled,
    })),
    approvals: listApprovalsSync(db, runId).map((approval) => ({
      approval_id: approval.approvalId,
      tool: approval.tool,
      reason: approval.reason,
      args_hash: approval.argsHash,
      decision: approval.state,
      by: approval.decidedBy,
      at: approval.decidedAt,
      consumed: Boolean(approval.consumedAt),
    })),
    journal: checkpoints.map((entry) => ({ seq: entry.seq, attempt: entry.attempt, kind: entry.kind, at: entry.at })),
    output: run.output,
    error: run.error,
    started_at: run.createdAt,
    finished_at: run.finishedAt,
  };
  return redactValue(record, secretValues);
}

// Move a run to a terminal state and seal its audit record atomically.
export function finalizeRunSync(db, runId, { state, reason = null, output = null, error = null }, secretValues = [], { spec = null, env = process.env } = {}) {
  const current = getRunSync(db, runId);
  if (!current || current.sealed) return current;
  updateRunSync(db, runId, {
    state,
    reason,
    output: output === null ? current.output : redactValue(output, secretValues),
    error: error ? String(redactValue(String(error), secretValues)).slice(0, 1000) : current.error,
    finishedAt: nowIso(),
    nextAttemptAt: null,
  });
  appendCheckpointSync(db, runId, null, "run_finished", { state, reason });
  if (spec) recordNotificationsSync(db, runId, spec, state, { env });
  const audit = buildAuditRecordSync(db, runId, secretValues);
  const sealedAt = nowIso();
  return updateRunSync(db, runId, { audit: { ...audit, sealed_at: sealedAt }, sealedAt });
}

export async function getRunAudit(runId, env = process.env) {
  const db = await openAgentJobDb(env);
  const row = db.prepare("select audit_json from runs where id = ?").get(String(runId || ""));
  if (row?.audit_json) return JSON.parse(row.audit_json);
  return getRunSync(db, runId) ? { ...buildAuditRecordSync(db, runId), sealed_at: null } : null;
}

function notificationKey(runId, event, channel, target) {
  return `agent-job-notify:${sha256([runId, event, channel, target]).slice(0, 48)}`;
}

function notificationText(run, event, detail = {}) {
  const extra = detail.approvalId
    ? ` approval=${detail.approvalId} tool=${detail.tool}. Approve with \`orkestr jobs approve ${detail.approvalId}\` or reply "approve ${detail.approvalId}" / "deny ${detail.approvalId}" in the job's WhatsApp group`
    : detail.attempt ? ` attempt=${detail.attempt}` : "";
  return `Agent job ${run.job} run ${run.id}: ${event}${run.reason && event === "failed" ? ` (${run.reason})` : ""}${extra}`;
}

// Record notification intents for one event. Call inside the transaction that
// changes the run state. `eventId` distinguishes repeated events of the same
// kind (one per approval, one per retry).
export function recordNotificationsSync(db, runId, spec, event, { eventId = event, detail = {}, env = process.env } = {}) {
  const enabled = notificationChannelsEnabled(env);
  const run = getRunSync(db, runId);
  let recorded = 0;
  for (const rule of spec?.notifications || []) {
    if (!rule.on.includes(event) || !enabled.has(rule.channel)) continue;
    const key = notificationKey(runId, eventId, rule.channel, rule.target);
    const payload = {
      runId, job: run.job, event, channel: rule.channel, target: rule.target, text: notificationText(run, event, detail),
      ...(detail.approvalId ? { approvalId: detail.approvalId, tool: detail.tool || null } : {}),
      ...(run.reason && event === "failed" ? { reason: run.reason } : {}),
    };
    const result = db.prepare(`insert or ignore into notifications (key, run_id, event, channel, target, payload_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`).run(key, runId, eventId, rule.channel, rule.target, JSON.stringify(payload), nowIso());
    recorded += Number(result.changes);
  }
  return recorded;
}

export async function listPendingNotifications({ limit = 100 } = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  return db.prepare("select * from notifications where relayed_at is null order by created_at, rowid limit ?").all(limit)
    .map((row) => ({ key: row.key, runId: row.run_id, event: row.event, channel: row.channel, target: row.target, payload: JSON.parse(row.payload_json) }));
}

export async function markNotificationRelayed(key, outboxJobId, env = process.env) {
  const db = await openAgentJobDb(env);
  db.prepare("update notifications set relayed_at = ?, outbox_job_id = ? where key = ? and relayed_at is null").run(nowIso(), outboxJobId || null, key);
}

export async function listRunNotifications(runId, env = process.env) {
  const db = await openAgentJobDb(env);
  return db.prepare("select key, run_id, event, channel, target, outbox_job_id, created_at, relayed_at from notifications where run_id = ? order by created_at, rowid").all(runId);
}
