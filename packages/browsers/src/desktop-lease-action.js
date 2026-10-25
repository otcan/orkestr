// Trusted local action entry only. This does not authenticate a remote caller,
// issue browser contexts, or turn a postcheck into a distributed fence.
import { leaseStoreError } from "./desktop-lease-lock.js";

const KEYS = ["desktopSlug", "ownerUserId", "threadId", "leaseId", "fencingVersion", "fencingToken"];
const nonempty = (value) => typeof value === "string" && value.trim() === value && value.length > 0;

export function validateActionBinding(binding) {
  if (!binding || Object.getPrototypeOf(binding) !== Object.prototype
      || Object.keys(binding).length !== KEYS.length
      || KEYS.some((key) => !Object.hasOwn(binding, key))
      || KEYS.filter((key) => key !== "fencingVersion").some((key) => !nonempty(binding[key]))
      || !/^[a-z0-9_.-]+$/.test(binding.desktopSlug) || !/^[a-z0-9_.-]+$/.test(binding.ownerUserId)
      || !Number.isSafeInteger(binding.fencingVersion) || binding.fencingVersion < 1) {
    throw leaseStoreError("desktop_lease_action_binding_required", 403);
  }
  return Object.freeze({ ...binding });
}

export function synchronousCallback(callback) {
  if (typeof callback !== "function" || Object.getPrototypeOf(callback) !== Function.prototype) {
    throw leaseStoreError("desktop_lease_synchronous_callback_required", 400);
  }
}

export function synchronousResult(result) {
  if (result && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
    // Caller code is trusted. Refuse an accidental async return, not a promise
    // that already-started arbitrary async work can be undone or fenced here.
    Promise.resolve(result).catch(() => {});
    throw leaseStoreError("desktop_lease_synchronous_callback_required", 400);
  }
  return result;
}

export function currentActionLease(state, binding, staleAfterMs, now = Date.now()) {
  if (state.legacyRetiredCohort?.retiredIds.includes(binding.leaseId)) {
    throw leaseStoreError("desktop_lease_action_revoked", 409);
  }
  const lease = state.desktopLeases.find((item) => item.desktopSlug === binding.desktopSlug
    && item.ownerUserId === binding.ownerUserId && !item.releasedAt);
  if (!lease || lease.id !== binding.leaseId || lease.threadId !== binding.threadId
      || lease.fencingVersion !== binding.fencingVersion || lease.fencingToken !== binding.fencingToken) {
    throw leaseStoreError("desktop_lease_action_revoked", 409);
  }
  if (lease.mode !== "exclusive") throw leaseStoreError("desktop_lease_must_be_exclusive", 409);
  const expires = Date.parse(lease.expiresAt || "");
  const heartbeat = Date.parse(lease.heartbeatAt || "");
  if (!Number.isFinite(expires)) throw leaseStoreError("desktop_lease_expiry_invalid", 403);
  if (expires <= now) throw leaseStoreError("desktop_lease_expired", 403);
  if (!Number.isFinite(heartbeat) || heartbeat > now + 60_000) throw leaseStoreError("desktop_lease_heartbeat_invalid", 403);
  if (now - heartbeat > staleAfterMs) throw leaseStoreError("desktop_lease_heartbeat_stale", 403);
  return Object.freeze(structuredClone(lease));
}
