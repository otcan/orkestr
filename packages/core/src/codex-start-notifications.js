import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";

// Let promptly arriving lifecycle updates settle before start bookkeeping.
// An acknowledged input must not hold the delivery lease until semantic work
// or projections finish, nor wait for notifications belonging to another thread.
// Handlers keep running in their existing per-thread order after this budget.
export async function settleCodexStartNotifications(client, threadId, completedKey) {
  const deadline = performance.now() + 100;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    await setImmediate();
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    const drained = await client.drainNotifications?.({ threadId, timeoutMs: remaining });
    if (drained === false || (completedKey && client.completedTurns?.has(completedKey))) return;
    const waitMs = Math.min(5, deadline - performance.now());
    if (waitMs <= 0) return;
    await setTimeout(waitMs);
  }
}
