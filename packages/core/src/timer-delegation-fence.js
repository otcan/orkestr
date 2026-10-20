// V1 timers on a thread delegated to a remote runtime (Orkestr V2).
//
// While a WhatsApp thread is delegated, the remote runtime is its only
// executor and V1's dispatch fence never runs local input there. A V1-owned
// timer that fired into that thread would be held until the delegation ends
// and then run late. Instead the due pass pauses the timer once and posts a
// visible owner notice (a passive thread signal that the scoped relay delivers
// to the bound chat). The owner moves the timer to V2 or turns it back on after
// the chat returns to V1. Timers owned by V2 are untouched here.
import { appendEvent } from "../../storage/src/store.js";
import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";
import { appendThreadSignal } from "./thread-signals.js";
import { timerOwnedByV2 } from "./timer-ownership.js";

export const timerDelegationPauseReason = "thread_delegated_to_remote_runtime";
export const timerDelegationNoticeSource = "timer_delegation_fence";

function clean(value) {
  return String(value || "").trim();
}

// The delegated target thread of a V1-owned thread timer, or null.
export function delegatedTimerTarget(timer, thread, env = process.env) {
  if (!timer || timerOwnedByV2(timer) || clean(timer.targetType).toLowerCase() !== "thread" || !thread) return null;
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  return remote ? { thread, remote } : null;
}

export function timerDelegationError(remote) {
  const error = new Error("timer_target_delegated_to_remote_runtime");
  error.statusCode = 409;
  error.code = "timer_target_delegated_to_remote_runtime";
  error.remoteThreadId = remote?.remoteThreadId || null;
  return error;
}

export function timerDelegationNoticeText(timer = {}) {
  const label = clean(timer.label).replace(/[\r\n]+/g, " ").slice(0, 120) || "Scheduled task";
  return `Timer "${label}" did not run: this chat is now handled by Orkestr V2, so V1 paused it. ` +
    "Move the timer to V2, or turn it back on after the chat returns to V1.";
}

// Returns the paused timer row to store instead of enqueueing a run.
export async function pauseTimerForDelegatedThread(timer, { thread, remote }, env = process.env, now = new Date()) {
  const at = now.toISOString();
  const binding = thread.binding || {};
  const notice = await appendThreadSignal(thread.id, {
    source: timerDelegationNoticeSource,
    connector: "whatsapp",
    chatId: clean(binding.chatId),
    ownerUserId: timer.ownerUserId,
    timerId: timer.id,
    signalKind: "timer_delegation",
    signalMode: "notify_passively",
    originSurface: "timer",
    originTransport: "timer-delegation-notify",
    externalId: `timer-delegation:${timer.id}:${at}`,
    text: timerDelegationNoticeText(timer),
  }, env).catch(() => null);
  await appendEvent({
    ts: at,
    type: "timer_due_refused",
    reason: timerDelegationPauseReason,
    timerId: timer.id,
    ownerUserId: timer.ownerUserId,
    target: timer.target,
    targetType: timer.targetType,
    label: timer.label,
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    noticeMessageId: notice?.id || null,
  }, env).catch(() => {});
  return {
    ...timer,
    enabled: false,
    nextRunAt: null,
    retryAt: null,
    pausedReason: timerDelegationPauseReason,
    pausedAt: at,
    lastDelegationNoticeMessageId: notice?.id || null,
    lastError: timerDelegationPauseReason,
    lastErrorAt: at,
  };
}
