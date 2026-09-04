import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as age from "age-encryption";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import {
  activeAttachmentEncryptionRecipients,
  attachmentEncryptionPolicy,
} from "./attachment-encryption-registry.js";

const payloadMagic = "ORKESTR-ATTACHMENT-PAYLOAD/1";
const ageHeader = Buffer.from("age-encryption.org/v1\n", "utf8");

function clean(value = "") {
  return String(value || "").trim();
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeThreadId(value) {
  return clean(value).replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function sourcePathForAttachment(attachment = {}) {
  return clean(attachment.saved_path || attachment.savedPath || attachment.path || attachment.localPath);
}

function originalMetadata(attachment, plaintext) {
  return {
    version: 1,
    filename: clean(attachment.filename || attachment.name) || "attachment",
    mimetype: clean(attachment.mimetype || attachment.mimeType || attachment.type) || "application/octet-stream",
    plaintextSize: plaintext.length,
    plaintextChecksum: checksum(plaintext),
  };
}

function encodePayload(metadata, plaintext) {
  const header = Buffer.from(JSON.stringify(metadata), "utf8");
  return Buffer.concat([
    Buffer.from(`${payloadMagic}\n${header.length}\n`, "utf8"),
    header,
    plaintext,
  ]);
}

function encryptedAttachmentMetadata({ id, filename, ciphertext, recipients, policy, createdAt }) {
  return {
    id,
    name: filename,
    filename,
    mimetype: "application/age",
    size: ciphertext.length,
    checksum: checksum(ciphertext),
    downloadable: true,
    encrypted: true,
    createdAt,
    retention: "policy_managed",
    encryption: {
      format: "age",
      formatVersion: 1,
      algorithm: "age/x25519",
      policyRevision: policy.revision,
      recipientIds: recipients.map((recipient) => recipient.id),
      recipientFingerprints: recipients.map((recipient) => recipient.fingerprint),
      originalMetadataEncrypted: true,
    },
  };
}

export function encryptedPublishedAttachmentPath(thread = {}, attachment = {}, env = process.env) {
  const id = clean(attachment.id);
  const filename = clean(attachment.filename || attachment.name);
  if (!id || filename !== `attachment-${id}.age`) return "";
  const paths = dataPaths(env);
  return path.join(paths.home, "uploads", safeThreadId(thread.id), "published", filename);
}

export function hydrateEncryptedPublishedAttachmentPaths(thread = {}, attachments = [], env = process.env) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    if (attachment?.encrypted !== true) return attachment;
    const filePath = encryptedPublishedAttachmentPath(thread, attachment, env);
    return filePath ? {
      ...attachment,
      path: filePath,
      saved_path: filePath,
      source: "orkestr_encrypted_publication",
    } : attachment;
  });
}

export async function validateEncryptedPublishedAttachment(attachment = {}, { thread = {}, env = process.env } = {}) {
  if (attachment.encrypted !== true || clean(attachment.encryption?.format) !== "age") {
    return { ok: false, reason: "attachment_not_encrypted" };
  }
  const filePath = encryptedPublishedAttachmentPath(thread, attachment, env);
  if (!filePath || !path.isAbsolute(filePath)) return { ok: false, reason: "ciphertext_path_invalid" };
  const suppliedPath = sourcePathForAttachment(attachment);
  if (suppliedPath && path.resolve(suppliedPath) !== filePath) {
    return { ok: false, reason: "ciphertext_path_mismatch" };
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return { ok: false, reason: "ciphertext_missing" };
  if (Number(attachment.size || 0) !== stat.size) return { ok: false, reason: "ciphertext_size_mismatch" };
  const ciphertext = await fs.readFile(filePath);
  if (ciphertext.length <= ageHeader.length || !ciphertext.subarray(0, ageHeader.length).equals(ageHeader)) {
    return { ok: false, reason: "ciphertext_format_invalid" };
  }
  if (clean(attachment.checksum) !== checksum(ciphertext)) return { ok: false, reason: "ciphertext_checksum_mismatch" };
  return { ok: true, filePath, size: stat.size, checksum: checksum(ciphertext) };
}

async function publishOne({ thread, attachment, recipients, policy, publicationDir, env }) {
  if (attachment.encrypted === true) {
    const validation = await validateEncryptedPublishedAttachment(attachment, { thread, env });
    if (!validation.ok) {
      const error = new Error(`attachment_encryption_${validation.reason}`);
      error.statusCode = 409;
      throw error;
    }
    const stored = { ...attachment };
    for (const key of ["path", "saved_path", "savedPath", "filePath", "localPath", "source"]) delete stored[key];
    return stored;
  }
  const sourcePath = sourcePathForAttachment(attachment);
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    const error = new Error("attachment_encryption_source_path_required");
    error.statusCode = 409;
    throw error;
  }
  const plaintext = await fs.readFile(sourcePath);
  const payload = encodePayload(originalMetadata(attachment, plaintext), plaintext);
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient.recipient);
  const ciphertext = Buffer.from(await encrypter.encrypt(payload));
  const id = randomUUID();
  const filename = `attachment-${id}.age`;
  const filePath = path.join(publicationDir, filename);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const createdAt = new Date().toISOString();
  try {
    await fs.writeFile(tempPath, ciphertext, { mode: 0o600, flag: "wx" });
    const written = await fs.readFile(tempPath);
    if (written.length !== ciphertext.length || checksum(written) !== checksum(ciphertext)) {
      throw new Error("attachment_encryption_write_validation_failed");
    }
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  const published = encryptedAttachmentMetadata({ id, filename, ciphertext, recipients, policy, createdAt });
  await appendEvent({
    type: "thread_attachment_encrypted_published",
    threadId: clean(thread.id),
    ownerUserId: clean(thread.ownerUserId),
    attachmentId: id,
    ciphertextSize: ciphertext.length,
    ciphertextChecksum: published.checksum,
    policyRevision: policy.revision,
    recipientIds: recipients.map((recipient) => recipient.id),
    recipientFingerprints: recipients.map((recipient) => recipient.fingerprint),
  }, env).catch(() => {});
  return published;
}

export async function publishThreadAttachmentsEncrypted({ thread = {}, attachments = [], env = process.env } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return { attachments: [], encrypted: false, policy: null };
  const policy = await attachmentEncryptionPolicy(thread.ownerUserId, env);
  if (!policy.enabled) return { attachments: list, encrypted: false, policy };
  const recipients = await activeAttachmentEncryptionRecipients(thread.ownerUserId, env);
  if (!recipients.length) {
    const error = new Error("attachment_encryption_verified_recipient_required");
    error.statusCode = 409;
    throw error;
  }
  const paths = await ensureDataDirs(env);
  const publicationDir = path.join(paths.home, "uploads", safeThreadId(thread.id), "published");
  await fs.mkdir(publicationDir, { recursive: true, mode: 0o700 });
  const published = [];
  for (const attachment of list) {
    published.push(await publishOne({ thread, attachment, recipients, policy, publicationDir, env }));
  }
  return { attachments: published, encrypted: true, policy };
}

export async function encryptedAttachmentDeliveryGate(thread = {}, attachments = [], env = process.env) {
  const policy = await attachmentEncryptionPolicy(thread.ownerUserId, env);
  if (!policy.enabled) return { allowed: true, policy };
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment.encrypted !== true) return { allowed: false, reason: "attachment_encryption_required", policy };
    const validation = await validateEncryptedPublishedAttachment(attachment, { thread, env });
    if (!validation.ok) return { allowed: false, reason: `attachment_encryption_${validation.reason}`, policy };
  }
  return { allowed: true, policy };
}
