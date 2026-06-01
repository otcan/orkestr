import {
  getThread,
  listThreadMessages,
} from "../../../../../packages/core/src/threads.js";
import { visibleThreadMessages } from "../../../../../packages/core/src/thread-message-visibility.js";
import {
  syncCodexRuntimeThreadMessages,
  threadUsesNativeCodexRuntime,
} from "../../../../../packages/core/src/runtime-codex-adapter.js";
import { codexThreadId } from "../../thread-summary.js";

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

function messageTimestampMs(message: any): number {
  const ms = Date.parse(String(message?.timestamp || message?.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

export function chronologicalMessages(messages: any[] = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftMs = messageTimestampMs(left.message);
      const rightMs = messageTimestampMs(right.message);
      if (leftMs && rightMs && leftMs !== rightMs) return leftMs - rightMs;
      if (leftMs !== rightMs) return leftMs - rightMs;
      return messageCursor(left.message, left.index) - messageCursor(right.message, right.index);
    })
    .map(({ message }) => message);
}

export async function syncNativeCodexHistory(thread: any, options: Record<string, unknown> = {}) {
  if (!threadUsesNativeCodexRuntime(thread)) return thread;
  await syncCodexRuntimeThreadMessages(thread, process.env, options).catch(() => null);
  return await getThread(thread.id) || thread;
}

const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);

function isNeedInputMessage(message: any): boolean {
  const role = String(message?.role || message?.kind || "assistant").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  return role === "assistant" && needInputPhases.has(phase) && !!String(message?.text || "").trim();
}

function latestPendingQuestion(messages: any[] = []) {
  let userRepliedAfterQuestion = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = String(message?.text || "").trim();
    if (!text) continue;
    const role = String(message?.role || message?.kind || "").trim().toLowerCase();
    if (role === "user") {
      userRepliedAfterQuestion = true;
      continue;
    }
    if (!isNeedInputMessage(message)) continue;
    if (userRepliedAfterQuestion) return null;
    const timestamp = message?.timestamp || message?.createdAt || null;
    const eventId = String(message?.eventId || message?.id || "").trim() || null;
    return {
      text,
      eventId,
      messageId: message?.id || null,
      cursor: messageCursor(message, index),
      timestamp,
      phase: message?.phase || null,
    };
  }
  return null;
}

function bridgeMessage(message: any, index: number) {
  const role = String(message?.role || "assistant").trim() === "user" ? "user" : "assistant";
  const text = String(message?.text || "").trim();
  const timestamp = message?.timestamp || message?.createdAt || new Date().toISOString();
  const phase = message?.phase || (role === "assistant" ? "final_answer" : null);
  return {
    ...message,
    cursor: messageCursor(message, index),
    timestamp,
    role,
    kind: role,
    phase,
    source: message?.source || "thread",
    stable: true,
    text,
    eventId: message?.eventId || message?.id || `${timestamp}:${index}`,
    awaitingInputCandidate: isNeedInputMessage({ ...message, role, phase, text }),
  };
}

function normalizedMessageText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const liveCodexDisplaySources = new Set(["codex-rollout", "codex-app-server", "codex-app-server-import"]);

function liveCodexDisplaySource(message: any): boolean {
  return liveCodexDisplaySources.has(String(message?.source || "").trim());
}

function duplicateAdjacentAssistant(previous: any, current: any): boolean {
  if (!previous || !current) return false;
  if (previous.role !== "assistant" || current.role !== "assistant") return false;
  if (!liveCodexDisplaySource(previous) || !liveCodexDisplaySource(current)) return false;
  if (String(previous.phase || "") !== String(current.phase || "")) return false;
  if (!normalizedMessageText(current.text) || normalizedMessageText(previous.text) !== normalizedMessageText(current.text)) return false;
  const previousMs = Date.parse(String(previous.timestamp || previous.createdAt || ""));
  const currentMs = Date.parse(String(current.timestamp || current.createdAt || ""));
  return Number.isFinite(previousMs) && Number.isFinite(currentMs) && Math.abs(currentMs - previousMs) <= 5000;
}

function codexAppServerDisplaySource(message: any): boolean {
  return ["codex-app-server", "codex-app-server-import"].includes(String(message?.source || "").trim());
}

function codexAppServerDuplicateKey(message: any): string {
  if (!codexAppServerDisplaySource(message)) return "";
  const text = normalizedMessageText(message?.text);
  const appServerThreadId = String(message?.codexThreadId || message?.executorThreadId || "").trim();
  const appServerTurnId = String(message?.codexTurnId || message?.executorTurnId || "").trim();
  if (!text || !appServerThreadId || !appServerTurnId) return "";
  return [
    appServerThreadId,
    appServerTurnId,
    String(message?.role || ""),
    String(message?.phase || ""),
    text,
  ].join("\n");
}

function dedupeDisplayMessages(messages: any[] = []) {
  const deduped: any[] = [];
  const seenCodexAppServerKeys = new Set<string>();
  for (const message of messages) {
    if (duplicateAdjacentAssistant(deduped.at(-1), message)) continue;
    const codexAppServerKey = codexAppServerDuplicateKey(message);
    if (codexAppServerKey) {
      if (seenCodexAppServerKeys.has(codexAppServerKey)) continue;
      seenCodexAppServerKeys.add(codexAppServerKey);
    }
    deduped.push(message);
  }
  return deduped;
}

export function threadMessagePage(thread: any, rawMessages: any[] = [], query: Record<string, unknown> = {}, status: any = null) {
  const since = Math.max(0, Number.parseInt(String(query.since || "0"), 10) || 0);
  const before = Math.max(0, Number.parseInt(String(query.before || "0"), 10) || 0);
  const requestedLimit = Math.max(0, Number.parseInt(String(query.limit || "0"), 10) || 0);
  const limit = requestedLimit ? Math.min(requestedLimit, 100) : 100;
  const orderedMessages = visibleThreadMessages(chronologicalMessages(rawMessages));
  const pendingQuestion = latestPendingQuestion(orderedMessages);
  let messages = dedupeDisplayMessages(orderedMessages.map(bridgeMessage).filter((message) => message.text));
  if (since > 0) messages = messages.filter((message) => Number(message.cursor || 0) > since);
  if (before > 0) messages = messages.filter((message) => Number(message.cursor || 0) < before);
  messages = messages.slice(-limit);
  const allCursors = rawMessages.map((message, index) => messageCursor(message, index));
  const cursor = Math.max(0, ...allCursors);
  const oldestCursor = messages.length ? Number(messages[0]?.cursor || 0) : null;
  return {
    thread,
    orkestrThreadId: thread.id,
    threadId: codexThreadId(thread) || thread.id,
    codexThreadId: codexThreadId(thread) || null,
    since,
    before,
    limit,
    count: messages.length,
    messages,
    cursor,
    currentCursor: cursor,
    oldestCursor,
    hasMoreBefore: oldestCursor !== null && rawMessages.some((message, index) => messageCursor(message, index) < oldestCursor),
    state: status?.state || thread.state || "sleeping",
    source: "orkestr-oss",
    staleWorking: false,
    awaitingInput: !!pendingQuestion,
    awaitingInputEventId: pendingQuestion?.eventId || null,
    pendingQuestion,
  };
}

export async function threadHistoryPayload(thread: any) {
  const messages = chronologicalMessages(await listThreadMessages(thread.id));
  return {
    thread,
    orkestrThreadId: thread.id,
    threadId: codexThreadId(thread) || thread.id,
    codexThreadId: codexThreadId(thread) || null,
    messages,
    count: messages.length,
    updatedAt: messages.at(-1)?.createdAt || thread.updatedAt || null,
  };
}
