const encryptedAttachmentAllowedFields = new Set([
  "id",
  "name",
  "filename",
  "displayFilename",
  "mimetype",
  "size",
  "checksum",
  "downloadable",
  "downloadUrl",
  "encrypted",
  "createdAt",
  "retention",
  "encryption",
]);

function attachmentDisplayFilename(attachment = {}) {
  const candidate = String(
    attachment.displayFilename ||
    attachment.deliverySource?.filename ||
    attachment.deliverySource?.name ||
    "",
  ).trim();
  return candidate.split(/[\\/]/).at(-1)?.replace(/[\r\n]/g, "").trim() || "";
}

export function publicEncryptedAttachment(attachment = {}) {
  if (attachment?.encrypted !== true) return attachment;
  const projected = Object.fromEntries(
    Object.entries(attachment).filter(([key]) => encryptedAttachmentAllowedFields.has(key)),
  );
  const displayFilename = attachmentDisplayFilename(attachment);
  return displayFilename ? { ...projected, displayFilename } : projected;
}

export function publicEncryptedAttachmentMessage(message = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.some((attachment) => attachment?.encrypted === true)) return message;
  return {
    ...message,
    attachments: attachments.map(publicEncryptedAttachment),
  };
}
