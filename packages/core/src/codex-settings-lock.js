import path from "node:path";
import { createHash } from "node:crypto";
import { appHome } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

export function withCodexSettingsLock(threadId, env, operation) {
  const key = path.join(appHome(env), "model-settings-locks", createHash("sha256").update(threadId).digest("hex"));
  return withStorageFileLock(key, operation, { timeoutMs: 5000 });
}
