import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { fingerprintAlgorithm, mediaKindForAttachment } from "./whatsapp-media-fingerprint.js";
import { acquireFileLock, sidecarLockOwnerPath, sidecarLockPath, withFileLock } from "./whatsapp-media-echo-lock.js";

const defaultRecordLimit = 500;
const ledgerQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function positiveCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

export function transformedMediaEchoRecordLimit(env = process.env) {
  return clampInteger(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_LEDGER_LIMIT, defaultRecordLimit, 50, 5000);
}

function transformedMediaEchoTerminalEventTtlMs(env = process.env) {
  return clampInteger(
    env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_EVENT_TTL_MS,
    24 * 60 * 60 * 1000,
    60_000,
    30 * 24 * 60 * 60 * 1000,
  );
}

function ledgerPath(env = process.env) {
  return clean(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_LEDGER) ||
    path.join(dataPaths(env).home, "whatsapp-transformed-media-echo-ledger.json");
}

export async function withTransformedMediaEchoLedger(env, work) {
  const filePath = ledgerPath(env);
  const previous = ledgerQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => null).then(() => withFileLock(filePath, env, work));
  const stored = next.catch(() => null).finally(() => {
    if (ledgerQueues.get(filePath) === stored) ledgerQueues.delete(filePath);
  });
  ledgerQueues.set(filePath, stored);
  return next;
}

export function transformedMediaEchoLedgerLockPathForTest(env = process.env) {
  return sidecarLockPath(ledgerPath(env));
}

export function transformedMediaEchoLedgerLockOwnerPathForTest(env = process.env, token = "") {
  return sidecarLockOwnerPath(sidecarLockPath(ledgerPath(env)), token);
}

export async function acquireTransformedMediaEchoLedgerLockForTest(env = process.env, options = {}) {
  await ensureDataDirs(env);
  return acquireFileLock(ledgerPath(env), env, options);
}

function safeRecord(record = {}, nowMs = Date.now()) {
  const accountId = clean(record.accountId);
  const chatId = clean(record.chatId);
  const mediaKind = clean(record.mediaKind);
  const hash = clean(record.fingerprint?.value || record.fingerprintHash);
  const colorHash = clean(record.fingerprint?.colorValue || record.fingerprintColorHash);
  const colorMoments = Array.isArray(record.fingerprint?.colorMoments)
    ? record.fingerprint.colorMoments.map(Number).filter((value) => Number.isFinite(value)).slice(0, 6)
    : [];
  const informationScore = Number(record.fingerprint?.informationScore ?? record.informationScore);
  const uniqueColorBuckets = Number(record.fingerprint?.uniqueColorBuckets ?? record.uniqueColorBuckets);
  const lumaStddev = Number(record.fingerprint?.lumaStddev ?? record.lumaStddev);
  const edgeScore = Number(record.fingerprint?.edgeScore ?? record.edgeScore);
  const sentAtMs = Number(record.sentAtMs);
  const expiresAtMs = Number(record.expiresAtMs);
  if (!accountId || !chatId || mediaKind !== "image" || !hash || !colorHash || colorMoments.length !== 6 || !Number.isFinite(sentAtMs) || !Number.isFinite(expiresAtMs)) return null;
  if (expiresAtMs <= nowMs) return null;
  return {
    id: clean(record.id) || crypto.randomUUID(),
    accountId,
    chatId,
    mediaKind,
    crossAccount: record.crossAccount === true,
    deliveredMessageId: clean(record.deliveredMessageId),
    sentAtMs,
    expiresAtMs,
    fingerprint: {
      algorithm: clean(record.fingerprint?.algorithm) || fingerprintAlgorithm,
      value: hash,
      colorValue: colorHash,
      colorMoments,
      informationScore: Number.isFinite(informationScore) ? Math.max(0, informationScore) : 0,
      uniqueColorBuckets: Number.isFinite(uniqueColorBuckets) ? Math.max(0, Math.floor(uniqueColorBuckets)) : 0,
      lumaStddev: Number.isFinite(lumaStddev) ? Math.max(0, lumaStddev) : 0,
      edgeScore: Number.isFinite(edgeScore) ? Math.max(0, edgeScore) : 0,
    },
    width: clampInteger(record.width, 0, 0, 100_000),
    height: clampInteger(record.height, 0, 0, 100_000),
  };
}

function terminalEventKey({ accountId = "", chatId = "", eventId = "" } = {}) {
  const account = clean(accountId);
  const chat = clean(chatId);
  const event = clean(eventId);
  if (!account || !chat || !event) return "";
  return crypto.createHash("sha256").update(account).update("\0").update(chat).update("\0").update(event).digest("hex");
}

function terminalReplayAuditId(key = "") {
  const scoped = clean(key);
  return scoped ? `whatsapp-transformed-terminal-replay:${scoped}` : "";
}

function safeReplayAudit(record = {}, key = "") {
  const audit = record && typeof record.replayAudit === "object" && !Array.isArray(record.replayAudit)
    ? record.replayAudit
    : {};
  const id = clean(audit.id || record.replayAuditId) || terminalReplayAuditId(key);
  if (!id) return null;
  const legacyRecordedAt = clean(record.replayAuditRecordedAt);
  const recordedAt = clean(audit.recordedAt) || legacyRecordedAt;
  const rawState = clean(audit.state || record.replayAuditState).toLowerCase();
  const state = recordedAt || rawState === "recorded"
    ? "recorded"
    : (rawState === "pending" ? "pending" : "");
  if (!state) return null;
  return {
    id,
    state,
    attempts: positiveCount(audit.attempts ?? record.replayAuditAttempts),
    ...(clean(audit.pendingAt || record.replayAuditPendingAt) ? { pendingAt: clean(audit.pendingAt || record.replayAuditPendingAt) } : {}),
    ...(recordedAt ? { recordedAt } : {}),
    ...(clean(audit.updatedAt || record.replayAuditUpdatedAt) ? { updatedAt: clean(audit.updatedAt || record.replayAuditUpdatedAt) } : {}),
  };
}

function safeTerminalEvent(record = {}, nowMs = Date.now()) {
  const accountId = clean(record.accountId);
  const chatId = clean(record.chatId);
  const eventId = clean(record.eventId);
  const key = clean(record.key) || terminalEventKey({ accountId, chatId, eventId });
  const expiresAtMs = Number(record.expiresAtMs);
  const recordedAtMs = Number(record.recordedAtMs);
  if (!accountId || !chatId || !eventId || !key || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  const replayAudit = safeReplayAudit(record, key);
  return {
    key,
    accountId,
    chatId,
    eventId,
    skipped: clean(record.skipped) || "outbound_echo_attachment_transformed",
    mode: clean(record.mode) || "enforce",
    matchedAttachmentCount: positiveCount(record.matchedAttachmentCount),
    retainedAttachmentCount: positiveCount(record.retainedAttachmentCount),
    recordedAtMs: Number.isFinite(recordedAtMs) ? recordedAtMs : nowMs,
    expiresAtMs,
    ...(replayAudit ? { replayAudit } : {}),
  };
}

export function appendTransformedMediaEchoTerminalSuppression(ledger = {}, {
  accountId = "",
  chatId = "",
  eventId = "",
  result = {},
  env = process.env,
  nowMs = Date.now(),
} = {}) {
  const key = terminalEventKey({ accountId, chatId, eventId });
  if (!key) return { ledger, record: null };
  const record = {
    key,
    accountId: clean(accountId),
    chatId: clean(chatId),
    eventId: clean(eventId),
    skipped: "outbound_echo_attachment_transformed",
    mode: clean(result.mode) || "enforce",
    matchedAttachmentCount: positiveCount(result.matched?.length || result.matchedAttachmentCount),
    retainedAttachmentCount: (Array.isArray(result.attachments) ? result.attachments : [])
      .filter((attachment) => mediaKindForAttachment(attachment) === "image").length,
    recordedAtMs: nowMs,
    expiresAtMs: nowMs + transformedMediaEchoTerminalEventTtlMs(env),
  };
  const existing = new Map((Array.isArray(ledger?.terminalEvents) ? ledger.terminalEvents : [])
    .map((event) => [event.key, event]));
  const previous = existing.get(key);
  existing.set(key, previous?.replayAudit ? { ...record, replayAudit: previous.replayAudit } : record);
  // Terminal replay fences are bounded by TTL, not count. Count eviction can
  // reopen exact event-ID redelivery holes while fences are still valid.
  const terminalEvents = [...existing.values()]
    .sort((left, right) => right.recordedAtMs - left.recordedAtMs);
  return { ledger: { ...ledger, terminalEvents }, record };
}

export async function readTransformedMediaEchoLedger(filePath, env = process.env) {
  const nowMs = Date.now();
  const raw = await readJson(filePath, { version: 1, records: [], terminalEvents: [] });
  const records = (Array.isArray(raw?.records) ? raw.records : [])
    .map((record) => safeRecord(record, nowMs))
    .filter(Boolean)
    .sort((left, right) => right.sentAtMs - left.sentAtMs)
    .slice(0, transformedMediaEchoRecordLimit(env));
  const terminalEvents = (Array.isArray(raw?.terminalEvents) ? raw.terminalEvents : [])
    .map((event) => safeTerminalEvent(event, nowMs))
    .filter(Boolean)
    .sort((left, right) => right.recordedAtMs - left.recordedAtMs);
  return { version: 1, records, terminalEvents };
}

export async function writeTransformedMediaEchoLedger(filePath, ledger) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJson(filePath, {
    version: 1,
    records: Array.isArray(ledger?.records) ? ledger.records : [],
    terminalEvents: Array.isArray(ledger?.terminalEvents) ? ledger.terminalEvents : [],
  });
}

export async function findTransformedMediaEchoTerminalSuppression({
  accountId = "",
  chatId = "",
  eventId = "",
  env = process.env,
} = {}) {
  const key = terminalEventKey({ accountId, chatId, eventId });
  if (!key) return null;
  await ensureDataDirs(env);
  return withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const event = ledger.terminalEvents.find((item) => item.key === key) || null;
    return event ? { ...event } : null;
  });
}

export async function claimTransformedMediaEchoTerminalReplayAudit({
  accountId = "",
  chatId = "",
  eventId = "",
  env = process.env,
} = {}) {
  const key = terminalEventKey({ accountId, chatId, eventId });
  if (!key) return null;
  await ensureDataDirs(env);
  return withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const terminalEvents = Array.isArray(ledger.terminalEvents) ? [...ledger.terminalEvents] : [];
    const index = terminalEvents.findIndex((item) => item.key === key);
    if (index < 0) return null;
    const event = terminalEvents[index];
    const auditId = terminalReplayAuditId(key);
    const audit = safeReplayAudit(event, key);
    if (audit?.state === "recorded") {
      return { ...event, replayAudit: audit, replayAuditId: audit.id, replayAuditNeeded: false };
    }
    const now = new Date().toISOString();
    const nextAudit = {
      id: audit?.id || auditId,
      state: "pending",
      attempts: positiveCount(audit?.attempts) + 1,
      pendingAt: audit?.pendingAt || now,
      updatedAt: now,
    };
    const nextEvent = { ...event, replayAudit: nextAudit };
    terminalEvents[index] = nextEvent;
    await writeTransformedMediaEchoLedger(filePath, { ...ledger, terminalEvents });
    return { ...nextEvent, replayAuditId: nextAudit.id, replayAuditNeeded: true };
  });
}

export async function recordTransformedMediaEchoTerminalReplayAudit({
  accountId = "",
  chatId = "",
  eventId = "",
  auditId = "",
  env = process.env,
} = {}) {
  const key = terminalEventKey({ accountId, chatId, eventId });
  if (!key) return { recorded: false, reason: "missing_scope" };
  await ensureDataDirs(env);
  return withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const terminalEvents = Array.isArray(ledger.terminalEvents) ? [...ledger.terminalEvents] : [];
    const index = terminalEvents.findIndex((item) => item.key === key);
    if (index < 0) return { recorded: false, reason: "terminal_event_not_found" };
    const event = terminalEvents[index];
    const audit = safeReplayAudit(event, key);
    const expectedAuditId = audit?.id || terminalReplayAuditId(key);
    const scopedAuditId = clean(auditId) || expectedAuditId;
    if (scopedAuditId !== expectedAuditId) return { recorded: false, reason: "audit_id_mismatch" };
    if (audit?.state === "recorded") {
      return { recorded: true, alreadyRecorded: true, event: { ...event, replayAudit: audit } };
    }
    const now = new Date().toISOString();
    const nextAudit = {
      id: expectedAuditId,
      state: "recorded",
      attempts: positiveCount(audit?.attempts),
      pendingAt: audit?.pendingAt || now,
      recordedAt: now,
      updatedAt: now,
    };
    const nextEvent = { ...event, replayAudit: nextAudit };
    terminalEvents[index] = nextEvent;
    await writeTransformedMediaEchoLedger(filePath, { ...ledger, terminalEvents });
    return { recorded: true, event: nextEvent };
  });
}

export async function rememberTransformedMediaEchoTerminalSuppression({
  accountId = "",
  chatId = "",
  eventId = "",
  result = {},
  env = process.env,
} = {}) {
  await ensureDataDirs(env);
  let record = null;
  await withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const appended = appendTransformedMediaEchoTerminalSuppression(ledger, { accountId, chatId, eventId, result, env });
    record = appended.record;
    if (!record) return;
    await writeTransformedMediaEchoLedger(filePath, appended.ledger);
  });
  if (!record) return { recorded: false, reason: "missing_scope" };
  return { recorded: true, event: record };
}
