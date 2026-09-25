import { updateThread, updateThreadMessage } from "./threads.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";

function nowIso() {
  return new Date().toISOString();
}

export async function completeInterruptedClaudeCodeTurn(thread, message, attemptId, env = process.env) {
  await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: nowIso(),
    observedVia: "claude_code_interrupted",
    error: null,
  }, env);
  const updated = await updateThread(thread.id, {
    state: "ready",
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "ready", activeTurnId: null, lastTurnId: attemptId, lastTurnStatus: "interrupted" },
  }, env);
  await appendTurnLifecycleEvent("interrupted", {
    threadId: thread.id,
    runtimeKind: "claude-code",
    turnId: attemptId,
    state: "interrupted",
    source: "claude-code",
  }, env).catch(() => {});
  return updated;
}
