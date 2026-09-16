import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

// Session and key writers share this lease. Keeping it separate from either
// JSON file prevents a key revocation from racing a ready-state publication.
export function withInboundAttachmentMutationLock(env, operation, options = {}) {
  return withStorageFileLock(dataPaths(env).inboundAttachmentMutationLock, operation, {
    timeoutMs: 10_000,
    staleMs: 30_000,
    heartbeatMs: 5_000,
    ...options,
  });
}
