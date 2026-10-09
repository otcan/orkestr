// Bounded retry policy for WhatsApp connector-outbox jobs.
//
// A pending/failed_retryable job is only re-evaluated when the delivery scanner
// revisits its source message. Jobs it never revisits (superseded revisions,
// final projections delivered under another key) stayed open forever. This
// sweep archives jobs that exceeded the attempt cap or whose *generation* age
// (creation or explicit operator retry/replay, never routine retry updates)
// exceeds the maximum. Archived rows are terminal, never pruned, and keep their
// updatedAt, so they cannot evict delivered rows that guard against duplicate
// sends. It never sends or replays anything.
import { connectorOutboxRetryBackoffMs, listConnectorOutboxJobs } from "./connector-outbox.js";
import { withConnectorOutboxMutation } from "./connector-outbox-lock.js";
import { createConnectorOutboxLedgerIndex } from "./whatsapp-outbox-ledger-match.js";
import { archiveOutboxSelection } from "./whatsapp-outbox-stale-archive.js";
import { hasWhatsAppPartialDelivery } from "./whatsapp-replay-safety.js";
import { appendEvent } from "../../storage/src/store.js";

export const retryPolicyStates = ["pending", "failed_retryable"];
const hourMs = 3_600_000;
const lastSweepByHome = new Map();
const clean = (value) => String(value ?? "").trim();
const timeMs = (value) => { const ms = Date.parse(clean(value)); return Number.isFinite(ms) ? ms : 0; };

function envInteger(values, fallback) {
  const raw = values.map(clean).find(Boolean);
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function connectorOutboxRetryPolicy(env = process.env) {
  return {
    maxAttempts: envInteger([env.ORKESTR_CONNECTOR_OUTBOX_MAX_ATTEMPTS, env.ORKESTR_WHATSAPP_OUTBOX_MAX_RETRY_ATTEMPTS], 20),
    maxAgeMs: envInteger([env.ORKESTR_CONNECTOR_OUTBOX_MAX_AGE_MS], 24 * hourMs),
    backoffMaxMs: envInteger([env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MAX_MS], hourMs),
    sweepIntervalMs: envInteger([env.ORKESTR_CONNECTOR_OUTBOX_RETRY_SWEEP_INTERVAL_MS], 10 * 60_000),
  };
}

// Exponential backoff: base, 2x base, 4x base ... capped at backoffMaxMs.
export function connectorOutboxRetryDelayMs(attemptCount = 1, env = process.env) {
  const base = connectorOutboxRetryBackoffMs(env);
  const { backoffMaxMs } = connectorOutboxRetryPolicy(env);
  const exponent = Math.min(30, Math.max(0, (Number(attemptCount) || 1) - 1));
  return Math.min(Math.max(base, backoffMaxMs), base * 2 ** exponent);
}

function generationMs(job = {}) {
  return Math.max(timeMs(job.createdAt), timeMs(job.metadata?.retryRequestedAt), timeMs(job.metadata?.replayRequestedAt));
}

// Pure: why a job is past its retry budget, or null.
export function connectorOutboxRetryExhausted(job = {}, policy = connectorOutboxRetryPolicy(), nowMs = Date.now()) {
  const state = clean(job.state || "pending").toLowerCase();
  if (!retryPolicyStates.includes(state)) return null;
  const attempts = Number(job.attemptCount || 0) || 0;
  // An operator retry reopens a job as pending; only a failed attempt counts here.
  // The scanner suppresses over-retried jobs it still revisits (and updates their
  // intent), so only archive ones it left untouched for a full backoff window.
  const idle = nowMs - timeMs(job.updatedAt) > Math.max(policy.backoffMaxMs, 60_000);
  if (state === "failed_retryable" && idle && policy.maxAttempts > 0 && attempts >= policy.maxAttempts) return { reason: "connector_outbox_retry_attempts_exhausted", attempts };
  const born = generationMs(job);
  if (policy.maxAgeMs > 0 && born > 0 && nowMs - born > policy.maxAgeMs) {
    return { reason: "connector_outbox_retry_max_age_exceeded", attempts, generationAt: new Date(born).toISOString() };
  }
  return null;
}

export function classifyExhaustedWhatsAppOutbox({ jobs = [], outboundDeliveries = [], outboundIntents = [], policy, nowMs = Date.now() } = {}) {
  const ledger = createConnectorOutboxLedgerIndex(outboundDeliveries, outboundIntents);
  const eligible = [];
  const skipped = { withinBudget: 0, ledgerMatch: 0, partialDelivery: 0 };
  const byReason = {};
  const byState = {};
  for (const job of jobs) {
    if (clean(job.connector).toLowerCase() !== "whatsapp") continue;
    const exhausted = connectorOutboxRetryExhausted(job, policy, nowMs);
    if (!exhausted) { skipped.withinBudget += 1; continue; }
    // Ledger evidence means reconcile marks it delivered; partial sends need review.
    if (ledger.latestDelivery(job) || ledger.latestDeliveredIntent(job)) { skipped.ledgerMatch += 1; continue; }
    if (hasWhatsAppPartialDelivery(job)) { skipped.partialDelivery += 1; continue; }
    const state = clean(job.state || "pending").toLowerCase();
    byReason[exhausted.reason] = (byReason[exhausted.reason] || 0) + 1;
    byState[state] = (byState[state] || 0) + 1;
    eligible.push({ job, state, details: exhausted });
  }
  return { eligible, scanned: jobs.length, skipped, byReason, byState };
}

export async function sweepExhaustedWhatsAppOutbox({ state = {}, apply = false, limit = 500, nowMs = Date.now() } = {}, env = process.env) {
  const policy = connectorOutboxRetryPolicy(env);
  const result = await withConnectorOutboxMutation(env, async () => {
    const listed = await listConnectorOutboxJobs({ connector: "whatsapp", state: retryPolicyStates.join(" ") }, env);
    return classifyExhaustedWhatsAppOutbox({
      jobs: listed.jobs || [],
      outboundDeliveries: Array.isArray(state?.outboundDeliveries) ? state.outboundDeliveries : [],
      outboundIntents: Array.isArray(state?.outboundIntents) ? state.outboundIntents : [],
      policy,
      nowMs,
    });
  });
  const selected = result.eligible.slice(0, Math.max(1, Math.floor(Number(limit) || 500)));
  const archived = apply
    ? await archiveOutboxSelection(selected, { now: new Date(nowMs).toISOString(), operator: "retry-policy", reason: "connector_outbox_retry_budget_exhausted", metadataKey: "retryPolicyArchive" }, env)
    : 0;
  if (archived) {
    await appendEvent({ type: "connector_outbox_retry_budget_archived", connector: "whatsapp", archived, byReason: result.byReason, byState: result.byState }, env).catch(() => {});
  }
  const { eligible, ...summary } = result;
  return { ...summary, policy, eligible: eligible.length, archived, dryRun: !apply, sendsMessages: false };
}

// Throttled automatic sweep for the delivery loop; disabled with interval 0.
export async function maybeSweepExhaustedWhatsAppOutbox(state, env = process.env, home = "") {
  const { sweepIntervalMs } = connectorOutboxRetryPolicy(env);
  if (sweepIntervalMs <= 0) return null;
  const last = lastSweepByHome.get(home) || 0;
  if (Date.now() - last < sweepIntervalMs) return null;
  lastSweepByHome.set(home, Date.now());
  return sweepExhaustedWhatsAppOutbox({ state, apply: true }, env);
}
