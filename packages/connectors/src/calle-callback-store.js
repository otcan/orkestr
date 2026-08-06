import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";

export function clean(value = "") {
  return String(value || "").trim();
}

export function cleanText(value = "", max = 20_000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizePhone(value = "") {
  const text = clean(value);
  if (!text || /^(anonymous|unknown|restricted)$/i.test(text)) return "";
  return text.replace(/[^\d+]/g, "");
}

export function isCallablePhone(value = "") {
  return /^\+\d{7,18}$/.test(normalizePhone(value));
}

export function normalizeStatus(value = "") {
  const status = clean(value).toUpperCase();
  return status || "UNKNOWN";
}

export function normalizeRecord(record = {}) {
  const createdAt = clean(record.createdAt) || nowIso();
  const attempts = Math.max(0, Number(record.attempts || 0) || 0);
  return {
    id: clean(record.id) || randomUUID(),
    ownerUserId: normalizeUserId(record.ownerUserId || record.userId || adminUserId),
    callSid: clean(record.callSid),
    caller: normalizePhone(record.caller),
    called: normalizePhone(record.called),
    status: clean(record.status) || "queued",
    phase: clean(record.phase).slice(0, 200),
    reason: clean(record.reason).slice(0, 500),
    attempts,
    retryable: Boolean(record.retryable),
    recovery: cleanText(record.recovery, 1000),
    runId: clean(record.runId),
    callStatus: normalizeStatus(record.callStatus),
    summary: cleanText(record.summary, 5000),
    transcript: cleanText(record.transcript, 20_000),
    draftId: clean(record.draftId),
    error: clean(record.error).slice(0, 500),
    createdAt,
    startedAt: clean(record.startedAt),
    updatedAt: clean(record.updatedAt) || createdAt,
    completedAt: clean(record.completedAt),
    notifiedAt: clean(record.notifiedAt),
  };
}

function callbackStorePath(env = process.env) {
  return dataPaths(env).twilioVoiceCallbacks;
}

function normalizeStore(payload = {}) {
  const callbacks = Array.isArray(payload.callbacks) ? payload.callbacks.map(normalizeRecord) : [];
  return { schemaVersion: 1, callbacks };
}

async function ensureParent(filePath = "") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function acquireCallbackStoreLock(env = process.env, options = {}) {
  const filePath = callbackStorePath(env);
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  const timeoutMs = Math.max(250, Number(options.lockTimeoutMs || env.ORKESTR_TWILIO_CALLBACK_LOCK_TIMEOUT_MS || 5000) || 5000);
  const staleMs = Math.max(1000, Number(options.lockStaleMs || env.ORKESTR_TWILIO_CALLBACK_LOCK_STALE_MS || 30_000) || 30_000);
  await ensureParent(filePath);
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`, { mode: 0o600 });
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        const moved = await fs.rename(lockPath, stalePath).then(() => true, () => false);
        if (moved) await fs.rm(stalePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const lockError = new Error("twilio_calle_callback_store_locked");
        lockError.statusCode = 503;
        throw lockError;
      }
      await sleep(10 + Math.floor(Math.random() * 25));
    }
  }
}

export async function readCallbackStore(env = process.env) {
  return normalizeStore(await readJson(callbackStorePath(env), { schemaVersion: 1, callbacks: [] }));
}

async function writeCallbackStore(store = {}, env = process.env) {
  const callbacks = Array.isArray(store.callbacks) ? store.callbacks.map(normalizeRecord).slice(0, 500) : [];
  await writeJson(callbackStorePath(env), { schemaVersion: 1, callbacks, updatedAt: nowIso() });
}

export async function mutateCallbackStore(env = process.env, mutator, options = {}) {
  const release = await acquireCallbackStoreLock(env, options);
  try {
    const store = await readCallbackStore(env);
    const result = await mutator(store);
    await writeCallbackStore(store, env);
    return result;
  } finally {
    await release();
  }
}

export async function updateCallbackRecord(recordId = "", patch = {}, env = process.env) {
  return mutateCallbackStore(env, async (store) => {
    const index = store.callbacks.findIndex((item) => item.id === clean(recordId));
    if (index < 0) return null;
    const existing = normalizeRecord(store.callbacks[index]);
    const patchPayload = typeof patch === "function" ? await patch(existing) : patch;
    const record = normalizeRecord({ ...existing, ...patchPayload, updatedAt: nowIso() });
    store.callbacks[index] = record;
    return record;
  });
}

const retryClaimStatuses = new Set(["failed", "terminal_failed", "timed_out"]);

export async function claimCallbackRecord(recordId = "", env = process.env) {
  return mutateCallbackStore(env, async (store) => {
    const index = store.callbacks.findIndex((item) => item.id === clean(recordId));
    if (index < 0) return { ok: false, reason: "twilio_calle_callback_not_found", record: null };
    const existing = normalizeRecord(store.callbacks[index]);
    const claimable = existing.status === "queued" || (existing.retryable && retryClaimStatuses.has(existing.status));
    if (!claimable) {
      return {
        ok: false,
        duplicate: true,
        alreadyRunning: ["starting", "in_progress"].includes(existing.status),
        reason: "twilio_calle_callback_not_claimable",
        record: existing,
      };
    }
    const record = normalizeRecord({
      ...existing,
      status: "starting",
      phase: "start",
      error: "",
      reason: "",
      retryable: false,
      recovery: "",
      attempts: Number(existing.attempts || 0) + 1,
      runId: "",
      callStatus: "STARTING",
      summary: "",
      transcript: "",
      startedAt: nowIso(),
      completedAt: "",
      updatedAt: nowIso(),
    });
    store.callbacks[index] = record;
    return { ok: true, record };
  });
}
