import crypto from "node:crypto";
import fs from "node:fs/promises";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { userDataPaths } from "../../storage/src/paths.js";
import { consumeDurableRateLimit, positiveIntegerEnv } from "./durable-rate-limit.js";

// One-time, purpose-bound intents for connector actions (ORK-512).
//
// An intent is minted for an authenticated principal and binds, at creation
// time, everything the later state-changing request is allowed to do: the
// principal, its browser session, the initiating host, the broker instance,
// the subject user, and the exact start parameters (account, capabilities,
// return target, ...). Only a SHA-256 hash of the bearer token is stored.
// Consumption validates every binding and marks the record consumed inside
// one file-lock window, so a replayed or concurrently reused intent fails.
// The caller must use the returned `params`, never request-supplied values.

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_USER_CONNECTOR = 5;
const CONSUMED_RETENTION_MS = 60 * 60 * 1000;

function clean(value) {
  return String(value || "").trim();
}

function intentsFilePath(userId, env) {
  return `${userDataPaths(userId, env).secrets}/connector-intents.json`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function intentError(code, statusCode = 403) {
  return Object.assign(new Error(code), { code, statusCode });
}

function intentTtlMs(env = process.env) {
  return positiveIntegerEnv(env.ORKESTR_CONNECTOR_INTENT_TTL_MS, DEFAULT_TTL_MS, 1_000);
}

function normalizeParamValue(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(clean).filter(Boolean))].sort();
  }
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  return clean(value).slice(0, 512);
}

/** Canonical, order-independent form of the bound start parameters. */
export function normalizeConnectorIntentParams(params = {}) {
  const normalized = {};
  for (const key of Object.keys(params || {}).sort()) {
    normalized[key] = normalizeParamValue(params[key]);
  }
  return normalized;
}

function sameParamValue(a, b) {
  return JSON.stringify(normalizeParamValue(a)) === JSON.stringify(normalizeParamValue(b));
}

function bindingMismatch(entry, expected) {
  if (entry.userId !== expected.userId) return "principal_mismatch";
  if (entry.connector !== expected.connector) return "connector_mismatch";
  if (entry.purpose !== expected.purpose) return "purpose_mismatch";
  if (clean(entry.host) !== clean(expected.host)) return "host_mismatch";
  if (clean(entry.sessionId) !== clean(expected.sessionId)) return "session_mismatch";
  if (clean(entry.instanceId) !== clean(expected.instanceId)) return "instance_mismatch";
  if (clean(entry.subjectUserId) !== clean(expected.subjectUserId)) return "subject_mismatch";
  // Request-supplied parameters are optional, but any value the caller sends
  // must equal the bound one; a different account or capability set is a
  // substitution attempt and burns the intent.
  const bound = entry.params || {};
  for (const [key, value] of Object.entries(expected.params || {})) {
    if (value === undefined) continue;
    if (!Object.hasOwn(bound, key)) return "binding_mismatch";
    if (!sameParamValue(bound[key], value)) return "binding_mismatch";
  }
  return "";
}

function tokenMatches(token, tokenHash) {
  const expected = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(clean(tokenHash), "hex");
  return expected.length === stored.length && crypto.timingSafeEqual(expected, stored);
}

function liveEntries(entries, nowMs) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (entry.consumedAt) return Date.parse(entry.consumedAt) + CONSUMED_RETENTION_MS > nowMs;
    return Date.parse(entry.expiresAt || 0) + CONSUMED_RETENTION_MS > nowMs;
  });
}

/**
 * Create a one-time intent. Returns `{ intentId, token, expiresAt }`; the token
 * is returned once and only its hash is stored.
 */
export async function createConnectorUseIntent(userId, options = {}, env = process.env) {
  const uid = clean(userId);
  const connector = clean(options.connector);
  const purpose = clean(options.purpose);
  if (!uid || !connector || !purpose) throw intentError("connector_use_intent_params_required", 400);
  const nowMs = Number(options.nowMs || Date.now());
  const limit = await consumeDurableRateLimit({
    bucket: "connector-intent-create",
    key: `${uid}:${connector}`,
    limit: positiveIntegerEnv(env.ORKESTR_CONNECTOR_INTENT_RATE_LIMIT, 20),
    windowMs: positiveIntegerEnv(env.ORKESTR_CONNECTOR_INTENT_RATE_WINDOW_MS, 10 * 60 * 1000, 1_000),
    nowMs,
  }, env);
  if (!limit.ok) {
    await appendEvent({ type: "connector_use_intent_rate_limited", userId: uid, connector, purpose }, env).catch(() => {});
    throw intentError("connector_use_intent_rate_limited", 429);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const intentId = `cintent_${crypto.randomBytes(12).toString("hex")}`;
  const entry = {
    intentId,
    tokenHash: hashToken(token),
    userId: uid,
    connector,
    purpose,
    host: clean(options.host).toLowerCase(),
    sessionId: clean(options.sessionId),
    instanceId: clean(options.instanceId),
    subjectUserId: clean(options.subjectUserId),
    params: normalizeConnectorIntentParams(options.params || {}),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + intentTtlMs(env)).toISOString(),
  };
  const filePath = intentsFilePath(uid, env);
  await fs.mkdir(userDataPaths(uid, env).secrets, { recursive: true, mode: 0o700 });
  await withStorageFileLock(filePath, async () => {
    const entries = liveEntries(await readJson(filePath, []), nowMs);
    const pending = entries.filter((item) =>
      item.connector === connector && !item.consumedAt && Date.parse(item.expiresAt || 0) > nowMs);
    if (pending.length >= MAX_PENDING_PER_USER_CONNECTOR) throw intentError("connector_use_intent_limit", 429);
    await writeSecretJson(filePath, [...entries, entry]);
  });
  await appendEvent({ type: "connector_use_intent_created", userId: uid, connector, purpose, intentId }, env).catch(() => {});
  return { intentId, token, expiresAt: entry.expiresAt };
}

/**
 * Atomically validate and consume an intent. Every binding must match exactly.
 * Returns the stored record; callers must act on `record.params`.
 * @returns {Promise<Record<string, any>>}
 */
export async function consumeConnectorUseIntent(intentId, token, expected = {}, env = process.env) {
  const id = clean(intentId);
  const tok = clean(token);
  const binding = {
    userId: clean(expected.userId),
    connector: clean(expected.connector),
    purpose: clean(expected.purpose),
    host: clean(expected.host).toLowerCase(),
    sessionId: clean(expected.sessionId),
    instanceId: clean(expected.instanceId),
    subjectUserId: clean(expected.subjectUserId),
    params: expected.params || {},
  };
  const nowMs = Number(expected.nowMs || Date.now());
  const audit = async (reason) => appendEvent({
    type: reason === "replayed" ? "connector_use_intent_replayed" : "connector_use_intent_rejected",
    userId: binding.userId || undefined,
    connector: binding.connector,
    purpose: binding.purpose,
    reason,
  }, env).catch(() => {});
  if (!id || !tok || !binding.userId || !binding.connector || !binding.purpose) {
    await audit("missing");
    throw intentError("connector_use_intent_required", 401);
  }
  const filePath = intentsFilePath(binding.userId, env);
  /** @type {Record<string, any> | null} */
  let consumed = null;
  let reason = "";
  await withStorageFileLock(filePath, async () => {
    const entries = liveEntries(await readJson(filePath, []), nowMs);
    const entry = entries.find((item) => item.intentId === id);
    if (!entry) { reason = "not_found"; return; }
    if (!tokenMatches(tok, entry.tokenHash)) { reason = "token_invalid"; return; }
    if (entry.consumedAt) { reason = "replayed"; return; }
    if (Date.parse(entry.expiresAt || 0) <= nowMs) reason = "expired";
    else reason = bindingMismatch(entry, binding);
    // A token-valid intent is burned on any mismatch so a tampered request
    // cannot be retried with the same credential.
    entry.consumedAt = new Date(nowMs).toISOString();
    entry.consumeResult = reason || "consumed";
    await writeSecretJson(filePath, entries);
    if (!reason) consumed = entry;
  });
  if (!consumed) {
    await audit(reason);
    throw intentError(`connector_use_intent_${reason}`, reason === "expired" || reason === "not_found" ? 401 : 403);
  }
  await appendEvent({
    type: "connector_use_intent_consumed",
    userId: binding.userId,
    connector: binding.connector,
    purpose: binding.purpose,
    intentId: id,
  }, env).catch(() => {});
  return consumed;
}
