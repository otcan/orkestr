import { ThreadMessage } from "./api.service";
import { PendingFile } from "./thread-uploads";

interface OptimisticMessageOptions {
  deliveryState?: string;
  source?: string;
}

function optimisticMessageId(): string {
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function messageKey(message: ThreadMessage): string {
  return String(message.id || message.eventId || message.cursor || `${message.role}:${message.createdAt}:${message.text}`);
}

function messageTimeMs(message: ThreadMessage): number {
  const ms = Date.parse(String(message.timestamp || message.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function pendingFileAttachments(pendingFiles: PendingFile[]): Array<Record<string, unknown>> {
  return pendingFiles.map((pending) => ({
    name: pending.name,
    size: pending.size,
    type: pending.type,
    pending: true,
  }));
}

function withoutOptimisticFlags(message: ThreadMessage): ThreadMessage {
  const next = { ...message };
  delete next["localOnly"];
  delete next["optimistic"];
  return next;
}

export function createOptimisticUserMessage(text: string, pendingFiles: PendingFile[], options: OptimisticMessageOptions = {}): ThreadMessage {
  const now = new Date().toISOString();
  return {
    id: optimisticMessageId(),
    role: "user",
    source: options.source || "ui",
    text: text || (pendingFiles.length ? "Uploading attachments..." : ""),
    createdAt: now,
    timestamp: now,
    state: "queued",
    deliveryState: options.deliveryState || "sending",
    observedVia: "ui_optimistic",
    localOnly: true,
    optimistic: true,
    attachments: pendingFileAttachments(pendingFiles),
  };
}

export function updateOptimisticThreadMessage(
  messages: ThreadMessage[],
  optimisticId: string,
  patch: Partial<ThreadMessage>,
): ThreadMessage[] {
  return messages.map((message) => (message.id === optimisticId ? { ...message, ...patch } : message));
}

export function failOptimisticThreadMessage(messages: ThreadMessage[], optimisticId: string, error: string): ThreadMessage[] {
  return updateOptimisticThreadMessage(messages, optimisticId, {
    state: "failed",
    deliveryState: "failed",
    observedVia: "ui_send_failed",
    error,
  });
}

export function replaceOptimisticThreadMessage(
  messages: ThreadMessage[],
  optimisticId: string,
  serverMessage: ThreadMessage | null | undefined,
): ThreadMessage[] {
  if (!serverMessage) return messages;
  const replacement = withoutOptimisticFlags(serverMessage);
  const replacementKey = messageKey(replacement);
  let replaced = false;
  const next = messages.flatMap((message) => {
    if (message.id === optimisticId) {
      replaced = true;
      return [replacement];
    }
    if (messageKey(message) === replacementKey) return [];
    return [message];
  });
  return replaced ? next : [...next, replacement];
}

export function mergeServerMessagesWithOptimistic(
  serverMessages: ThreadMessage[],
  cachedMessages: ThreadMessage[],
): ThreadMessage[] {
  const serverKeys = new Set(serverMessages.map((message) => messageKey(message)));
  const byKey = new Map<string, ThreadMessage>();
  for (const message of cachedMessages) {
    const key = messageKey(message);
    if (Boolean(message["optimistic"]) && serverKeys.has(key)) continue;
    byKey.set(key, message);
  }
  for (const message of serverMessages) {
    byKey.set(messageKey(message), withoutOptimisticFlags(message));
  }
  return [...byKey.values()].sort((a, b) => {
    const delta = messageTimeMs(a) - messageTimeMs(b);
    if (delta !== 0) return delta;
    return messageKey(a).localeCompare(messageKey(b));
  });
}
