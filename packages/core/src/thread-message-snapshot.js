import { createThreadMessageRepository } from "../../storage/src/repositories.js";
import { snapshotEnvironment } from "../../storage/src/test-storage-isolation.js";
import { withThreadMessageMutation } from "./thread-message-mutation.js";

// A reconciliation pass may visit thousands of messages. Reuse its snapshot
// while the store revision is unchanged, checking under the same lock as live
// message writers. The operation must keep messages in sync with its own writes.
// This cache belongs to one pass, never to a thread's lifetime.
export function createThreadMessageSnapshot(threadId, env = process.env) {
  env = snapshotEnvironment(env);
  const repository = createThreadMessageRepository(env);
  const messages = [];
  let revision = null;
  let loads = 0;
  return {
    messages,
    // Bumped whenever `messages` is reloaded from the store, so per-pass
    // lookup indexes over it know to rebuild.
    get loads() {
      return loads;
    },
    run(operation) {
      return withThreadMessageMutation(threadId, env, async () => {
        try {
          const current = await repository.fingerprint(threadId);
          if (!current || current !== revision) {
            const fresh = await repository.list(threadId);
            messages.length = 0;
            for (const message of fresh) messages.push(message);
            loads += 1;
          }
          const result = await operation(messages);
          revision = await repository.fingerprint(threadId);
          return result;
        } catch (error) {
          // A failed operation may have persisted part of its work.
          revision = null;
          throw error;
        }
      });
    },
  };
}
