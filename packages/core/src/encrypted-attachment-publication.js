import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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

async function fileDigest(filePath) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, checksum: digest.digest("hex") };
}

function safeThreadId(value) {
  return clean(value).replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function sourcePathForAttachment(attachment = {}) {
  return clean(attachment.saved_path || attachment.savedPath || attachment.path || attachment.localPath);
}

function originalMetadata(attachment, source) {
  return {
    version: 1,
    filename: clean(attachment.filename || attachment.name) || "attachment",
    mimetype: clean(attachment.mimetype || attachment.mimeType || attachment.type) || "application/octet-stream",
    plaintextSize: source.size,
    plaintextChecksum: source.checksum,
  };
}

function payloadHeader(metadata) {
  const header = Buffer.from(JSON.stringify(metadata), "utf8");
  return Buffer.concat([
    Buffer.from(`${payloadMagic}\n${header.length}\n`, "utf8"),
    header,
  ]);
}

function encryptedAttachmentMetadata({ id, filename, ciphertext, recipients, policy, createdAt, sourceAttachmentId }) {
  return {
    id,
    name: filename,
    filename,
    mimetype: "application/age",
    size: ciphertext.size,
    checksum: ciphertext.checksum,
    downloadable: true,
    encrypted: true,
    createdAt,
    retention: "policy_managed",
    sourceAttachmentId: clean(sourceAttachmentId),
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
  const handle = await fs.open(filePath, "r");
  const header = Buffer.alloc(ageHeader.length);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (stat.size <= ageHeader.length || !header.equals(ageHeader)) {
    return { ok: false, reason: "ciphertext_format_invalid" };
  }
  const ciphertext = await fileDigest(filePath);
  if (clean(attachment.checksum) !== ciphertext.checksum) return { ok: false, reason: "ciphertext_checksum_mismatch" };
  return { ok: true, filePath, size: stat.size, checksum: ciphertext.checksum };
}

async function writeEncryptedPayload({ sourcePath, metadata, recipients, tempPath }) {
  const header = payloadHeader(metadata);
  async function* plaintextChunks() {
    yield header;
    for await (const chunk of createReadStream(sourcePath)) yield chunk;
  }
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient.recipient);
  const encryptedStream = await encrypter.encrypt(Readable.toWeb(Readable.from(plaintextChunks())));
  const digest = createHash("sha256");
  let size = 0;
  const inspect = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(encryptedStream),
    inspect,
    createWriteStream(tempPath, { mode: 0o600, flags: "wx" }),
  );
  const expectedSize = typeof encryptedStream.size === "function"
    ? encryptedStream.size(header.length + metadata.plaintextSize)
    : size;
  if (size !== expectedSize) throw new Error("attachment_encryption_write_validation_failed");
  const handle = await fs.open(tempPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { size, checksum: digest.digest("hex") };
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
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) {
    const error = new Error("attachment_encryption_source_file_required");
    error.statusCode = 409;
    throw error;
  }
  const source = await fileDigest(sourcePath);
  const metadata = originalMetadata(attachment, source);
  const id = randomUUID();
  const filename = `attachment-${id}.age`;
  const filePath = path.join(publicationDir, filename);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const createdAt = new Date().toISOString();
  let ciphertext;
  try {
    ciphertext = await writeEncryptedPayload({ sourcePath, metadata, recipients, tempPath });
    const sourceAfterWrite = await fileDigest(sourcePath);
    if (sourceAfterWrite.size !== source.size || sourceAfterWrite.checksum !== source.checksum) {
      throw new Error("attachment_encryption_source_changed_during_publication");
    }
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  const published = encryptedAttachmentMetadata({
    id,
    filename,
    ciphertext,
    recipients,
    policy,
    createdAt,
    sourceAttachmentId: attachment.id,
  });
  await appendEvent({
    type: "thread_attachment_encrypted_published",
    threadId: clean(thread.id),
    ownerUserId: clean(thread.ownerUserId),
    attachmentId: id,
    ciphertextSize: ciphertext.size,
    ciphertextChecksum: published.checksum,
    policyRevision: policy.revision,
    recipientIds: recipients.map((recipient) => recipient.id),
    recipientFingerprints: recipients.map((recipient) => recipient.fingerprint),
  }, env).catch(() => {});
  return published;
}

export async function publishThreadAttachmentsEncrypted({ thread = {}, attachments = [], env = process.env } = {}) {
  const supplied = Array.isArray(attachments) ? attachments : [];
  const representedSourceIds = new Set(supplied
    .filter((attachment) => attachment?.encrypted === true)
    .map((attachment) => clean(attachment.sourceAttachmentId))
    .filter(Boolean));
  const list = supplied.filter((attachment) => attachment?.encrypted === true ||
    !representedSourceIds.has(clean(attachment?.id)));
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
  try {
    for (const attachment of list) {
      published.push(await publishOne({ thread, attachment, recipients, policy, publicationDir, env }));
    }
  } catch (error) {
    for (let index = 0; index < published.length; index += 1) {
      if (list[index]?.encrypted === true) continue;
      const filePath = encryptedPublishedAttachmentPath(thread, published[index], env);
      if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
    }
    throw error;
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
