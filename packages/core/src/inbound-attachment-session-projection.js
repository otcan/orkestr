const lifecycleStates = new Set(["receiving", "quarantined", "validating", "scanning", "ready", "claiming", "claimed", "rejected", "retryable", "cancelled", "expired"]);
const publicErrorCodes = new Set([
  "cancelled_by_user",
  "inbound_upload_ciphertext_invalid",
  "inbound_upload_ciphertext_missing",
  "inbound_upload_ciphertext_tampered",
  "inbound_upload_descriptor_expired",
  "inbound_upload_descriptor_invalid",
  "inbound_upload_key_unavailable",
  "inbound_upload_permission_recheck_failed",
  "inbound_upload_processing_failed",
  "inbound_upload_session_expired",
  "inbound_upload_scanner_rejected",
  "inbound_upload_scanner_unavailable",
  "inbound_upload_worker_verdict_binding_invalid",
  "inbound_upload_worker_verdict_invalid",
  "inbound_upload_worker_verdict_stale",
  "inbound_upload_worker_verdict_untrusted",
  "inbound_upload_superseded",
  "plaintext_lease_expired",
  "restart_reconciliation_required",
]);

function clean(value = "") {
  return String(value || "").trim();
}

export function inboundAttachmentUploadState(value = "") {
  const state = clean(value);
  return lifecycleStates.has(state) ? state : "receiving";
}

function publicAttachment(session = {}) {
  if (!["ready", "claimed"].includes(session.state) || !session.release?.path) return null;
  return {
    id: clean(session.release.attachmentId),
    name: clean(session.release.filename),
    filename: clean(session.release.filename),
    mimetype: clean(session.release.mimetype),
    size: Number(session.release.size || 0),
    checksum: clean(session.release.checksum),
    path: clean(session.release.path),
    saved_path: clean(session.release.path),
    source: "browser_encrypted_inbound",
    uploadSessionId: clean(session.id),
    inboundUpload: {
      state: session.state,
      sessionId: clean(session.id),
      scannedAt: clean(session.release.scannedAt),
      keyVersion: Number(session.keyVersion || 0),
    },
  };
}

export function publicInboundAttachmentUploadSession(session = {}) {
  return {
    id: clean(session.id),
    state: inboundAttachmentUploadState(session.state),
    keyId: clean(session.keyId),
    keyVersion: Number(session.keyVersion || 0),
    expiresAt: clean(session.expiresAt),
    updatedAt: clean(session.updatedAt || session.createdAt),
    retryable: session.state === "retryable",
    error: publicErrorCodes.has(clean(session.error)) ? clean(session.error) : "",
    attachment: publicAttachment(session),
  };
}
