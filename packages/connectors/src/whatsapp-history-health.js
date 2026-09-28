// Tracks whether WhatsApp chat history reads are degraded.
//
// A history read that only returns the account's own last message while the
// chat metadata (unread count, last activity) or the earlier-message loader
// indicates more history is a warning state: the router still sends and
// receives live messages, but it cannot see chat history. This is surfaced as
// `history_read_degraded` instead of reporting fully healthy.

import { createHash } from "node:crypto";

export const HISTORY_READ_DEGRADED = "history_read_degraded";
const MAX_CHATS_PER_ACCOUNT = 50;
const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
const LAST_ACTIVITY_SLACK_SECONDS = 60;

const reads = new Map();

function chatKey(chatId = "") {
  return createHash("sha256").update(String(chatId || "")).digest("hex").slice(0, 12);
}

function timestampSeconds(message = {}) {
  const raw = message?.timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}

export function evaluateHistoryRead({ requested = 0, messages = [], load = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const wanted = Number(requested || 0) || 0;
  const short = wanted > 1 && list.length < wanted && list.length <= 1;
  const ownOnly = list.every((message) => message?.fromMe === true);
  if (!short || !ownOnly) return { degraded: false, reasons: [] };
  const reasons = [];
  const unreadCount = Number(load?.unreadCount || 0) || 0;
  const lastActivity = Number(load?.lastActivityTimestamp || 0) || 0;
  const newest = Math.max(0, ...list.map(timestampSeconds));
  if (unreadCount > 0) reasons.push("unread_not_loaded");
  if (lastActivity > 0 && newest > 0 && lastActivity > newest + LAST_ACTIVITY_SLACK_SECONDS) reasons.push("last_activity_newer");
  if (lastActivity > 0 && list.length === 0) reasons.push("last_activity_without_messages");
  if (load && Array.isArray(load.errors) && load.errors.length) reasons.push("earlier_load_failed");
  const noProgress = load && Number(load.after || 0) <= Number(load.before || 0);
  if (noProgress && load.reachedStart === false) reasons.push("earlier_available_not_loaded");
  if (noProgress && load.reachedStart === null && Number(load.pages || 0) > 0) reasons.push("earlier_load_unconfirmed");
  if (load?.timedOut) reasons.push("earlier_load_timed_out");
  return { degraded: reasons.length > 0, reasons };
}

export function recordHistoryRead(accountId = "", chatId = "", evaluation = {}, nowMs = Date.now()) {
  const account = String(accountId || "");
  if (!account || !chatId) return;
  const chats = reads.get(account) || new Map();
  const key = chatKey(chatId);
  chats.delete(key);
  chats.set(key, {
    degraded: evaluation.degraded === true,
    reasons: Array.isArray(evaluation.reasons) ? evaluation.reasons.slice(0, 6) : [],
    observedAtMs: nowMs,
  });
  while (chats.size > MAX_CHATS_PER_ACCOUNT) chats.delete(chats.keys().next().value);
  reads.set(account, chats);
}

export function historyReadHealth(accountId = "", nowMs = Date.now()) {
  const chats = reads.get(String(accountId || ""));
  if (!chats) return null;
  let degradedChats = 0;
  let observedAtMs = 0;
  const reasons = new Set();
  for (const [key, record] of chats) {
    if (nowMs - record.observedAtMs > RECORD_TTL_MS) {
      chats.delete(key);
      continue;
    }
    observedAtMs = Math.max(observedAtMs, record.observedAtMs);
    if (!record.degraded) continue;
    degradedChats += 1;
    for (const reason of record.reasons) reasons.add(reason);
  }
  if (!chats.size) return null;
  return {
    state: degradedChats ? HISTORY_READ_DEGRADED : "ok",
    degradedChats,
    observedChats: chats.size,
    reasons: [...reasons].sort(),
    observedAt: observedAtMs ? new Date(observedAtMs).toISOString() : null,
  };
}

export function historyReadWarnings(accountId = "", nowMs = Date.now()) {
  return historyReadHealth(accountId, nowMs)?.state === HISTORY_READ_DEGRADED ? [HISTORY_READ_DEGRADED] : [];
}

export function publicHistoryReadHealth(value = null) {
  if (!value || typeof value !== "object") return null;
  const clean = (text) => String(text || "").replace(/[^a-z0-9_]/gi, "_").slice(0, 60);
  return {
    state: clean(value.state),
    degradedChats: Number(value.degradedChats || 0) || 0,
    observedChats: Number(value.observedChats || 0) || 0,
    reasons: Array.isArray(value.reasons) ? value.reasons.map(clean).slice(0, 8) : [],
    observedAt: typeof value.observedAt === "string" ? value.observedAt : null,
  };
}

export function resetHistoryReadHealthForTest() {
  reads.clear();
}
