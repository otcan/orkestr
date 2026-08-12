import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { withRuntimeLeaseLock } from "../../core/src/runtime-lease-lock.js";

const context = new AsyncLocalStorage();

export function withStorageFileLock(filePath, operation, options = {}) {
  const key = path.resolve(filePath);
  if (context.getStore() === key) return operation();
  return withRuntimeLeaseLock(key, () => context.run(key, operation), options);
}
