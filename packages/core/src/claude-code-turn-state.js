import { updateThreadMessage } from "./threads.js";
import { turnOutcomeFields } from "./runtime-input-result.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";
import { updateThreadRuntime } from "./runtime-record-update.js";

function nowIso() {
  return new Date().toISOString();
}

export async function completeInterruptedClaudeCodeTurn(thread, message, attemptId, env = process.env, guard = {}) {
  await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: nowIso(),
    observedVia: "claude_code_interrupted",
    error: null,
    executorTurnId: attemptId,
    ...turnOutcomeFields({ turnId: attemptId, status: "cancelled" }),
  }, env);
  const updated = await updateThreadRuntime(thread.id, {
    state: "ready",
    runtime: { runtimeKind: "claude-code", state: "ready", activeTurnId: null, lastTurnId: attemptId, lastTurnStatus: "interrupted" },
  }, env, guard);
  await appendTurnLifecycleEvent("interrupted", {
    threadId: thread.id,
    runtimeKind: "claude-code",
    turnId: attemptId,
    state: "interrupted",
    source: "claude-code",
  }, env).catch(() => {});
  return updated;
}
