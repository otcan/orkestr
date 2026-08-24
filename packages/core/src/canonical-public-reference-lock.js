import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

export function withCanonicalPublicReferenceLock(operation, env = process.env, options = {}) {
  return withStorageFileLock(dataPaths(env).canonicalPublicRefLock, operation, {
    timeoutMs: Number(env.ORKESTR_CANONICAL_PUBLIC_REF_LOCK_TIMEOUT_MS || options.timeoutMs || 30_000),
    staleMs: Number(env.ORKESTR_CANONICAL_PUBLIC_REF_LOCK_STALE_MS || options.staleMs || 120_000),
    heartbeatMs: Number(env.ORKESTR_CANONICAL_PUBLIC_REF_LOCK_HEARTBEAT_MS || options.heartbeatMs || 10_000),
  });
}
