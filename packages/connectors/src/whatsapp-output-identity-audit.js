import { createHash } from "node:crypto";
import { logicalOutputKey, runtimeOutputMetadata } from "../../shared/src/runtime-output-identity.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Pure, bounded report over an explicitly scoped snapshot. It has no transport,
// hydration, store writer or apply mode. Fingerprints never contain raw event
// IDs (legacy events can embed private message text).
export function auditWhatsAppOutputIdentity({ jobs = [], messages = [], complete = false }, scope) {
  for (const field of ["ownerUserId", "threadId", "accountId", "chatId", "since", "until"]) {
    if (!scope?.[field]) throw new Error("output_audit_scope_required");
  }
  const since = Date.parse(scope.since), until = Date.parse(scope.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("output_audit_window_invalid");
  if (jobs.length > 10000 || messages.length > 100000) throw new Error("output_audit_inventory_limit");
  const selected = jobs.filter(job => job.connector === "whatsapp" && job.deliveryType === "final" &&
    ["ownerUserId", "threadId", "accountId", "chatId"].every(key => job[key] === scope[key]) &&
    Date.parse(job.createdAt) >= since && Date.parse(job.createdAt) <= until);
  const groups = new Map();
  const unresolved = [];
  for (const job of selected) {
    const projections = messages.filter(row => row.id === job.sourceMessageId && row.ownerUserId === scope.ownerUserId &&
      (!row.threadId || row.threadId === scope.threadId));
    let metadata = job.metadata || {};
    try {
      if (projections.length === 1) {
        const runtime = runtimeOutputMetadata(projections[0]);
        for (const key of Object.keys(runtime)) if (metadata[key] && runtime[key] && metadata[key] !== runtime[key]) {
          throw new Error("conflicting_projection");
        }
        metadata = { ...metadata, ...Object.fromEntries(Object.entries(runtime).filter(([, value]) => value)) };
      }
      const key = logicalOutputKey({ ...job, metadata });
      if (!key || projections.length > 1) throw new Error("ambiguous_projection");
      const group = groups.get(key) || { outputFingerprint: key, jobFingerprints: [], projectionFingerprints: new Set(),
        states: {}, receiptSets: new Set(), missingReceipts: 0 };
      group.jobFingerprints.push(digest(job.id));
      group.projectionFingerprints.add(digest(job.sourceMessageId));
      group.states[job.state] = (group.states[job.state] || 0) + 1;
      const ids = job.brokerAck?.ids;
      if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === "string" && id)) {
        group.receiptSets.add(digest([...new Set(ids)].sort()));
      } else group.missingReceipts++;
      groups.set(key, group);
    } catch {
      unresolved.push({ jobFingerprint: digest(job.id), reason: "missing_or_conflicting_identity" });
    }
  }
  return { version: 1, reportOnly: true, automaticReplay: false, automaticRepair: false, complete: complete === true,
    scopeFingerprint: digest(scope), snapshotDigest: digest({ selected, messages }), selectedJobs: selected.length,
    groups: [...groups.values()].map(group => ({ ...group, projectionFingerprints: [...group.projectionFingerprints],
      distinctReceiptSets: group.receiptSets.size, receiptSets: undefined,
      disposition: "operator_review_only", reason: complete !== true ? "incomplete_inventory" :
        group.missingReceipts ? "receipt_evidence_incomplete" : group.receiptSets.size > 1 ? "multiple_receipt_sets" :
        group.jobFingerprints.length > 1 ? "shared_receipt_aliases" : "single_logical_output" })), unresolved };
}
