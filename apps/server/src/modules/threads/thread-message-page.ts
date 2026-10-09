import {
  getThread,
  listThreadMessages,
} from "../../../../../packages/core/src/threads.js";
import { addAttachmentDownloadUrls } from "../../../../../packages/core/src/thread-attachments.js";
import { visibleThreadMessages } from "../../../../../packages/core/src/thread-message-visibility.js";
import { publicEncryptedAttachmentMessage } from "../../../../../packages/core/src/encrypted-attachment-projection.js";
import { publicReplyDeliveryIntentMessage } from "../../../../../packages/core/src/reply-delivery-intent.js";
import { canonicalTimestamp, timestampMs } from "../../../../../packages/core/src/timestamp-normalization.js";
import {
  syncCodexRuntimeThreadMessages,
  threadUsesNativeCodexRuntime,
} from "../../../../../packages/core/src/runtime-codex-adapter.js";
import { codexThreadId } from "../../thread-summary.js";

function messageCursor(message: any, index: number): number {
  return Number(message?.cursor || 0) || index + 1;
}

function normalizedMessageTimestamp(message: any): string {
  return canonicalTimestamp(message?.timestamp) ||
    canonicalTimestamp(message?.createdAt) ||
    canonicalTimestamp(message?.updatedAt);
}

function messageTimestampMs(message: any): number {
  return timestampMs(normalizedMessageTimestamp(message));
}

export function chronologicalMessages(messages: any[] = []) {
  // Parse each timestamp once; parsing inside the comparator dominated long threads.
  return messages
    .map((message, index) => ({ message, ms: messageTimestampMs(message), cursor: messageCursor(message, index) }))
    .sort((left, right) => (left.ms !== right.ms ? left.ms - right.ms : left.cursor - right.cursor))
    .map(({ message }) => message);
}

export async function syncNativeCodexHistory(thread: any, options: Record<string, unknown> = {}) {
  if (!threadUsesNativeCodexRuntime(thread)) return thread;
  await syncCodexRuntimeThreadMessages(thread, process.env, options).catch(() => null);
  return await getThread(thread.id) || thread;
}

const scheduledNativeCodexHistorySyncs = new Set<string>();

export function scheduleNativeCodexHistorySync(thread: any, options: Record<string, unknown> = {}) {
  if (!threadUsesNativeCodexRuntime(thread)) return false;
  const threadId = String(thread?.id || "").trim();
  const nativeThreadId = codexThreadId(thread) || threadId;
  if (!threadId || !nativeThreadId) return false;
  const key = `${threadId}:${nativeThreadId}`;
  if (scheduledNativeCodexHistorySyncs.has(key)) return false;
  scheduledNativeCodexHistorySyncs.add(key);
  syncCodexRuntimeThreadMessages(thread, process.env, options)
    .catch(() => null)
    .finally(() => {
      scheduledNativeCodexHistorySyncs.delete(key);
    });
  return true;
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

function bridgeMessage(thread: any, message: any, index: number) {
  const role = String(message?.role || "assistant").trim() === "user" ? "user" : "assistant";
  const text = String(message?.text || "").trim();
  const timestamp = normalizedMessageTimestamp(message) || new Date().toISOString();
  const phase = message?.phase || (role === "assistant" ? "final_answer" : null);
  return publicReplyDeliveryIntentMessage(publicEncryptedAttachmentMessage(addAttachmentDownloadUrls(thread, {
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
  })));
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
  const previousMs = messageTimestampMs(previous);
  const currentMs = messageTimestampMs(current);
  return Boolean(previousMs && currentMs && Math.abs(currentMs - previousMs) <= 5000);
}

function codexAppServerDisplaySource(message: any): boolean {
  return ["codex-app-server", "codex-app-server-import"].includes(String(message?.source || "").trim());
}

function codexAppServerDuplicateKey(message: any): string {
  if (message?.role === "user") return ""; // Identity, not text, owns user-input deduplication.
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
  const orderedMessages = visibleThreadMessages(chronologicalMessages(rawMessages.map((message, index) => ({
    ...message, cursor: messageCursor(message, index),
  }))));
  const pendingQuestion = latestPendingQuestion(orderedMessages);
  // Select the page before bridging so only the returned messages are decorated.
  const pageIndexes: number[] = [];
  orderedMessages.forEach((message, index) => {
    if (!String(message?.text || "").trim()) return;
    const cursor = messageCursor(message, index);
    if (since > 0 && cursor <= since) return;
    if (before > 0 && cursor >= before) return;
    pageIndexes.push(index);
  });
  const messages = dedupeDisplayMessages(pageIndexes.slice(-limit).map((index) => bridgeMessage(thread, orderedMessages[index], index)));
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
    supersededMessageIds: rawMessages.filter(message => message.supersededBy).map(message => message.id),
    messages,
    cursor,
    currentCursor: cursor,
    oldestCursor,
    hasMoreBefore: oldestCursor !== null && rawMessages.some((message, index) => messageCursor(message, index) < oldestCursor),
    state: status?.state || thread.state || "sleeping",
    source: "orkestr-oss",
    staleWorking: (status as any)?.staleWorking ?? false,
    awaitingInput: !!pendingQuestion,
    awaitingInputEventId: pendingQuestion?.eventId || null,
    pendingQuestion,
  };
}

export async function threadHistoryPayload(thread: any) {
  const messages = chronologicalMessages(await listThreadMessages(thread.id))
    .map((message) => publicReplyDeliveryIntentMessage(
      publicEncryptedAttachmentMessage(addAttachmentDownloadUrls(thread, message)),
    ));
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
