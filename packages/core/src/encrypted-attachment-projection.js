const encryptedAttachmentAllowedFields = new Set([
  "id",
  "name",
  "filename",
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

export function publicEncryptedAttachment(attachment = {}) {
  if (attachment?.encrypted !== true) return attachment;
  return Object.fromEntries(
    Object.entries(attachment).filter(([key]) => encryptedAttachmentAllowedFields.has(key)),
  );
}

export function publicEncryptedAttachmentMessage(message = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.some((attachment) => attachment?.encrypted === true)) return message;
  return {
    ...message,
    attachments: attachments.map(publicEncryptedAttachment),
  };
}
