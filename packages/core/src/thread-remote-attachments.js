import crypto from "node:crypto";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function remoteAttachmentId(attachment = {}) {
  return pickString(attachment.remoteAttachmentId, attachment.remoteArtifactId, attachment.artifactId);
}

export function isRemoteThreadAttachmentDescriptor(attachment = {}) {
  if (["path", "saved_path", "filePath", "localPath"].some((key) => pickString(attachment?.[key]))) return false;
  const source = pickString(attachment.source).toLowerCase();
  return attachment.remote === true ||
    source === "remote_runtime_attachment" ||
    source === "remote_artifact" ||
    Boolean(remoteAttachmentId(attachment));
}

function remoteAttachmentDescriptorId(attachment = {}) {
  const existing = pickString(attachment.id);
  if (existing) return existing;
  const key = [
    pickString(attachment.remoteBackend),
    pickString(attachment.remoteThreadId),
    pickString(attachment.remoteMessageId),
    remoteAttachmentId(attachment),
  ].join("\n");
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return `ratt_${hash.slice(0, 32)}`;
}

export function metadataForRemoteAttachment(attachment = {}, { safeFileName, inferMimeType, inferKind } = {}) {
  if (!isRemoteThreadAttachmentDescriptor(attachment)) return null;
  const remoteId = remoteAttachmentId(attachment);
  const remoteThreadId = pickString(attachment.remoteThreadId);
  if (!remoteId || !remoteThreadId) return null;
  const filename = safeFileName(pickString(attachment.filename, attachment.name, remoteId));
  const mimetype = inferMimeType(filename, pickString(attachment.mimetype, attachment.type));
  const remoteDownloadUrl = pickString(attachment.remoteDownloadUrl, attachment.downloadUrl);
  return {
    id: remoteAttachmentDescriptorId(attachment),
    kind: inferKind(mimetype, attachment.kind),
    filename,
    name: pickString(attachment.name, filename),
    mimetype,
    size: Number(attachment.size || 0) || 0,
    source: pickString(attachment.source, "remote_runtime_attachment"),
    downloadable: false,
    remote: true,
    remoteBackend: pickString(attachment.remoteBackend),
    remoteThreadId,
    remoteMessageId: pickString(attachment.remoteMessageId),
    remoteAttachmentId: remoteId,
    ...(pickString(attachment.remoteArtifactId, attachment.artifactId) ? { remoteArtifactId: pickString(attachment.remoteArtifactId, attachment.artifactId) } : {}),
    ...(remoteDownloadUrl ? { remoteDownloadUrl } : {}),
    ...(pickString(attachment.sha256) ? { sha256: pickString(attachment.sha256) } : {}),
  };
}
