import { listThreadMessages, updateThreadMessage } from "./threads.js";
import { turnOutcomeFields } from "./runtime-input-result.js";
import { classifyCodexTurnError } from "./runtime-turn-error-class.js";

const clean = (value) => String(value ?? "").trim();

export function codexTurnOutcomeStatus(status = "", { interrupted = false } = {}) {
  if (interrupted) return "cancelled";
  const normalized = clean(status).toLowerCase();
  if (normalized === "failed") return "failed";
  if (normalized === "interrupted" || normalized === "cancelled") return "cancelled";
  return "completed";
}

export function codexTurnErrorClass(status = "", errorText = "", authReason = "") {
  return clean(status).toLowerCase() === "failed" ? classifyCodexTurnError(errorText, { authReason }) : null;
}

// Persists the settled outcome on every input message the turn consumed (the
// starting input plus steered follow-ups), so lookupThreadInputResult can
// answer for any of them after a restart.
export async function recordCodexTurnOutcome({ threadId, turnId, parentId = "", status, error = null }, env = process.env) {
  const id = clean(turnId);
  if (!threadId || !id) return [];
  const messages = await listThreadMessages(threadId, env).catch(() => []);
  const inputs = messages.filter((message) =>
    message.role === "user" &&
    (clean(message.codexTurnId) === id || (parentId && message.id === parentId)) &&
    clean(message.turnOutcome?.turnId) !== id);
  const fields = turnOutcomeFields({ turnId: id, status, error });
  const updated = [];
  // Only the outcome is added; delivery state stays owned by the delivery and
  // auth-recovery paths (a requeued auth-probe input keeps state "queued").
  for (const input of inputs) {
    const result = await updateThreadMessage(threadId, input.id, fields, env).catch(() => null);
    if (result) updated.push(result.id);
  }
  return updated;
}
