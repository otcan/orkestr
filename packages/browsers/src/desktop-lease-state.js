// Validate persisted evidence without dropping records, inventing tokens, or
// normalizing a corrupt/legacy file into an empty store.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { leaseStoreError } from "./desktop-lease-lock.js";
import { validateLeaseStructure } from "./desktop-lease-structure.js";
import { validateLegacyCohort, verifyPreparedLegacyBytes } from "./desktop-lease-legacy.js";
import { parseLegacyJson } from "./desktop-lease-canonical.js";

export const MAX_LEASE_STATE_BYTES = 8 * 1024 * 1024;
export function validateLeaseState(state, lockIdentity, adoption = null) {
  const invalid = () => { throw leaseStoreError("desktop_lease_state_invalid"); };
  validateLeaseStructure(state);
  if (state.lockIdentity !== undefined && state.lockIdentity !== lockIdentity) {
    throw leaseStoreError("desktop_lease_lock_identity_changed");
  }
  const retired = validateLegacyCohort(state, adoption), versions = new Set();
  for (const lease of state.desktopLeases) {
    if (retired.has(lease.id)) continue;
    if (versions.has(lease.fencingVersion) || adoption && lease.fencingVersion <= adoption.cohort.generationFloor) invalid();
    versions.add(lease.fencingVersion);
  }
  return state;
}

export async function readLeaseState(gate, adoption = null) {
  let file;
  try {
    file = await fs.open(gate.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT" && !gate.initialized && !adoption) return null;
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
    const raw = bytes.subarray(0, length);
    try { state = adoption ? parseLegacyJson(raw) : JSON.parse(raw.toString("utf8")); }
    catch { throw leaseStoreError("desktop_lease_state_invalid"); }
    if (gate.initialized && state?.lockIdentity === undefined) {
      throw leaseStoreError("desktop_lease_lock_identity_missing");
    }
    validateLeaseState(state, gate.identity, adoption);
    verifyPreparedLegacyBytes(raw, state, adoption, gate.initialized);
    return state;
  } finally {
    await file.close();
  }
}
