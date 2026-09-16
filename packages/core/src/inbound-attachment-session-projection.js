const lifecycleStates = new Set(["receiving", "quarantined", "validating", "scanning", "ready", "rejected", "retryable", "cancelled", "expired"]);

function clean(value = "") {
  return String(value || "").trim();
}

export function inboundAttachmentUploadState(value = "") {
  const state = clean(value);
  return lifecycleStates.has(state) ? state : "receiving";
}

function publicAttachment(session = {}) {
  if (session.state !== "ready" || !session.release?.path) return null;
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
    inboundUpload: {
      state: "ready",
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
    error: clean(session.error),
    attachment: publicAttachment(session),
  };
}
