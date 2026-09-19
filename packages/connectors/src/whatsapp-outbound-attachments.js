import { isRemoteThreadAttachmentDescriptor, redactDeniedThreadAttachmentPaths, resolveThreadAttachments } from "../../core/src/thread-attachments.js";
import { hydrateEncryptedPublishedAttachmentPaths } from "../../core/src/encrypted-attachment-publication.js";
import { materializeRemoteWhatsAppAttachments } from "./whatsapp-remote-artifacts.js";
import { prepareWhatsAppTableAttachments } from "./whatsapp-table-attachments.js";
import { appendWebUiEncryptedAttachmentNotice, webUiEncryptedAttachmentDelivery } from "./whatsapp-webui-encrypted-attachments.js";
import { formatWhatsAppOutboundText } from "./whatsapp-formatting.js";

const pickString = (...values) => values.map(value => String(value || "").trim()).find(Boolean) || "";

// Both progress and final replies must use the same ownership and publication checks.
export async function prepareWhatsAppOutboundAttachments({ thread, message, principal, env, fetchImpl }) {
  const prepared = await prepareWhatsAppTableAttachments(pickString(message.text), { env, messageId: message.id });
  const sourceMessageAttachments = hydrateEncryptedPublishedAttachmentPaths(
    thread, Array.isArray(message.attachments) ? message.attachments : [], env);
  const remote = await materializeRemoteWhatsAppAttachments({
    thread, message, attachments: sourceMessageAttachments, env, fetchImpl,
  });
  const resolved = await resolveThreadAttachments({
    thread, text: pickString(message.text),
    attachments: [
      ...sourceMessageAttachments.filter(attachment => !isRemoteThreadAttachmentDescriptor(attachment)),
      ...remote.attachments, ...prepared.attachments,
    ], env,
  });
  const protectedDelivery = await webUiEncryptedAttachmentDelivery(resolved.attachments, { thread, env });
  const body = appendWebUiEncryptedAttachmentNotice(
    appendLocalAttachmentFailureNotes(prepared.text, resolved.skipped), protectedDelivery.unavailableCount);
  const formatted = formatWhatsAppOutboundText(redactDeniedThreadAttachmentPaths(body, { thread, principal, env }));
  return {
    text: appendRemoteAttachmentFailureNotes(formatted, remote.skipped),
    attachments: protectedDelivery.attachments,
    sourceMessageAttachments,
  };
}

function remoteAttachmentFailureReason(reason = "") {
  return String(reason || "remote_attachment_unavailable").replace(/^remote_attachment_/, "").replace(/^remote_/, "").replace(/_/g, " ");
}

function appendRemoteAttachmentFailureNotes(text = "", skipped = []) {
  const failures = (Array.isArray(skipped) ? skipped : [])
    .map((item) => {
      const filename = pickString(item.filename, item.remoteAttachmentId, "attachment");
      const reason = remoteAttachmentFailureReason(item.reason);
      return `${filename}: ${reason}`;
    })
    .filter(Boolean);
  if (!failures.length) return text;
  return [
    String(text || "").trim(),
    "",
    "Attachment not sent:",
    ...failures.map((line) => `- ${line}`),
  ].filter((line, index) => index !== 0 || line).join("\n");
}

function localAttachmentFailureReason(reason = "") {
  return String(reason || "attachment_unavailable").replace(/_/g, " ");
}

export function appendLocalAttachmentFailureNotes(text = "", skipped = []) {
  const seen = new Set();
  const failures = (Array.isArray(skipped) ? skipped : [])
    .map((item) => {
      const filePath = pickString(item.raw, item.path);
      if (!filePath) return "";
      const reason = localAttachmentFailureReason(item.reason);
      const key = `${filePath}\n${reason}`;
      if (seen.has(key)) return "";
      seen.add(key);
      return `${filePath}: ${reason}`;
    })
    .filter(Boolean);
  if (!failures.length) return text;
  return [
    String(text || "").trim(),
    "",
    "Attachment not sent:",
    ...failures.map((line) => `- ${line}`),
  ].filter((line, index) => index !== 0 || line).join("\n");
}

