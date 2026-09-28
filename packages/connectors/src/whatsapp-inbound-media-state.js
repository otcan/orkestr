// Persisted per-message inbound media state for the local WhatsApp bridge.
//
// One entry per `${accountId}:${eventId}` with media:
//   delivered        media saved; replays reuse the saved files (no re-download)
//   pending_retry    inline attempts failed; next delayed attempt at `nextAt`
//   failed_terminal  delayed attempts exhausted; resend notice posted
//   skipped          a delayed attempt settled without media (echo, empty, ...)
// The periodic unread/recent scan re-reads the same messages every ~10s, so
// this state is what stops a single message from being reprocessed dozens of
// times. Entries are bounded by TTL and count.

import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { withFileLock } from "./whatsapp-media-echo-lock.js";

export const INBOUND_MEDIA_STATES = Object.freeze(["delivered", "pending_retry", "failed_terminal", "skipped"]);
export const DEFAULT_INBOUND_MEDIA_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);

const HOUR_MS = 60 * 60_000;
const stateQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

export function inboundMediaStateKey(accountId = "", eventId = "") {
  const account = clean(accountId) || "default";
  const event = clean(eventId);
  return event ? `${account}:${event}` : "";
}

export function inboundMediaStatePath(env = process.env) {
  return path.join(dataPaths(env).home, "whatsapp-inbound-media-state.json");
}

// Delays are offsets from the first failed processing cycle. `off`/`0`
// disables delayed retries so the first failed cycle is terminal.
export function inboundMediaRetryDelaysMs(env = process.env) {
  const raw = env.ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS ?? env.WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS;
  if (raw === undefined) return [...DEFAULT_INBOUND_MEDIA_RETRY_DELAYS_MS];
  const text = clean(raw).toLowerCase();
  if (!text || ["0", "off", "none", "false", "no"].includes(text)) return [];
  const parsed = text.split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.max(1_000, Math.min(6 * HOUR_MS, Math.floor(value))))
    .sort((a, b) => a - b)
    .slice(0, 6);
  return parsed.length ? parsed : [...DEFAULT_INBOUND_MEDIA_RETRY_DELAYS_MS];
}

function positiveMs(raw, fallback, min, max) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function retentionLimits(env = process.env) {
  return {
    maxEntries: positiveMs(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_STATE_LIMIT, 2000, 100, 20_000),
    deliveredTtlMs: positiveMs(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_DELIVERED_TTL_MS, 24 * HOUR_MS, 60_000, 30 * 24 * HOUR_MS),
    terminalTtlMs: positiveMs(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_TERMINAL_TTL_MS, 7 * 24 * HOUR_MS, 60_000, 90 * 24 * HOUR_MS),
    pendingMaxAgeMs: positiveMs(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_PENDING_MAX_AGE_MS, 24 * HOUR_MS, 60_000, 30 * 24 * HOUR_MS),
  };
}

function entryTimeMs(entry = {}) {
  return Date.parse(entry.updatedAt || entry.firstFailedAt || entry.deliveredAt || "") || 0;
}

export function pruneInboundMediaEntries(entries = {}, env = process.env, nowMs = Date.now()) {
  const limits = retentionLimits(env);
  const kept = Object.values(entries && typeof entries === "object" ? entries : {}).filter((entry) => {
    if (!entry?.key || !INBOUND_MEDIA_STATES.includes(entry.state)) return false;
    const age = nowMs - entryTimeMs(entry);
    if (entry.state === "pending_retry") {
      const firstFailedMs = Date.parse(entry.firstFailedAt || "") || entryTimeMs(entry);
      return nowMs - firstFailedMs <= limits.pendingMaxAgeMs;
    }
    if (entry.state === "failed_terminal") return age <= limits.terminalTtlMs;
    return age <= limits.deliveredTtlMs;
  });
  kept.sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
  const bounded = kept.length > limits.maxEntries ? kept.slice(kept.length - limits.maxEntries) : kept;
  return Object.fromEntries(bounded.map((entry) => [entry.key, entry]));
}

async function withState(env, work) {
  const filePath = inboundMediaStatePath(env);
  const previous = stateQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => null).then(() => withFileLock(filePath, env, work));
  const stored = next.catch(() => null).finally(() => {
    if (stateQueues.get(filePath) === stored) stateQueues.delete(filePath);
  });
  stateQueues.set(filePath, stored);
  return next;
}

async function readEntries(filePath) {
  const state = await readJson(filePath, {}).catch(() => ({}));
  return state?.entries && typeof state.entries === "object" ? state.entries : {};
}

export async function readInboundMediaStateEntries(env = process.env) {
  return readEntries(inboundMediaStatePath(env));
}

export async function readInboundMediaState(accountId = "", eventId = "", env = process.env) {
  const key = inboundMediaStateKey(accountId, eventId);
  if (!key) return null;
  return (await readEntries(inboundMediaStatePath(env)))[key] || null;
}

// Read-modify-write one entry under the file lock. `mutate(entry|null)`
// returns the new entry, `null` to delete, or `undefined` to leave unchanged.
export async function updateInboundMediaState(accountId = "", eventId = "", mutate = () => undefined, env = process.env, { nowMs = Date.now() } = {}) {
  const key = inboundMediaStateKey(accountId, eventId);
  if (!key) return { entry: null, previous: null };
  return withState(env, async (filePath) => {
    const entries = await readEntries(filePath);
    const previous = entries[key] ? { ...entries[key] } : null;
    const next = await mutate(previous ? { ...previous } : null);
    if (next === undefined) return { entry: previous, previous };
    if (next === null) delete entries[key];
    else entries[key] = { ...next, key, accountId: clean(accountId) || "default", eventId: clean(eventId), updatedAt: new Date(nowMs).toISOString() };
    await writeJson(filePath, {
      entries: pruneInboundMediaEntries(entries, env, nowMs),
      updatedAt: new Date(nowMs).toISOString(),
    });
    return { entry: next === null ? null : entries[key], previous };
  });
}

async function attachmentsStillOnDisk(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return false;
  for (const attachment of attachments) {
    const stat = await fs.stat(String(attachment?.path || "")).catch(() => null);
    if (!stat?.isFile()) return false;
  }
  return true;
}

// Decides what a (re)processing cycle may do with a media message.
//   { action: "process" }                   download normally
//   { action: "reuse", attachments }        already delivered; reuse saved files
//   { action: "skip", reason, entry }       pending/terminal; do not reprocess
// `scheduledAttempt` is set only by the delayed retry runner and `explicit`
// only by operator-requested exact recovery.
export async function inboundMediaProcessingGate({ accountId = "", eventId = "", scheduledAttempt = 0, explicit = false } = {}, env = process.env) {
  const entry = await readInboundMediaState(accountId, eventId, env).catch(() => null);
  if (!entry) return { action: "process" };
  if (entry.state === "delivered") {
    if (await attachmentsStillOnDisk(entry.attachments)) return { action: "reuse", attachments: entry.attachments, entry };
    return { action: "process", entry };
  }
  if (entry.state === "pending_retry") {
    if (scheduledAttempt > 0 || explicit) return { action: "process", entry };
    return { action: "skip", reason: "inbound_media_retry_pending", entry };
  }
  if (explicit) return { action: "process", entry };
  return { action: "skip", reason: entry.state === "failed_terminal" ? "inbound_media_failed_terminal" : "inbound_media_retry_settled", entry };
}

export async function markInboundMediaDelivered({ accountId = "", eventId = "", chatId = "", messageType = "", attachments = [] } = {}, env = process.env, { nowMs = Date.now() } = {}) {
  return updateInboundMediaState(accountId, eventId, (entry) => ({
    ...(entry || {}),
    state: "delivered",
    chatId: clean(chatId) || entry?.chatId || "",
    messageType: clean(messageType) || entry?.messageType || "",
    attempt: Number(entry?.attempt || 0) || 0,
    nextAt: null,
    deliveredAt: new Date(nowMs).toISOString(),
    recoveredAfterRetry: entry?.state === "pending_retry" || entry?.state === "failed_terminal",
    attachments: (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
      path: String(attachment?.path || ""),
      filename: String(attachment?.filename || ""),
      mimetype: String(attachment?.mimetype || ""),
      kind: String(attachment?.kind || ""),
      size: Number(attachment?.size || 0) || 0,
    })),
  }), env, { nowMs });
}

// Records one failed processing cycle. `scheduledAttempt` is the delayed
// attempt number that just failed (0 for the first, inline cycle).
export async function recordInboundMediaFailedCycle({ accountId = "", eventId = "", chatId = "", messageType = "", scheduledAttempt = 0, diagnostics = null } = {}, env = process.env, { nowMs = Date.now() } = {}) {
  const delays = inboundMediaRetryDelaysMs(env);
  return updateInboundMediaState(accountId, eventId, (entry) => {
    const firstFailedMs = entry?.state === "pending_retry" || entry?.state === "failed_terminal"
      ? (Date.parse(entry.firstFailedAt || "") || nowMs)
      : nowMs;
    const attempt = Math.max(Number(scheduledAttempt || 0) || 0, entry?.state === "pending_retry" ? Number(entry.attempt || 0) || 0 : 0);
    const base = {
      ...(entry || {}),
      chatId: clean(chatId) || entry?.chatId || "",
      messageType: clean(messageType) || entry?.messageType || "",
      attempt,
      firstFailedAt: new Date(firstFailedMs).toISOString(),
      lastFailedAt: new Date(nowMs).toISOString(),
      lastDiagnostics: diagnostics || entry?.lastDiagnostics || null,
      attachments: [],
    };
    if (entry?.state === "failed_terminal") return { ...base, state: "failed_terminal", nextAt: null };
    if (attempt < delays.length) {
      const nextMs = Math.max(nowMs + 1_000, firstFailedMs + delays[attempt]);
      return { ...base, state: "pending_retry", nextAt: new Date(nextMs).toISOString() };
    }
    return { ...base, state: "failed_terminal", nextAt: null, terminalAt: new Date(nowMs).toISOString() };
  }, env, { nowMs });
}

export async function deferInboundMediaRetry({ accountId = "", eventId = "", delayMs = 60_000, reason = "" } = {}, env = process.env, { nowMs = Date.now() } = {}) {
  return updateInboundMediaState(accountId, eventId, (entry) => {
    if (entry?.state !== "pending_retry") return undefined;
    return {
      ...entry,
      nextAt: new Date(nowMs + Math.max(1_000, Number(delayMs) || 60_000)).toISOString(),
      deferrals: (Number(entry.deferrals || 0) || 0) + 1,
      lastDeferredReason: clean(reason),
    };
  }, env, { nowMs });
}

export async function settleInboundMediaRetrySkipped({ accountId = "", eventId = "", reason = "" } = {}, env = process.env, { nowMs = Date.now() } = {}) {
  return updateInboundMediaState(accountId, eventId, (entry) => {
    if (entry?.state !== "pending_retry") return undefined;
    return { ...entry, state: "skipped", nextAt: null, skippedReason: clean(reason) };
  }, env, { nowMs });
}

export async function dueInboundMediaRetries(env = process.env, { nowMs = Date.now(), limit = 5 } = {}) {
  const entries = Object.values(await readInboundMediaStateEntries(env).catch(() => ({})));
  return entries
    .filter((entry) => entry?.state === "pending_retry" && (Date.parse(entry.nextAt || "") || 0) <= nowMs)
    .sort((a, b) => (Date.parse(a.nextAt || "") || 0) - (Date.parse(b.nextAt || "") || 0))
    .slice(0, Math.max(1, limit));
}
