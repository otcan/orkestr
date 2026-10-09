import { clean } from "./codex-app-server-common.js";
import { isNoReplyAssistantMessage } from "./no-reply.js";

export function messageTurnId(message = {}) {
  return clean(message.codexTurnId || message.executorTurnId);
}

export function assistantMessage(message = {}) {
  if (message?.role !== "assistant" || message?.source === "thread_bridge_agent") return false;
  const state = clean(message.state).toLowerCase();
  return !state || state === "completed";
}

export function terminalAssistantMessage(message = {}) {
  if (!assistantMessage(message)) return false;
  const phase = clean(message.phase || "final_answer").toLowerCase();
  if (phase === "final_answer" || phase === "runtime_interrupted") return true;
  return ["plan", "need_input"].includes(phase);
}

export function runtimeInterruptedMessage(message = {}) {
  return message?.role === "assistant" &&
    clean(message.source).toLowerCase() === "orkestr_runtime" &&
    clean(message.phase).toLowerCase() === "runtime_interrupted";
}

export function assistantBelongsToTurn(message = {}, userMessage = {}, turnId = "") {
  if (!assistantMessage(message)) return false;
  if (turnId && messageTurnId(message) === turnId) return true;
  return Boolean(userMessage?.id && message.parentMessageId === userMessage.id);
}

export function assistantMessagesForDeliveredTurn(messages = [], latestUser = {}, latestUserIndex = -1) {
  const turnId = messageTurnId(latestUser);
  const seen = new Set();
  const assistants = [];
  const push = (message) => {
    if (!message?.id || seen.has(message.id)) return;
    seen.add(message.id);
    assistants.push(message);
  };
  if (turnId) {
    for (const message of messages) {
      if (assistantBelongsToTurn(message, latestUser, turnId)) push(message);
    }
  }
  const afterUser = messages.slice(Math.max(0, latestUserIndex + 1));
  for (const message of afterUser) {
    if (message?.role === "user") break;
    if (assistantMessage(message) && (!turnId || !messageTurnId(message))) push(message);
  }
  return assistants;
}

export function runtimeInterruptedSuperseded(message = {}, messages = []) {
  if (!runtimeInterruptedMessage(message)) return false;
  const turnId = messageTurnId(message);
  if (!turnId) return false;
  return messages.some((candidate) =>
    candidate?.id !== message.id &&
    messageTurnId(candidate) === turnId &&
    terminalAssistantMessage(candidate) &&
    !runtimeInterruptedMessage(candidate)
  );
}

// Turn id -> ids of terminal assistant messages that supersede a
// runtime_interrupted notice for that turn. Built once so filtering a long
// thread stays linear instead of rescanning every message per notice.
function supersedingTerminalIdsByTurn(messages = []) {
  const byTurn = new Map();
  for (const candidate of messages) {
    const turnId = messageTurnId(candidate || {});
    if (!turnId || !terminalAssistantMessage(candidate) || runtimeInterruptedMessage(candidate)) continue;
    if (!byTurn.has(turnId)) byTurn.set(turnId, new Set());
    byTurn.get(turnId).add(candidate?.id);
  }
  return byTurn;
}

export function visibleThreadMessages(messages = []) {
  let supersedingIds = null;
  const superseded = (message) => {
    if (!runtimeInterruptedMessage(message)) return false;
    const turnId = messageTurnId(message);
    if (!turnId) return false;
    supersedingIds ||= supersedingTerminalIdsByTurn(messages);
    const ids = supersedingIds.get(turnId);
    return Boolean(ids && (ids.size > 1 || !ids.has(message.id)));
  };
  return messages.filter((message) =>
    !isNoReplyAssistantMessage(message) &&
    clean(message?.visibility).toLowerCase() !== "internal" &&
    !superseded(message)
  );
}
