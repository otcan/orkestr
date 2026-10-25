// Explicit process configuration only: never discover a receipt beside state.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { leaseStoreError } from "./desktop-lease-lock.js";
import { parseLegacyJson } from "./desktop-lease-canonical.js";
import { MAX_ADOPTION_BYTES, normalizeLegacyAdoption } from "./desktop-lease-legacy.js";

export function legacyAdoptionFileConfig(filePath, sha256) {
  if (filePath === undefined && sha256 === undefined) return null;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath
      || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw leaseStoreError("desktop_lease_legacy_adoption_config_invalid");
  }
  return Object.freeze({ filePath, sha256 });
}

export async function readLegacyAdoptionFile(config) {
  let file;
  const unavailable = () => leaseStoreError("desktop_lease_legacy_adoption_unavailable");
  try {
    // Expected content hash is trusted process configuration, not another file.
    // Canonical path and final nofollow refuse both parent and leaf symlinks.
    if (await fs.realpath(config.filePath) !== config.filePath) throw unavailable();
    file = await fs.open(config.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    const uid = BigInt(process.geteuid());
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_ADOPTION_BYTES)
        || ![0n, uid].includes(before.uid) || (before.mode & 0o022n) !== 0n) throw unavailable();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await fs.lstat(config.filePath, { bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs || current.dev !== before.dev || current.ino !== before.ino
        || current.nlink !== 1n || !current.isFile()) throw unavailable();
    const raw = bytes.subarray(0, length);
    if (createHash("sha256").update(raw).digest("hex") !== config.sha256) throw unavailable();
    return normalizeLegacyAdoption(parseLegacyJson(raw));
  } catch (error) {
    if (error?.message?.startsWith("desktop_lease_")) throw error;
    throw unavailable();
  } finally {
    await file?.close();
  }
}
