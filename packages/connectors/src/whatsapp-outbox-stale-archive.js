// Operator maintenance: archive stale, unresolved WhatsApp connector-outbox jobs.
//
// Jobs that sit in pending/failed_retryable/delivery_uncertain for days and have
// no matching delivery-ledger evidence are rescanned on every delivery pass. This
// moves them to the terminal "archived" state (never deleted, never pruned by
// retention, updatedAt preserved). It never sends or replays anything. Dry-run is
// the default; apply requires an explicit flag.
import { connectorOutboxRetentionLimit, getConnectorOutboxJob, listConnectorOutboxJobs, markConnectorOutboxJob, archivedState, retentionPrunableStates } from "./connector-outbox.js";
import { withConnectorOutboxMutation } from "./connector-outbox-lock.js";
import { createConnectorOutboxLedgerIndex } from "./whatsapp-outbox-ledger-match.js";
import { hasWhatsAppPartialDelivery } from "./whatsapp-replay-safety.js";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson } from "../../storage/src/store.js";

export const staleOutboxStates = ["pending", "failed_retryable", "delivery_uncertain"];
const dayMs = 86_400_000;
const minimumOlderThanMs = dayMs;
const ageBuckets = [[7, "1-7d"], [14, "7-14d"], [30, "14-30d"], [90, "30-90d"], [Infinity, "90d+"]];
const clean = (value) => String(value ?? "").trim();

export function parseOlderThan(value = "7d") {
  const match = /^(\d+(?:\.\d+)?)\s*(d|h|m)?$/i.exec(clean(value) || "7d");
  if (!match) throw Object.assign(new Error("stale_outbox_older_than_invalid"), { statusCode: 400 });
  const unit = { d: dayMs, h: 3_600_000, m: 60_000 }[(match[2] || "d").toLowerCase()];
  const ms = Number(match[1]) * unit;
  if (!(ms >= minimumOlderThanMs)) throw Object.assign(new Error("stale_outbox_older_than_below_minimum_1d"), { statusCode: 400 });
  return ms;
}

function lastActivityMs(job = {}) {
  const times = [job.createdAt, job.updatedAt, job.failedAt].map((value) => Date.parse(clean(value))).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

function ageBucket(ageMs) {
  const days = ageMs / dayMs;
  return ageBuckets.find(([limit]) => days < limit)[1];
}

// Pure classification so dry-run and apply decide identically.
export function classifyStaleWhatsAppOutbox({ jobs = [], outboundDeliveries = [], outboundIntents = [], olderThanMs, nowMs = Date.now() } = {}) {
  const ledger = createConnectorOutboxLedgerIndex(outboundDeliveries, outboundIntents);
  const eligible = [];
  const skipped = { recent: 0, ledgerMatch: 0, partialDelivery: 0, missingTimestamp: 0, otherState: 0 };
  const byState = {};
  const byAge = {};
  for (const job of jobs) {
    const state = clean(job.state || "pending").toLowerCase();
    if (clean(job.connector).toLowerCase() !== "whatsapp" || !staleOutboxStates.includes(state)) { skipped.otherState += 1; continue; }
    const activity = lastActivityMs(job);
    if (!Number.isFinite(activity)) { skipped.missingTimestamp += 1; continue; }
    const ageMs = nowMs - activity;
    if (ageMs < olderThanMs) { skipped.recent += 1; continue; }
    // Ledger evidence means the reconcile pass can mark it delivered; leave it.
    if (ledger.latestDelivery(job) || ledger.latestDeliveredIntent(job)) { skipped.ledgerMatch += 1; continue; }
    if (hasWhatsAppPartialDelivery(job)) { skipped.partialDelivery += 1; continue; }
    const bucket = ageBucket(ageMs);
    const entry = byState[state] ||= { count: 0, oldest: "", newest: "" };
    const at = new Date(activity).toISOString();
    entry.count += 1;
    if (!entry.oldest || at < entry.oldest) entry.oldest = at;
    if (!entry.newest || at > entry.newest) entry.newest = at;
    byAge[bucket] = (byAge[bucket] || 0) + 1;
    eligible.push({ job, state, lastActivityAt: at });
  }
  return { eligible, scanned: jobs.length, skipped, byState, byAge };
}

function archivePatch(job, fromState, { now, operator, reason, olderThan }) {
  const uncertain = fromState === "delivery_uncertain" || job.metadata?.deliveryUncertain === true;
  return {
    state: archivedState,
    updatedAt: job.updatedAt,
    terminalAt: now,
    claimedBy: "",
    claimedAt: "",
    claimExpiresAt: "",
    error: clean(job.error) || "stale_outbox_archived",
    metadata: {
      ...(job.metadata || {}),
      // Reopening a possibly-sent job still needs the explicit uncertain override.
      ...(uncertain ? { deliveryUncertain: true } : {}),
      staleArchive: { archivedAt: now, archivedBy: operator, fromState, olderThan, reason },
    },
  };
}

export async function archiveStaleWhatsAppOutbox(options = {}, env = process.env) {
  const olderThan = clean(options.olderThan) || "7d";
  const olderThanMs = parseOlderThan(olderThan);
  const apply = options.apply === true;
  const limit = Math.max(1, Math.floor(Number(options.limit) || 2000));
  const operator = clean(options.operator) || "operator";
  const reason = clean(options.reason) || "stale_unresolved_outbox";
  const nowMs = Date.now();
  const result = await withConnectorOutboxMutation(env, async () => {
    const listed = await listConnectorOutboxJobs({ connector: "whatsapp", state: staleOutboxStates.join(" ") }, env);
    const ledgerState = await readJson(dataPaths(env).whatsapp, {});
    return classifyStaleWhatsAppOutbox({
      jobs: listed.jobs || [],
      outboundDeliveries: Array.isArray(ledgerState?.outboundDeliveries) ? ledgerState.outboundDeliveries : [],
      outboundIntents: Array.isArray(ledgerState?.outboundIntents) ? ledgerState.outboundIntents : [],
      olderThanMs,
      nowMs,
    });
  });
  // Oldest first, so a bounded run always makes progress on the worst backlog.
  const selected = result.eligible.sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt)).slice(0, limit);
  let archived = 0;
  if (apply) {
    const now = new Date(nowMs).toISOString();
    for (const { job, state } of selected) {
      // Lock per job so live deliveries interleave with a long archive run.
      archived += await withConnectorOutboxMutation(env, async () => {
        const current = await getConnectorOutboxJob(job.id, env);
        // Skip anything that moved since it was listed (claimed, delivered, retried).
        if (!current || clean(current.state).toLowerCase() !== state || current.updatedAt !== job.updatedAt) return 0;
        await markConnectorOutboxJob(job.id, archivePatch(current, state, { now, operator, reason, olderThan }), env);
        return 1;
      });
    }
    await appendEvent({ type: "connector_outbox_stale_archived", connector: "whatsapp", olderThan, archived, byState: result.byState, operator }, env).catch(() => {});
  }
  const terminal = await listConnectorOutboxJobs({ connector: "whatsapp", state: [...retentionPrunableStates].join(" "), limit: 1 }, env);
  return {
    ok: true,
    dryRun: !apply,
    olderThan,
    cutoff: new Date(nowMs - olderThanMs).toISOString(),
    scanned: result.scanned,
    eligible: result.eligible.length,
    selected: selected.length,
    archived,
    limit,
    remainingAfterRun: result.eligible.length - archived,
    byState: result.byState,
    byAge: result.byAge,
    skipped: result.skipped,
    retention: { limit: connectorOutboxRetentionLimit(env), prunableTerminalRows: Number(terminal.total || 0), archivedRowsArePruned: false },
    sendsMessages: false,
    generatedAt: new Date().toISOString(),
  };
}
