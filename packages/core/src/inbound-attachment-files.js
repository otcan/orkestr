import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { dataPaths } from "../../storage/src/paths.js";

function clean(value = "") {
  return String(value || "").trim();
}

function safeThreadId(value = "") {
  return clean(value).replace(/[^a-zA-Z0-9_.-]/g, "_") || "thread";
}

function safeSessionId(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(id) ? id : "";
}

function safeToken(value = "") {
  const token = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(token) ? token : "";
}

function ownerBucket(ownerUserId) {
  return createHash("sha256").update(clean(ownerUserId)).digest("hex").slice(0, 24);
}

export function inboundAttachmentQuarantineRoot(env = process.env) {
  return path.join(dataPaths(env).home, "uploads", "inbound-quarantine");
}

export function inboundAttachmentCiphertextPath(session, env = process.env) {
  return path.join(inboundAttachmentQuarantineRoot(env), "ciphertext", ownerBucket(session.ownerUserId), `${safeSessionId(session.id)}.age`);
}

export function inboundAttachmentReleasePath(session, token = session?.processingToken, env = process.env) {
  return path.join(dataPaths(env).home, "uploads", safeThreadId(session.threadId), "inbound", `inbound-${safeSessionId(session.id)}-${safeToken(token)}`);
}

export function inboundAttachmentStagingPath(session, token, env = process.env) {
  return path.join(inboundAttachmentQuarantineRoot(env), "staging", ownerBucket(session.ownerUserId), `${safeSessionId(session.id)}-${safeToken(token)}`);
}

export function inboundAttachmentWorkerHandoffPath(session, token, env = process.env) {
  return path.join(inboundAttachmentQuarantineRoot(env), "handoff", ownerBucket(session.ownerUserId), `${safeSessionId(session.id)}-${safeToken(token)}`);
}

export function inboundAttachmentLeaseDirectory(session, token, env = process.env) {
  return path.join(inboundAttachmentQuarantineRoot(env), "plaintext", safeSessionId(session.id), safeToken(token));
}

export async function writeInboundAttachmentCiphertext(input, finalPath, maximumBytes, { mode = 0o640 } = {}) {
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  // The production ciphertext root is setgid to the API/worker transfer group.
  // Its per-owner directories need group traversal for the worker to read the
  // API-created ciphertext, but remain inaccessible to unrelated accounts.
  await fsp.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o770 });
  await fsp.chmod(path.dirname(finalPath), 0o770);
  // A production worker runs under a separate unprivileged account. Operators
  // provision this directory setgid to the narrow shared group; the API never
  // writes plaintext here.
  const output = createWriteStream(temporaryPath, { flags: "wx", mode });
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const value of input) {
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > maximumBytes) {
        const error = new Error("inbound_upload_ciphertext_too_large");
        error.statusCode = 413;
        throw error;
      }
      digest.update(chunk);
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
    const handle = await fsp.open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { temporaryPath, size, checksum: digest.digest("hex") };
  } catch (error) {
    output.destroy();
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function inboundAttachmentFileDigest(filePath) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.byteLength;
    digest.update(chunk);
  }
  return { size, checksum: digest.digest("hex") };
}
