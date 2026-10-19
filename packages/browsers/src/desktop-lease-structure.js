// Common structural checks; generation uniqueness remains the state validator's
// responsibility, except for its explicitly adopted immutable retired cohort.
import { leaseStoreError } from "./desktop-lease-lock.js";

const MODES = new Set(["exclusive", "viewOnly", "sharedRead"]);
const text = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const canonical = (value) => text(value) && /^[a-z0-9_.-]+$/.test(value);

export function validateLeaseStructure(state) {
  const invalid = () => { throw leaseStoreError("desktop_lease_state_invalid"); };
  if (!state || typeof state !== "object" || Array.isArray(state)
      || !Number.isSafeInteger(state.fencingCounter) || state.fencingCounter < 0
      || !Array.isArray(state.desktopLeases)) invalid();
  const ids = new Set(), active = new Set();
  for (const lease of state.desktopLeases) {
    if (!lease || typeof lease !== "object" || Array.isArray(lease)
        || !text(lease.id) || !canonical(lease.desktopSlug) || !canonical(lease.ownerUserId)
        || !text(lease.threadId) || !text(lease.fencingToken) || !MODES.has(lease.mode)
        || !Number.isSafeInteger(lease.fencingVersion) || lease.fencingVersion < 1
        || lease.fencingVersion > state.fencingCounter || !text(lease.acquiredAt)
        || !text(lease.heartbeatAt) || !(lease.expiresAt === null || text(lease.expiresAt))
        || !(lease.releasedAt === null || text(lease.releasedAt))) invalid();
    const key = JSON.stringify([lease.ownerUserId, lease.desktopSlug]);
    if (ids.has(lease.id) || (!lease.releasedAt && active.has(key))) invalid();
    ids.add(lease.id);
    if (!lease.releasedAt) active.add(key);
  }
  return state;
}
