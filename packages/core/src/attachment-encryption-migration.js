import { appendEvent } from "../../storage/src/store.js";
import { getThread, listThreadMessages, updateThreadMessage } from "./threads.js";
import { publishThreadAttachmentsEncrypted } from "./encrypted-attachment-publication.js";

function clean(value = "") {
  return String(value || "").trim();
}

export async function planThreadAttachmentEncryptionMigration(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messages = await listThreadMessages(thread.id, env);
  const candidates = [];
  const alreadyEncrypted = [];
  for (const message of messages) {
    if (clean(message.role).toLowerCase() !== "assistant") continue;
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const plaintext = attachments.filter((attachment) => attachment.encrypted !== true);
    const encrypted = attachments.filter((attachment) => attachment.encrypted === true);
    if (plaintext.length) candidates.push({ messageId: message.id, attachmentIds: plaintext.map((attachment) => clean(attachment.id)).filter(Boolean), count: plaintext.length });
    if (encrypted.length) alreadyEncrypted.push({ messageId: message.id, count: encrypted.length });
  }
  return {
    threadId: thread.id,
    candidateMessages: candidates.length,
    candidateAttachments: candidates.reduce((sum, candidate) => sum + candidate.count, 0),
    alreadyEncryptedAttachments: alreadyEncrypted.reduce((sum, candidate) => sum + candidate.count, 0),
    candidates,
    reencryptExistingCiphertext: "client_assisted_required",
  };
}

export async function migrateThreadAttachmentsToEncryption(threadId, options = {}, env = process.env) {
  const plan = await planThreadAttachmentEncryptionMigration(threadId, env);
  if (options.dryRun !== false) return { ok: true, dryRun: true, plan, migratedMessages: 0, migratedAttachments: 0 };
  const thread = await getThread(plan.threadId, env);
  const messages = await listThreadMessages(plan.threadId, env);
  let migratedMessages = 0;
  let migratedAttachments = 0;
  for (const candidate of plan.candidates) {
    const message = messages.find((entry) => entry.id === candidate.messageId);
    if (!message) continue;
    const result = await publishThreadAttachmentsEncrypted({ thread, attachments: message.attachments, env });
    await updateThreadMessage(thread.id, message.id, { attachments: result.attachments }, env);
    migratedMessages += 1;
    migratedAttachments += candidate.count;
  }
  await appendEvent({
    type: "thread_attachment_encryption_migration_completed",
    threadId: thread.id,
    ownerUserId: thread.ownerUserId,
    migratedMessages,
    migratedAttachments,
  }, env).catch(() => {});
  return { ok: true, dryRun: false, plan, migratedMessages, migratedAttachments };
}
