import { AsyncLocalStorage } from "node:async_hooks";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { createThreadMessageRepository } from "../../storage/src/repositories.js";

const context = new AsyncLocalStorage();
const queues = new Map();

export function enqueueMessageMutation(file, operation) {
  if (context.getStore() === file) return operation();
  const previous = queues.get(file) || Promise.resolve();
  const run = () => withStorageFileLock(file, () => context.run(file, operation));
  const next = previous.then(run, run);
  const tracked = next.finally(() => { if (queues.get(file) === tracked) queues.delete(file); });
  void tracked.catch(() => {});
  queues.set(file, tracked);
  return next;
}

export async function withThreadMessageMutation(threadId, env, operation) {
  const file = await createThreadMessageRepository(env).pathForThread(threadId);
  return enqueueMessageMutation(file, operation);
}
