// Process-local registry of live Claude Code turns, shared by the adapter, the
// detached-turn reattach pass, and orphan recovery.
export const activeTurns = new Map();
export const turnReservations = new Set();
let deliveryScheduler = null;

export function scheduleClaudeCodeDelivery(threadId, env = process.env, delayMs = 0) {
  deliveryScheduler?.(threadId, env, delayMs);
}

export function setClaudeCodeDeliveryScheduler(handler) {
  deliveryScheduler = typeof handler === "function" ? handler : null;
  return () => {
    if (deliveryScheduler === handler) deliveryScheduler = null;
  };
}
