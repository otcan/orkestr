import crypto from "node:crypto";
import fs from "node:fs/promises";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { userDataPaths } from "../../storage/src/paths.js";

// One-time, signed, per-user intents for connector actions (Gmail OAuth start, WhatsApp repair).
// Prevents unauthenticated or cross-user execution of sensitive connector actions.
// Each intent is stored as a SHA-256 token hash in the user's secrets directory.
// Consumption is atomic: the entry is deleted during the same file-lock window as validation.
//
// Binding fields (all optional, validated when provided):
//   accountId   — the specific connector account (email, accountId) this intent is for
//   capabilities — requested capability set (array of strings)
//   returnTarget — the return URL / path after OAuth completion
//   instanceId  — broker tenant-VM instance scoping

const INTENT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_PER_USER_CONNECTOR = 5;

function intentsFilePath(userId, env) {
  return `${userDataPaths(userId, env).secrets}/connector-intents.json`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newIntentId() {
  return `cintent_${crypto.randomBytes(12).toString("hex")}`;
}

function intentError(code, statusCode = 403) {
  return Object.assign(new Error(code), { code, statusCode });
}

function normalizeCapabilities(caps) {
  if (!caps) return null;
  const arr = Array.isArray(caps) ? caps : String(caps || "").split(",");
  const result = arr.map((s) => String(s || "").trim()).filter(Boolean).sort();
  return result.length ? result : null;
}

function capabilitiesMatch(stored, caller) {
  // Both absent: skip check.
  if (!stored && !caller) return true;
  // One absent: require explicit match only if both are present.
  if (!stored || !caller) return true;
  if (stored.length !== caller.length) return false;
  return stored.every((cap, i) => cap === caller[i]);
}

/**
 * Create a one-time signed intent for a connector action.
 * Returns { intentId, token } — token is shown once only; only its SHA-256 hash is stored.
 * Max 5 pending intents per (userId, connector); expired ones are pruned first.
 * @param {string} userId
 * @param {{ connector: string; purpose: string; host?: string; accountId?: string; capabilities?: string[]; returnTarget?: string; instanceId?: string }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ intentId: string; token: string }>}
 */
export async function createConnectorUseIntent(userId, { connector, purpose, host = "", accountId = "", capabilities = null, returnTarget = "", instanceId = "" } = {}, env = process.env) {
  const uid = String(userId || "").trim();
  const conn = String(connector || "").trim();
  const purp = String(purpose || "").trim();
  if (!uid || !conn || !purp) throw intentError("connector_use_intent_params_required", 400);

  const token = crypto.randomBytes(32).toString("hex");
  const intentId = newIntentId();
  const now = Date.now();
  const entry = {
    intentId,
    tokenHash: hashToken(token),
    userId: uid,
    connector: conn,
    purpose: purp,
    host: String(host || "").trim(),
    accountId: String(accountId || "").trim(),
    capabilities: normalizeCapabilities(capabilities),
    returnTarget: String(returnTarget || "").trim().slice(0, 512),
    instanceId: String(instanceId || "").trim(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INTENT_TTL_MS).toISOString(),
  };

  const filePath = intentsFilePath(uid, env);
  await fs.mkdir(userDataPaths(uid, env).secrets, { recursive: true, mode: 0o700 });

  await withStorageFileLock(filePath, async () => {
    const existing = await readJson(filePath, []);
    const now2 = Date.now();
    // Prune expired entries for this (userId, connector) before checking the limit.
    const pruned = existing.filter(
      (e) => !(e.userId === uid && e.connector === conn && Date.parse(e.expiresAt || 0) <= now2),
    );
    const pending = pruned.filter((e) => e.userId === uid && e.connector === conn);
    if (pending.length >= MAX_PENDING_PER_USER_CONNECTOR) {
      throw intentError("connector_use_intent_limit", 429);
    }
    await writeSecretJson(filePath, [...pruned, entry]);
  });

  await appendEvent({ type: "connector_use_intent_created", userId: uid, connector: conn, purpose: purp, intentId }, env).catch(() => {});
  return { intentId, token };
}

/**
 * Atomically validate and consume a one-time intent.
 * Validates: intentId exists, token hash matches, userId/connector/purpose match,
 * host matches (if both stored and caller provide one), intent not expired.
 * Optional binding fields (accountId, capabilities, returnTarget, instanceId) are validated
 * when provided by both the stored intent and the caller.
 * The entry is deleted from storage inside the same lock window as validation.
 * @param {string} intentId
 * @param {string} token
 * @param {{ userId: string; connector: string; purpose: string; host?: string; accountId?: string; capabilities?: string[]; returnTarget?: string; instanceId?: string }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function consumeConnectorUseIntent(intentId, token, { userId, connector, purpose, host = "", accountId = "", capabilities = null, returnTarget = "", instanceId = "" } = {}, env = process.env) {
  const id = String(intentId || "").trim();
  const tok = String(token || "").trim();
  const uid = String(userId || "").trim();
  const conn = String(connector || "").trim();
  const purp = String(purpose || "").trim();
  if (!id || !tok || !uid || !conn || !purp) throw intentError("connector_use_intent_invalid", 401);

  const callerHost = String(host || "").trim();
  const callerAccountId = String(accountId || "").trim();
  const callerCapabilities = normalizeCapabilities(capabilities);
  const callerReturnTarget = String(returnTarget || "").trim();
  const callerInstanceId = String(instanceId || "").trim();
  const filePath = intentsFilePath(uid, env);
  let consumed = null;
  let rejectReason = null;

  await withStorageFileLock(filePath, async () => {
    const existing = await readJson(filePath, []);
    const now = Date.now();
    const entry = existing.find((e) => e.intentId === id);

    if (!entry) { rejectReason = "not_found"; return; }
    if (Date.parse(entry.expiresAt || 0) <= now) { rejectReason = "expired"; return; }
    if (entry.userId !== uid) { rejectReason = "user_mismatch"; return; }
    if (entry.connector !== conn) { rejectReason = "connector_mismatch"; return; }
    if (entry.purpose !== purp) { rejectReason = "purpose_mismatch"; return; }
    if (callerHost && entry.host && entry.host !== callerHost) { rejectReason = "host_mismatch"; return; }

    // Validate optional binding fields when both the stored intent and the caller provide them.
    if (callerAccountId && entry.accountId && entry.accountId !== callerAccountId) { rejectReason = "account_mismatch"; return; }
    if (!capabilitiesMatch(entry.capabilities, callerCapabilities)) { rejectReason = "capabilities_mismatch"; return; }
    if (callerReturnTarget && entry.returnTarget && entry.returnTarget !== callerReturnTarget) { rejectReason = "return_target_mismatch"; return; }
    if (callerInstanceId && entry.instanceId && entry.instanceId !== callerInstanceId) { rejectReason = "instance_mismatch"; return; }

    // Timing-safe token comparison.
    const expectedBuf = Buffer.from(hashToken(tok), "hex");
    const storedBuf = Buffer.from(String(entry.tokenHash || ""), "hex");
    if (expectedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(expectedBuf, storedBuf)) {
      rejectReason = "token_invalid"; return;
    }

    // Valid — consume by removing from the stored list.
    consumed = entry;
    await writeSecretJson(filePath, existing.filter((e) => e.intentId !== id));
  });

  if (rejectReason === "not_found") {
    // Emit a minimal audit event (no intentId to avoid enumeration) so rate-limiting
    // and alert thresholds can detect replay/probe attempts.
    await appendEvent({ type: "connector_use_intent_rejected", userId: uid, connector: conn, reason: "not_found" }, env).catch(() => {});
    throw intentError("connector_use_intent_not_found", 404);
  }
  if (rejectReason) {
    await appendEvent({ type: "connector_use_intent_rejected", userId: uid, connector: conn, intentId: id, reason: rejectReason }, env).catch(() => {});
    throw intentError(`connector_use_intent_${rejectReason}`, rejectReason === "expired" ? 401 : 403);
  }

  await appendEvent({ type: "connector_use_intent_consumed", userId: uid, connector: conn, purpose: purp, intentId: id }, env).catch(() => {});
  return consumed;
}
