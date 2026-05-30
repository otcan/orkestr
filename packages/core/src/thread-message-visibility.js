import { clean } from "./codex-app-server-common.js";

export function messageTurnId(message = {}) {
  return clean(message.codexTurnId || message.executorTurnId);
}

export function assistantMessage(message = {}) {
  if (message?.role !== "assistant") return false;
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

export function visibleThreadMessages(messages = []) {
  return messages.filter((message) => !runtimeInterruptedSuperseded(message, messages));
}
