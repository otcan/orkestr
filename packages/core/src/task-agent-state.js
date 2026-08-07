export const activeTaskStates = new Set(["created", "queued", "starting", "working", "awaiting_result", "delivering_result"]);
const terminalTaskStates = new Set(["cancelled", "completed", "failed"]);

export function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function timestampMs(value = "") {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function optionNowMs(options = {}) {
  const parsed = Number(options.nowMs ?? options.now ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

export function isoAt(ms) {
  return new Date(Math.max(0, Number(ms) || 0)).toISOString();
}

export function isTaskAgentThread(thread = {}) {
  return clean(thread.threadKind) === "task-agent" && Boolean(clean(thread.agentTaskId));
}

export function isTerminalTaskAgentThread(thread = {}) {
  return isTaskAgentThread(thread) && terminalTaskStates.has(clean(thread.agentTaskStatus));
}

export function canCorrectMissingResultFailure(thread = {}) {
  return isTaskAgentThread(thread) && clean(thread.agentTaskStatus) === "failed" &&
    clean(thread.agentTaskFailureKind) === "missing_result" && thread.agentTaskFailureProvisional === true;
}

export function taskAgentRuntimeActive(thread = {}) {
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const codexStatus = runtime.codexStatus && typeof runtime.codexStatus === "object" ? runtime.codexStatus : {};
  return Boolean(
    clean(runtime.activeTurnId) ||
    runtime.pendingRequest ||
    lower(codexStatus.type) === "active" ||
    ["working", "awaiting_approval"].includes(lower(runtime.state)),
  );
}

export function taskAgentFinalAnswer(messages = [], turnId = "") {
  const finalAnswers = [...messages].reverse().filter((message) =>
    clean(message.role) === "assistant" && clean(message.phase || "final_answer") === "final_answer" && clean(message.text));
  const wantedTurn = clean(turnId);
  if (wantedTurn) {
    return finalAnswers.find((message) => clean(message.codexTurnId || message.turnId) === wantedTurn) || null;
  }
  return finalAnswers[0] || null;
}
