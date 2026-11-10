import { readThreadMessageStore } from "../../../../../packages/storage/src/thread-message-page-store.js";
import {
  messageTurnId,
  runtimeInterruptedMessage,
  visibleThreadMessages,
} from "../../../../../packages/core/src/thread-message-visibility.js";
import {
  compareChronological,
  latestPendingQuestion,
  messageCursor,
  messageTimestampMs,
  threadMessagePagePayload,
  threadMessagePageQuery,
  type ThreadMessagePageOptions,
} from "./thread-message-page.js";

// Messages fetched per round trip while walking a thread newest first.
const chunkSize = 200;
// Pollers walk more threads than a handful, and a miss on a long thread re-reads
// every row, so bound the cache by entries (~50 bytes each) rather than threads.
const maxCachedSummaries = 128;
const maxCachedSummaryEntries = 1_000_000;

type Entry = { position: number; cursor: number; ms: number };
type ThreadSummary = {
  revision: string;
  ordered: Entry[];
  cursor: number;
  minCursor: number;
  supersededMessageIds: unknown[];
  // Messages of turns with a runtime_interrupted notice, filled lazily while walking.
  turns: Map<string, any[]>;
  pendingQuestionComputed?: boolean;
  pendingQuestion?: any;
};

// Sorted per-thread summaries keyed by the store revision, so polling an unchanged thread skips the scan.
const summaries = new Map<string, ThreadSummary>();
let cachedSummaryEntries = 0;

function forgetSummary(key: string) {
  const summary = summaries.get(key);
  if (!summary) return;
  cachedSummaryEntries -= summary.ordered.length;
  summaries.delete(key);
}

// Least recently used first; the newest summary is always kept.
function rememberSummary(key: string, summary: ThreadSummary) {
  forgetSummary(key);
  summaries.set(key, summary);
  cachedSummaryEntries += summary.ordered.length;
  while (summaries.size > 1 && (summaries.size > maxCachedSummaries || cachedSummaryEntries > maxCachedSummaryEntries)) {
    forgetSummary(summaries.keys().next().value as string);
  }
}

// Number of cached thread summaries, for tests.
export function cachedThreadSummaryCount() {
  return summaries.size;
}

function threadSummary(store: any): ThreadSummary {
  const revision = store.revision();
  const cached = summaries.get(store.key);
  if (cached && cached.revision === revision) {
    // Keep recently polled threads at the young end of the eviction order.
    summaries.delete(store.key);
    summaries.set(store.key, cached);
    return cached;
  }
  const rows = store.summaries();
  const entries: Entry[] = rows.map((row: any, index: number) => ({
    position: row.position,
    cursor: messageCursor(row, index),
    ms: messageTimestampMs(row),
  }));
  let cursor = 0;
  let minCursor = Infinity;
  for (const entry of entries) {
    cursor = Math.max(cursor, entry.cursor);
    minCursor = Math.min(minCursor, entry.cursor);
  }
  const summary = {
    revision,
    // Array.prototype.sort is stable, so ties keep position order exactly like chronologicalMessages.
    ordered: entries.slice().sort(compareChronological),
    cursor,
    minCursor,
    supersededMessageIds: rows.filter((row: any) => row.supersededBy).map((row: any) => row.id),
    turns: new Map<string, any[]>(),
  };
  rememberSummary(store.key, summary);
  return summary;
}

// Visibility of a message depends only on itself and on other messages of the same turn.
function visibleMessages(store: any, turns: Map<string, any[]>, messages: any[], includeNoReply = false) {
  const turnIds = [...new Set(messages.filter(runtimeInterruptedMessage).map(messageTurnId).filter(Boolean))];
  const missing = turnIds.filter((turnId) => !turns.has(turnId));
  for (const turnId of missing) turns.set(turnId, []);
  for (const { message } of store.messagesForTurns(missing)) {
    // Only exact turn matches matter; the store query is a substring superset.
    turns.get(messageTurnId(message))?.push(message);
  }
  return new Set(visibleThreadMessages([...messages, ...turnIds.flatMap((turnId) => turns.get(turnId) || [])], { includeNoReply }));
}

// Yields visible messages newest first, loading bodies in bounded chunks.
function* visibleNewestFirst(store: any, summary: ThreadSummary, loaded: Map<number, any>, include: (entry: Entry) => boolean,
  includeNoReply = false) {
  const { ordered } = summary;
  let end = ordered.length;
  while (end > 0) {
    const chunk: Array<Entry & { index: number }> = [];
    while (end > 0 && chunk.length < chunkSize) {
      end -= 1;
      if (include(ordered[end])) chunk.push({ ...ordered[end], index: end });
    }
    const missing = chunk.map((entry) => entry.position).filter((position) => !loaded.has(position));
    for (const row of store.messagesAt(missing)) loaded.set(row.position, row.message);
    const messages = chunk.map((entry) => ({ ...loaded.get(entry.position), cursor: entry.cursor }));
    const visible = visibleMessages(store, summary.turns, messages, includeNoReply);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      if (visible.has(messages[offset])) yield { message: messages[offset], index: chunk[offset].index };
    }
  }
}

// A thread's pending-question state changes only when its message-store revision
// changes. Reuse it across the frequent unchanged-history polls from the Web UI.
export function pendingQuestionForSummary(store: any, summary: ThreadSummary) {
  if (!summary.pendingQuestionComputed) {
    const loaded = new Map<number, any>();
    const pending = (function* () {
      for (const { message } of visibleNewestFirst(store, summary, loaded, () => true)) yield message;
    })();
    summary.pendingQuestion = latestPendingQuestion(pending);
    summary.pendingQuestionComputed = true;
  }
  return summary.pendingQuestion || null;
}

// Same payload as threadMessagePage(thread, await listThreadMessages(...)) without parsing every message.
// Returns null when the thread message store is not sqlite so callers fall back to the full list.
export async function storedThreadMessagePage(thread: any, query: Record<string, unknown> = {}, status: any = null,
  options: ThreadMessagePageOptions = {}) {
  return readThreadMessageStore(thread.id, (store: any) => {
    const summary = threadSummary(store);
    const pageQuery = threadMessagePageQuery(query, options);
    const loaded = new Map<number, any>();
    const page: Array<{ message: any; index: number }> = [];
    const inRange = (entry: Entry) => pageQuery.includes({ cursor: entry.cursor, text: "x" });
    for (const item of visibleNewestFirst(store, summary, loaded, inRange, pageQuery.includeNoReply)) {
      if (!pageQuery.includes(item.message)) continue;
      page.unshift(item);
      if (page.length >= pageQuery.limit) break;
    }
    // The bridge index only feeds the eventId fallback, which never applies here: stored rows always have ids.
    return threadMessagePagePayload(thread, pageQuery, status, {
      page,
      pendingQuestion: pendingQuestionForSummary(store, summary),
      cursor: summary.cursor,
      minCursor: summary.minCursor,
      supersededMessageIds: summary.supersededMessageIds,
    });
  });
}
