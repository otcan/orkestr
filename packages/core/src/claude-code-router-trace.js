import { recordRouterTraceEvent } from "./router-traces.js";
import { appendThreadMessage, listThreadMessages } from "./threads.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { replyDeliveryProjectionParent } from "./reply-delivery-intent.js";

export async function appendClaudeCodeFinal(thread, parent, attemptId, text, env) {
  const route = replyDeliveryProjectionParent(parent) || parent;
  const assistant = await appendThreadMessage(thread.id, {
    role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
    text: String(text || "").trim() || "Claude Code completed without text output.",
    parentMessageId: parent.id, eventId: claudeCodeOutputEventId(thread.id, attemptId),
    executorKind: "claude-code", executorTurnId: attemptId,
    connector: route.connector || "", chatId: route.chatId || "", accountId: route.accountId || "",
    sourceEventId: parent.sourceEventId || "", routerTraceId: parent.routerTraceId || "", turnId: parent.turnId || "",
  }, env);
  markConnectorDeliverySignal(assistant);
  return assistant;
}

export function claudeCodeOutputEventId(threadId, attemptId) {
  return `claude-code:${threadId}:${attemptId}:final`;
}

export async function existingClaudeCodeOutput(threadId, eventId, env = process.env) {
  return (await listThreadMessages(threadId, env)).find((message) => message.eventId === eventId) || null;
}

export async function recordClaudeCodeRouterTrace(message = {}, phase, context = {}, env = process.env) {
  if (!message?.routerTraceId) return null;
  return recordRouterTraceEvent({
    routerTraceId: message.routerTraceId,
    turnId: message.turnId || "",
    connector: message.connector || "",
    accountId: message.accountId || "",
    chatId: message.chatId || "",
    sourceEventId: message.sourceEventId || message.eventId || message.externalId || "",
    threadId: context.threadId || "",
    messageId: message.id || "",
    phase,
    attempt: context.attempt,
    ownerProcess: context.ownerProcess || "",
  }, env).catch(() => null);
}
