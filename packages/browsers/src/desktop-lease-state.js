// Validate persisted evidence without dropping records, inventing tokens, or
// normalizing a corrupt/legacy file into an empty store.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { leaseStoreError } from "./desktop-lease-lock.js";

export const MAX_LEASE_STATE_BYTES = 8 * 1024 * 1024;
const MODES = new Set(["exclusive", "viewOnly", "sharedRead"]);
const text = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const canonical = (value) => text(value) && /^[a-z0-9_.-]+$/.test(value);

export function validateLeaseState(state, lockIdentity) {
  const invalid = () => { throw leaseStoreError("desktop_lease_state_invalid"); };
  if (!state || typeof state !== "object" || Array.isArray(state)
      || !Number.isSafeInteger(state.fencingCounter) || state.fencingCounter < 0
      || !Array.isArray(state.desktopLeases)) invalid();
  if (state.lockIdentity !== undefined && state.lockIdentity !== lockIdentity) {
    throw leaseStoreError("desktop_lease_lock_identity_changed");
  }
  const ids = new Set(), versions = new Set(), active = new Set();
  for (const lease of state.desktopLeases) {
    if (!lease || typeof lease !== "object" || Array.isArray(lease)
        || !text(lease.id) || !canonical(lease.desktopSlug) || !canonical(lease.ownerUserId)
        || !text(lease.threadId) || !text(lease.fencingToken) || !MODES.has(lease.mode)
        || !Number.isSafeInteger(lease.fencingVersion) || lease.fencingVersion < 1
        || lease.fencingVersion > state.fencingCounter || !text(lease.acquiredAt)
        || !text(lease.heartbeatAt) || !(lease.expiresAt === null || text(lease.expiresAt))
        || !(lease.releasedAt === null || text(lease.releasedAt))) invalid();
    const key = JSON.stringify([lease.ownerUserId, lease.desktopSlug]);
    if (ids.has(lease.id) || versions.has(lease.fencingVersion) || (!lease.releasedAt && active.has(key))) invalid();
    ids.add(lease.id);
    versions.add(lease.fencingVersion);
    if (!lease.releasedAt) active.add(key);
  }
  return state;
}

export async function readLeaseState(gate) {
  let file;
  try {
    file = await fs.open(gate.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT" && !gate.initialized) return null;
    throw leaseStoreError("desktop_lease_state_unavailable");
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_LEASE_STATE_BYTES)) {
      throw leaseStoreError("desktop_lease_state_invalid");
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await fs.lstat(gate.filePath, { bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1n) {
      throw leaseStoreError("desktop_lease_state_changed");
    }
    let state;
    try { state = JSON.parse(bytes.toString("utf8", 0, length)); }
    catch { throw leaseStoreError("desktop_lease_state_invalid"); }
    if (gate.initialized && state?.lockIdentity === undefined) {
      throw leaseStoreError("desktop_lease_lock_identity_missing");
    }
    return validateLeaseState(state, gate.identity);
  } finally {
    await file.close();
  }
}
