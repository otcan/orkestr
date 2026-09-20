import { createHash } from "node:crypto";
import { hasWhatsAppPartialDelivery, requiresWhatsAppUncertainOverride } from "./whatsapp-replay-safety.js";
import { classifyWhatsAppBridgeFailure } from "./whatsapp-bridge-diagnostics.js";
import { listConnectorOutboxJobs } from "./connector-outbox.js";
import { withConnectorOutboxMutation } from "./connector-outbox-lock.js";
import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { withThreadMessageMutation } from "../../core/src/thread-message-mutation.js";
import { getThread } from "../../core/src/threads.js";

const clean = value => String(value ?? "").trim();
const generation = row => clean(row.codexThreadId || row.executorThreadId);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const belongs = (row, scope) => row.ownerUserId === scope.ownerUserId && row.threadId === scope.threadId &&
  row.accountId === scope.accountId && row.chatId === scope.chatId && row.connector === "whatsapp";
const availabilityCodes = new Set(["whatsapp_local_bridge_not_ready", "whatsapp_local_bridge_stale_runtime"]);
function availabilityFailure(job) {
  const evidence = job.metadata?.bridgeFailure || {};
  const code = clean(evidence.failureCode || job.metadata?.failureCode || job.error);
  const status = evidence.status || job.metadata?.httpStatus || 0;
  return availabilityCodes.has(code) && classifyWhatsAppBridgeFailure({ status, payload: { code } }).retryable;
}

function exactLineage(left, right) {
  if (!left.payloadHash || left.payloadHash !== right.payloadHash || !left.sourceRevision ||
      left.sourceRevision !== right.sourceRevision || !left.metadata?.runtimeGeneration ||
      left.metadata.runtimeGeneration !== right.metadata?.runtimeGeneration) return false;
  if (left.sourceMessageId && left.sourceMessageId === right.sourceMessageId) return true;
  // Different source rows need the canonical projection's durable trace AND
  // exact body identity. Text similarity, parent IDs and timestamps never join.
  return Boolean(left.metadata.canonicalFinalProjection === true && right.metadata.canonicalFinalProjection === true &&
    left.metadata.routerTraceId && left.metadata.routerTraceId === right.metadata.routerTraceId &&
    left.metadata.bodyKey && left.metadata.bodyKey === right.metadata.bodyKey);
}

export function auditWhatsAppRecovery({ jobs, messages, complete = false }, scope) {
  if (!scope || !["ownerUserId", "threadId", "accountId", "chatId", "runtimeGeneration"].every(key => clean(scope[key])) ||
      !Number.isFinite(Date.parse(scope.since)) || !Number.isFinite(Date.parse(scope.until)) ||
      Date.parse(scope.since) > Date.parse(scope.until)) throw new Error("recovery_audit_scope_required");
  if (!Array.isArray(jobs) || !Array.isArray(messages) || jobs.length > 10_000 || messages.length > 100_000 ||
      jobs.some(row => !row?.id) || messages.some(row => !row?.id)) throw new Error("recovery_audit_invalid_inventory");
  const scoped = jobs.filter(job => belongs(job, scope) && job.deliveryType === "final");
  const sourceRows = new Map(), jobsById = new Map(), jobsBySource = new Map(), jobsByTrace = new Map();
  const add = (map, key, row) => { if (key) map.set(key, [...(map.get(key) || []), row]); };
  for (const row of messages) add(sourceRows, row.id, row);
  for (const row of scoped) {
    add(jobsById, row.id, row); add(jobsBySource, row.sourceMessageId, row);
    if (row.metadata?.canonicalFinalProjection === true) add(jobsByTrace, row.metadata.routerTraceId, row);
  }
  const rows = [];
  const counts = { eligible: 0, replayed: 0, skipped: 0, duplicate: 0, unresolved: 0, delivered: 0 };
  for (const job of scoped) {
    let disposition = "unresolved", reason = "lineage_not_proven";
    const created = Date.parse(job.createdAt);
    const sources = (sourceRows.get(job.sourceMessageId) || []).filter(row => row.ownerUserId === scope.ownerUserId &&
      (!row.threadId || row.threadId === scope.threadId) && generation(row) === scope.runtimeGeneration &&
      row.role === "assistant" && row.phase === "final_answer" && row.state === "completed" && !row.supersededBy);
    const related = [...new Set([...(jobsBySource.get(job.sourceMessageId) || []),
      ...(job.metadata?.canonicalFinalProjection === true ? jobsByTrace.get(job.metadata.routerTraceId) || [] : [])])];
    const lineage = related.filter(row => exactLineage(job, row));
    if (job.state === "delivered") { disposition = "delivered"; reason = "recorded_delivery"; }
    else if (["cancelled", "suppressed", "skipped", "skipped_policy"].includes(job.state)) {
      disposition = "skipped"; reason = "terminal_disposition";
    } else if (hasWhatsAppPartialDelivery(job) || requiresWhatsAppUncertainOverride(job) ||
        ["claimed", "sent_to_broker"].includes(job.state)) reason = "partial_uncertain_or_inflight";
    else if (!Number.isFinite(created)) reason = "missing_incident_timestamp";
    else if (created < Date.parse(scope.since) || created > Date.parse(scope.until)) {
      disposition = "skipped"; reason = "outside_incident_window";
    } else if (complete !== true) reason = "incomplete_inventory";
    else if (job.metadata?.runtimeGeneration !== scope.runtimeGeneration || sources.length !== 1 ||
        jobsById.get(job.id).length !== 1) reason = "ambiguous_source_or_generation";
    else if (!job.payloadHash || !job.sourceRevision) reason = "missing_payload_revision";
    else if (lineage.some(row => row.id !== job.id && row.state === "delivered")) {
      disposition = "duplicate"; reason = "exact_delivered_lineage";
    } else if (related.some(row => row.id !== job.id && !exactLineage(job, row))) reason = "conflicting_lineage_revision";
    else if (lineage.some(row => row.id !== job.id)) reason = "multiple_unresolved_lineage_records";
    else if (job.metadata?.nonRetryable === true || job.metadata?.retrySuppressed === true) reason = "retry_suppressed";
    else if (["failed_retryable", "dead_letter"].includes(job.state) && availabilityFailure(job)) {
      disposition = "eligible"; reason = "incident_availability_failure_review_required";
    } else if (job.state === "pending") reason = "pending_shadow_not_proven_unsent";
    else reason = "failure_requires_manual_review";
    counts[disposition] += 1;
    rows.push({ jobId: job.id, sourceMessageId: job.sourceMessageId, disposition, reason, automaticReplay: false });
  }
  return { version: 1, scope, dryRun: true, automaticReplay: false, complete: complete === true,
    counts, rows, snapshotDigest: digest({ jobs: scoped, messages: messages.filter(row =>
      row.ownerUserId === scope.ownerUserId && (!row.threadId || row.threadId === scope.threadId)) }) };
}

export async function reportWhatsAppRecovery(scope, env = process.env) {
  const thread = await getThread(scope.threadId, env);
  if (!thread || thread.id !== scope.threadId || thread.ownerUserId !== scope.ownerUserId) throw new Error("recovery_audit_owner_mismatch");
  return withThreadMessageMutation(thread.id, env, () => withConnectorOutboxMutation(env, async () => {
    const listed = await listConnectorOutboxJobs({ connector: "whatsapp", ownerUserId: scope.ownerUserId,
      threadId: scope.threadId, accountId: scope.accountId, chatId: scope.chatId, deliveryType: "final", limit: 10_000 }, env);
    const messages = await createThreadMessageRepository(env).list(thread.id);
    return auditWhatsAppRecovery({ jobs: listed.jobs, messages, complete: listed.total === listed.jobs.length }, scope);
  }));
}
