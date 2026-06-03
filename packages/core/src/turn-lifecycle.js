import { appendEvent } from "../../storage/src/store.js";
import { turnLifecycleEventName } from "./orkestr-events.js";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export const turnLifecycleTerminalStates = new Set(["ready", "completed", "failed", "interrupted"]);

export function normalizeTurnLifecycle(input = {}) {
  const state = lower(input.state || input.status || "ready") || "ready";
  const activeTurnId = clean(input.activeTurnId || input.turnId);
  const activeMessageId = clean(input.activeMessageId || input.messageId);
  const pendingCount = count(input.pendingCount);
  const runningCount = count(input.runningCount);
  const awaitingAckCount = count(input.awaitingAckCount);
  const awaitingApproval = state === "awaiting_approval" || input.awaitingApproval === true;
  const planning = state === "planning";
  const queued = state === "queued" || pendingCount > 0 || awaitingAckCount > 0;
  const running = planning || state === "running" || state === "working" || runningCount > 0 || Boolean(activeTurnId && !awaitingApproval);
  const terminal = turnLifecycleTerminalStates.has(state);
  return {
    state,
    active: running || queued || awaitingApproval,
    running,
    planning,
    queued,
    awaitingApproval,
    terminal,
    typingActive: input.typingActive === true && running && !awaitingApproval,
    sidebarWorking: input.sidebarWorking === true || running || queued || awaitingApproval || state === "waking",
    activeTurnId: activeTurnId || null,
    activeMessageId: activeMessageId || null,
    pendingCount,
    runningCount,
    awaitingAckCount,
    updatedAt: clean(input.updatedAt) || new Date().toISOString(),
  };
}

export function turnLifecycleFromRuntimeStatus(status = {}, messages = []) {
  const runtimeState = lower(status.state || status.status);
  const latestRunning = [...(Array.isArray(messages) ? messages : [])].reverse()
    .find((message) => lower(message.role) === "user" && lower(message.state) === "running") || null;
  const progressState = lower(status.progress?.stateHint);
  const state = runtimeState === "awaiting_approval" || progressState === "awaiting_approval"
    ? "awaiting_approval"
    : progressState === "planning"
      ? "planning"
    : runtimeState === "working" || runtimeState === "running"
      ? "running"
      : runtimeState === "waking"
        ? "waking"
        : count(status.pendingCount) || count(status.awaitingAckCount)
          ? "queued"
          : runtimeState === "failed"
            ? "failed"
            : runtimeState === "interrupted"
              ? "interrupted"
              : "ready";
  return normalizeTurnLifecycle({
    state,
    activeTurnId: status.activeTurnId || status.turnId || latestRunning?.codexTurnId || "",
    activeMessageId: latestRunning?.id || "",
    pendingCount: status.pendingCount,
    runningCount: status.runningCount,
    awaitingAckCount: status.awaitingAckCount,
    typingActive: status.typingActive === true,
    sidebarWorking: status.working === true || status.foregroundWorking === true || status.backgroundWork === true,
  });
}

export function turnLifecycleEvent(type = "", payload = {}) {
  return {
    type: turnLifecycleEventName(type),
    threadId: clean(payload.threadId),
    messageId: clean(payload.messageId) || null,
    runtimeKind: clean(payload.runtimeKind),
    turnId: clean(payload.turnId) || null,
    state: lower(payload.state || type),
    source: clean(payload.source),
    reason: clean(payload.reason) || null,
  };
}

export async function appendTurnLifecycleEvent(type = "", payload = {}, env = process.env) {
  return appendEvent(turnLifecycleEvent(type, payload), env);
}
