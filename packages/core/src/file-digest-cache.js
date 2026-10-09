import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export async function fileDigest(filePath) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, checksum: digest.digest("hex") };
}

// Encrypted attachments are re-validated on every WhatsApp delivery pass and
// download, and hashing the same files again was a large share of server CPU.
// A digest is reused only while the file keeps the same identity, size and
// timestamps. Like git's racy-clean rule, files changed shortly before hashing
// are never cached: a write landing in the same timestamp tick could otherwise
// leave the signature unchanged.
const cache = new Map();
const maxEntries = 4096;
const racyWindowMs = 2000;

function statSignature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function cachedFileDigest(filePath, { digestImpl = fileDigest, now = Date.now } = {}) {
  const before = await fs.stat(filePath);
  const signature = statSignature(before);
  const hit = cache.get(filePath);
  if (hit?.signature === signature) {
    cache.delete(filePath);
    cache.set(filePath, hit);
    return { size: hit.size, checksum: hit.checksum };
  }
  const startedAt = now();
  const result = await digestImpl(filePath);
  const after = await fs.stat(filePath).catch(() => null);
  const settled = startedAt - Math.max(before.mtimeMs, before.ctimeMs) > racyWindowMs;
  if (after && statSignature(after) === signature && result.size === before.size && settled) {
    cache.delete(filePath);
    cache.set(filePath, { signature, size: result.size, checksum: result.checksum });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  } else {
    cache.delete(filePath);
  }
  return result;
}

export function clearFileDigestCache() {
  cache.clear();
}
