import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { withRuntimeLeaseLock } from "../../core/src/runtime-lease-lock.js";

const context = new AsyncLocalStorage();

export function withStorageFileLock(filePath, operation, options = {}) {
  const key = path.resolve(filePath);
  const held = context.getStore();
  if (held?.get(key)?.active) return operation();
  return withRuntimeLeaseLock(key, async () => {
    const lease = { active: true };
    const next = new Map(held || []);
    next.set(key, lease);
    try { return await context.run(next, operation); }
    finally { lease.active = false; }
  }, options);
}
