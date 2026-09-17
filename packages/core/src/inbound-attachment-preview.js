import { resolveInboundAttachmentSession } from "./inbound-attachment-quarantine.js";
import { publicInboundAttachmentUploadSession } from "./inbound-attachment-session-projection.js";
import { encryptedAttachmentPreview } from "./attachment-preview.js";

export async function inboundAttachmentPreviewStream({ sessionId, principal, env = process.env } = {}) {
  const { session, thread } = await resolveInboundAttachmentSession(sessionId, principal, env);
  if (session.state === "ready" && !(Date.parse(session.release?.expiresAt || "") > Date.now())) {
    throw Object.assign(new Error("inbound_upload_session_expired"), { statusCode: 410 });
  }
  const attachment = publicInboundAttachmentUploadSession(session).attachment;
  if (!attachment) throw Object.assign(new Error("attachment_preview_not_ready"), { statusCode: 409 });
  return encryptedAttachmentPreview({ thread, attachment, env });
}
