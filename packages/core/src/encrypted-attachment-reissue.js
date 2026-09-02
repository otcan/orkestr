import fs from "node:fs/promises";
import { appendEvent } from "../../storage/src/store.js";
import { resolveThreadAttachments } from "./thread-attachments.js";
import {
  encryptedPublishedAttachmentPath,
  publishThreadAttachmentsEncrypted,
} from "./encrypted-attachment-publication.js";
import { listThreadMessages, updateThreadMessage } from "./threads.js";

function clean(value = "") {
  return String(value || "").trim();
}

function failure(reason, statusCode = 409) {
  const error = new Error(reason);
  error.statusCode = statusCode;
  return error;
}

export async function reissueEncryptedThreadAttachment({ thread = {}, attachmentId = "", env = process.env } = {}) {
  const wanted = clean(attachmentId);
  const current = (await listThreadMessages(thread.id, env)).find((candidate) =>
    (Array.isArray(candidate.attachments) ? candidate.attachments : []).some((attachment) => clean(attachment.id) === wanted));
  if (!current) throw failure("attachment_not_found", 404);
  const attachments = Array.isArray(current.attachments) ? current.attachments : [];
  const attachment = attachments.find((candidate) => clean(candidate.id) === wanted);
  if (!attachment || attachment.encrypted !== true) throw failure("attachment_not_encrypted", 409);
  const sourceAttachmentId = clean(attachment.sourceAttachmentId);
  if (!sourceAttachmentId) throw failure("attachment_reissue_source_unavailable", 409);

  const resolved = await resolveThreadAttachments({ thread, text: current.text, attachments: [], env });
  const source = resolved.attachments.find((candidate) => clean(candidate.id) === sourceAttachmentId);
  if (!source) throw failure("attachment_reissue_source_unavailable", 409);
  const publication = await publishThreadAttachmentsEncrypted({ thread, attachments: [source], env });
  const replacement = publication.attachments[0];
  if (!replacement?.encrypted) throw failure("attachment_reissue_failed", 409);

  let updated;
  try {
    updated = await updateThreadMessage(thread.id, current.id, {
      attachments: attachments.map((candidate) => clean(candidate.id) === wanted ? replacement : candidate),
    }, env);
  } catch (error) {
    const replacementPath = encryptedPublishedAttachmentPath(thread, replacement, env);
    if (replacementPath) await fs.rm(replacementPath, { force: true }).catch(() => {});
    throw error;
  }
  const oldPath = encryptedPublishedAttachmentPath(thread, attachment, env);
  if (oldPath) await fs.rm(oldPath, { force: true }).catch(() => {});
  await appendEvent({
    type: "thread_attachment_encrypted_reissued",
    threadId: clean(thread.id),
    messageId: clean(current.id),
    previousAttachmentId: wanted,
    attachmentId: clean(replacement.id),
    recipientIds: Array.isArray(replacement.encryption?.recipientIds) ? replacement.encryption.recipientIds : [],
  }, env).catch(() => {});
  return { message: updated, attachment: replacement };
}
