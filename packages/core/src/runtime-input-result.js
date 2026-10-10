import { listThreadMessages } from "./threads.js";

// Result lookup by input id. Runtime adapters (Codex app-server, Claude Code)
// persist a `turnOutcome` on the input message when its turn settles, so a
// caller that re-delivers an input after a crash can recover the original
// turn's outcome instead of only learning that the input was a duplicate.

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const clean = (value) => String(value ?? "").trim();

function nowIso() {
  return new Date().toISOString();
}

export function normalizeTurnOutcomeStatus(status = "") {
  const normalized = clean(status).toLowerCase();
  if (normalized === "interrupted" || normalized === "canceled") return "cancelled";
  return normalized;
}

// Fields to merge into the input message when its turn settles.
export function turnOutcomeFields({ turnId = "", status = "", error = null, settledAt = "" } = {}) {
  return {
    turnOutcome: {
      turnId: clean(turnId) || null,
      status: normalizeTurnOutcomeStatus(status),
      error: error && typeof error === "object" ? { ...error } : null,
      settledAt: clean(settledAt) || nowIso(),
    },
  };
}

function inputKey(message = {}) {
  return clean(message.clientMessageId || message.client_message_id || message.idempotencyKey);
}

function currentTurnId(message = {}) {
  return clean(message.codexTurnId || message.executorTurnId || message.claudeAttemptId || message.turnId);
}

// An outcome recorded for an earlier attempt is stale once the input was
// re-submitted under a new turn or requeued for retry.
function currentOutcome(message = {}) {
  const outcome = message.turnOutcome;
  if (!outcome || typeof outcome !== "object") return null;
  const current = currentTurnId(message);
  if (current && clean(outcome.turnId) && current !== clean(outcome.turnId)) return null;
  if (clean(message.state).toLowerCase() === "queued") return null;
  return outcome;
}

function inputTurnId(message = {}) {
  return clean(currentOutcome(message)?.turnId) || currentTurnId(message);
}

function finalAssistantFor(messages, input, turnId) {
  const candidates = messages.filter((message) =>
    message.role === "assistant" &&
    clean(message.source) !== "orkestr_runtime" &&
    clean(message.phase) !== "commentary" &&
    (clean(message.parentMessageId) === input.id ||
      (turnId && (clean(message.codexTurnId) === turnId || clean(message.executorTurnId) === turnId))));
  return candidates.at(-1) || null;
}

function derivedStatus(input = {}, finalMessage = null) {
  const recorded = normalizeTurnOutcomeStatus(currentOutcome(input)?.status);
  if (TERMINAL_STATUSES.has(recorded)) return recorded;
  const state = normalizeTurnOutcomeStatus(input.state);
  if (state === "queued") return "pending";
  if (state === "failed" || state === "cancelled") return state;
  if (state === "completed" && finalMessage) return "completed";
  return inputTurnId(input) ? "running" : "pending";
}

// Returns null when no input with this id exists on the thread. `inputId` may
// be the caller's client message id or the Orkestr message id.
export async function lookupThreadInputResult(threadId, inputId, env = process.env) {
  const key = clean(inputId);
  if (!threadId || !key) return null;
  const messages = await listThreadMessages(threadId, env);
  const input = [...messages].reverse().find((message) =>
    message.role === "user" && (inputKey(message) === key || clean(message.id) === key));
  if (!input) return null;
  const turnId = inputTurnId(input);
  const finalMessage = finalAssistantFor(messages, input, turnId);
  const status = derivedStatus(input, finalMessage);
  const outcome = currentOutcome(input);
  return {
    threadId,
    inputId: key,
    messageId: input.id,
    turnId: turnId || null,
    status,
    settled: TERMINAL_STATUSES.has(status),
    finalMessageId: status === "completed" ? finalMessage?.id || null : null,
    output: status === "completed" && finalMessage ? { text: clean(finalMessage.text) } : null,
    error: status === "failed" ? outcome?.error || (input.error ? { class: null, code: clean(input.error) } : null) : null,
    settledAt: outcome?.settledAt || null,
  };
}
