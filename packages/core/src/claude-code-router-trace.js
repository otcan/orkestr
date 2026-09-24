import { recordRouterTraceEvent } from "./router-traces.js";
import { listThreadMessages } from "./threads.js";

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
