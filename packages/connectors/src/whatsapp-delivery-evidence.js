import { createHash } from "node:crypto";

const stages = new Set(["preflight", "prepare_media", "send_text", "send_media", "confirm_media", "unknown"]);
const codes = new Set(["attachment_missing", "attachment_inaccessible", "attachment_too_large", "attachment_invalid", "media_timeout", "media_ack_missing", "runtime_closed", "provider_evaluation_failed", "provider_rejected", "media_prepare_failed", "whatsapp_send_failed"]);
const outcomes = new Set(["sent", "not_attempted", "failed_preflight", "uncertain"]);
const id = value => typeof value === "string" && /^[a-zA-Z0-9_@.:-]{1,240}$/.test(value) ? value : "";

// Never transport a raw provider exception: it can contain paths, URLs or tokens.
export function whatsappFailureEvidence(error, stage = "unknown") {
  const message = String(error?.message || "");
  const code = error?.code === "ENOENT" ? "attachment_missing"
    : ["EACCES", "EPERM"].includes(error?.code) ? "attachment_inaccessible"
    : codes.has(message) ? message
    : /timeout/i.test(message) ? "media_timeout"
    : /target closed|session closed|detached frame/i.test(message) ? "runtime_closed"
    : /evaluation failed/i.test(message) ? "provider_evaluation_failed"
    : /rejected|upload.failed/i.test(message) ? "provider_rejected"
    : stage === "prepare_media" ? "media_prepare_failed" : "whatsapp_send_failed";
  return { failureCode: code, stage: stages.has(stage) ? stage : "unknown",
    failureFingerprint: createHash("sha256").update(message.slice(0, 8192)).digest("hex").slice(0, 24) };
}

export function publicWhatsAppPartialDelivery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sent = (Array.isArray(value.sent) ? value.sent : []).slice(0, 101)
    .filter(entry => entry && ["text", "attachment"].includes(entry.kind))
    .map(entry => ({ id: id(entry.id), kind: entry.kind,
      ...(Number.isInteger(entry.index) && entry.index >= 0 && entry.index < 100 ? { index: entry.index } : {}) }));
  const attachments = (Array.isArray(value.attachments) ? value.attachments : []).slice(0, 100)
    .filter(entry => entry && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < 100 && outcomes.has(entry.outcome))
    .map(entry => ({ index: entry.index, outcome: entry.outcome, ...(id(entry.id) ? { id: id(entry.id) } : {}) }));
  return { sent, attachments, failedKind: value.failedKind === "attachment" ? "attachment" : "message",
    failureCode: codes.has(value.failureCode) ? value.failureCode : "whatsapp_send_failed",
    stage: stages.has(value.stage) ? value.stage : "unknown",
    ...(typeof value.failureFingerprint === "string" && /^[a-f0-9]{24}$/.test(value.failureFingerprint) ? { failureFingerprint: value.failureFingerprint } : {}),
    retrySuppressed: true };
}

// Report only. No dispatch, storage mutation, text replay or uncertain-ack retry.
// Callers must supply the owner-scoped outbox, and all bindings must match.
export function reportWhatsAppAttachmentRecovery(jobs, { ownerUserId, threadId, accountId, since, until }) {
  const from = Date.parse(since), to = Date.parse(until);
  if (!ownerUserId || !threadId || !accountId || !Number.isFinite(from) || !Number.isFinite(to) || from > to) throw Error("attachment_recovery_scope_required");
  return jobs.filter(job => job.connector === "whatsapp" && job.ownerUserId === ownerUserId && job.threadId === threadId && job.accountId === accountId
    && ["partial_delivery", "dead_letter", "delivery_uncertain"].includes(job.state)
    && Date.parse(job.createdAt) >= from && Date.parse(job.createdAt) <= to)
    .map(job => {
      const evidence = publicWhatsAppPartialDelivery(job.metadata?.partialDelivery || job.brokerAck?.partialDelivery);
      return { jobId: job.id, state: job.state, automaticReplay: false,
        reviewRequired: true, sent: evidence?.sent || [], attachments: evidence?.attachments || [],
        reason: evidence ? "verify_newest_revision_and_confirm_missing_files_before_new_send" : "missing_evidence_do_not_replay" };
    });
}
