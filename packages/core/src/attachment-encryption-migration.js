import fs from "node:fs/promises";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { dataPaths } from "../../storage/src/paths.js";
import { getThread, listThreadMessages, updateThreadMessage } from "./threads.js";
import { publishThreadAttachmentsEncrypted, validateEncryptedPublishedAttachment } from "./encrypted-attachment-publication.js";

function clean(value = "") {
  return String(value || "").trim();
}

async function readMigrationState(env = process.env) {
  const stored = await readJson(dataPaths(env).attachmentEncryptionMigrations, null);
  return stored && typeof stored === "object"
    ? { version: 1, checkpoints: Array.isArray(stored.checkpoints) ? stored.checkpoints : [] }
    : { version: 1, checkpoints: [] };
}

async function writeMigrationState(state, env = process.env) {
  const filePath = dataPaths(env).attachmentEncryptionMigrations;
  await writeJson(filePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    checkpoints: state.checkpoints,
  });
  await fs.chmod(filePath, 0o600);
}

function checkpointFor(state, threadId, messageId) {
  return state.checkpoints.find((item) => clean(item.threadId) === clean(threadId) && clean(item.messageId) === clean(messageId)) || null;
}

async function replaceCheckpoint(state, checkpoint, env) {
  state.checkpoints = [
    ...state.checkpoints.filter((item) => !(clean(item.threadId) === clean(checkpoint.threadId) && clean(item.messageId) === clean(checkpoint.messageId))),
    checkpoint,
  ];
  await writeMigrationState(state, env);
}

async function validateStagedCheckpoint(checkpoint, thread, env) {
  const attachments = Array.isArray(checkpoint?.attachments) ? checkpoint.attachments : [];
  if (!attachments.length) return false;
  for (const attachment of attachments) {
    if (!(await validateEncryptedPublishedAttachment(attachment, { thread, env })).ok) return false;
  }
  return true;
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
  const migrationState = await readMigrationState(env);
  let migratedMessages = 0;
  let migratedAttachments = 0;
  for (const candidate of plan.candidates) {
    const message = messages.find((entry) => entry.id === candidate.messageId);
    if (!message) continue;
    let checkpoint = checkpointFor(migrationState, thread.id, message.id);
    let result;
    if (["ciphertext_staged", "message_committed"].includes(checkpoint?.phase)) {
      if (!(await validateStagedCheckpoint(checkpoint, thread, env))) {
        const error = new Error("attachment_encryption_migration_checkpoint_invalid");
        error.statusCode = 409;
        throw error;
      }
      result = { attachments: checkpoint.attachments, encrypted: true };
    } else {
      result = await publishThreadAttachmentsEncrypted({ thread, attachments: message.attachments, env });
      checkpoint = {
        version: 1,
        threadId: thread.id,
        messageId: message.id,
        phase: "ciphertext_staged",
        attachmentCount: result.attachments.length,
        attachments: result.attachments,
        stagedAt: new Date().toISOString(),
      };
      await replaceCheckpoint(migrationState, checkpoint, env);
    }
    await updateThreadMessage(thread.id, message.id, { attachments: result.attachments }, env);
    await replaceCheckpoint(migrationState, {
      ...checkpoint,
      phase: "message_committed",
      committedAt: new Date().toISOString(),
    }, env);
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
