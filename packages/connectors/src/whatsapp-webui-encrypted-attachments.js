import { validateEncryptedWhatsAppDeliverySource } from "../../core/src/encrypted-attachment-publication.js";

function clean(value = "") {
  return String(value || "").trim();
}

function deliveryKey(attachment = {}) {
  return clean(attachment.path || attachment.saved_path || attachment.checksum || attachment.id);
}

export async function webUiEncryptedAttachmentDelivery(attachments = [], { thread = {}, env = process.env } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  const protectedAttachments = list.filter((attachment) => attachment?.encrypted === true);
  const ordinaryAttachments = list.filter((attachment) => attachment?.encrypted !== true);
  const recovered = [];
  const unavailable = [];
  for (const attachment of protectedAttachments) {
    const result = await validateEncryptedWhatsAppDeliverySource(attachment, { thread, env });
    if (result.ok) recovered.push(result.attachment);
    else unavailable.push({ id: clean(attachment.id), reason: clean(result.reason) || "whatsapp_source_unavailable" });
  }
  const deduped = new Map();
  for (const attachment of [...ordinaryAttachments, ...recovered]) {
    const key = deliveryKey(attachment);
    if (key) deduped.set(key, attachment);
  }
  return {
    attachments: [...deduped.values()],
    protectedCount: protectedAttachments.length,
    recoveredCount: recovered.length,
    unavailable,
    unavailableCount: unavailable.length,
  };
}

export function appendWebUiEncryptedAttachmentNotice(text = "", unavailableCount = 0) {
  if (!Number.isFinite(Number(unavailableCount)) || Number(unavailableCount) <= 0) return clean(text);
  const body = clean(text);
  const notice = `${Number(unavailableCount)} protected attachment${Number(unavailableCount) === 1 ? " could" : "s could"} not be sent on WhatsApp. ${Number(unavailableCount) === 1 ? "It remains" : "They remain"} available in the Orkestr WebUI.`;
  return body ? `${body}\n\n${notice}` : notice;
}
