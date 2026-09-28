import crypto from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

// Signed one-time WhatsApp repair intents (ORK-513).
//
// Only the trusted pairing-required notification path issues these. A token
// is `wri1.<intentId>.<nonce>.<signature>`, where the HMAC signature covers the
// intent id, nonce, bound account, purpose, expected host and expiry under a
// per-install key kept in the secrets directory. The stored record keeps a
// hash of the nonce, so a token is valid only while its unconsumed record
// exists; consumption marks the record consumed inside one file lock.

export const whatsappRepairIntentPurpose = "whatsapp_repair_qr_email";
const TOKEN_PREFIX = "wri1";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;

function clean(value) {
  return String(value || "").trim();
}

function intentsPath(env) {
  return path.join(dataPaths(env).secrets, "whatsapp-repair-intents.json");
}

function keyPath(env) {
  return path.join(dataPaths(env).secrets, "whatsapp-repair-intent-key.json");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function ttlMs(env = process.env) {
  const parsed = Math.floor(Number(env.ORKESTR_WHATSAPP_REPAIR_INTENT_TTL_MS));
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_TTL_MS;
}

async function signingKey(env) {
  const filePath = keyPath(env);
  const existing = await readJson(filePath, {});
  if (clean(existing.key)) return Buffer.from(existing.key, "base64url");
  await ensureDataDirs(env);
  return withStorageFileLock(filePath, async () => {
    const current = await readJson(filePath, {});
    if (clean(current.key)) return Buffer.from(current.key, "base64url");
    const key = crypto.randomBytes(32).toString("base64url");
    await writeSecretJson(filePath, { key, createdAt: new Date().toISOString() });
    return Buffer.from(key, "base64url");
  });
}

function signaturePayload(record, nonce) {
  return [record.intentId, nonce, record.accountId, record.purpose, record.host, record.expiresAt].join("\n");
}

function sign(key, record, nonce) {
  return crypto.createHmac("sha256", key).update(signaturePayload(record, nonce)).digest("base64url");
}

function parseToken(token = "") {
  const parts = clean(token).split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
  const [, intentId, nonce, signature] = parts;
  if (!/^wri_[a-f0-9]{24}$/.test(intentId) || !nonce || !signature) return null;
  return { intentId, nonce, signature };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hostFromLink(link = "") {
  try {
    const parsed = new URL(clean(link));
    return /^https?:$/.test(parsed.protocol) ? parsed.host.toLowerCase() : "";
  } catch {
    return "";
  }
}

function retained(records, nowMs) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => Date.parse(record.expiresAt || 0) + RETENTION_MS > nowMs)
    .slice(-MAX_RECORDS);
}

/** Issue an intent for the notification link; returns `{ token, intentId, expiresAt }`. */
export async function issueWhatsAppRepairIntent({ accountId = "", link = "", issuedBy = "pairing_required_notification", nowMs = Date.now() } = {}, env = process.env) {
  const account = clean(accountId);
  if (!account) throw Object.assign(new Error("whatsapp_repair_intent_account_required"), { statusCode: 400 });
  const key = await signingKey(env);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const record = {
    intentId: `wri_${crypto.randomBytes(12).toString("hex")}`,
    accountId: account,
    purpose: whatsappRepairIntentPurpose,
    host: hostFromLink(link),
    expiresAt: new Date(nowMs + ttlMs(env)).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
    issuedBy: clean(issuedBy).slice(0, 80),
  };
  record.nonceHash = sha256(nonce);
  const token = [TOKEN_PREFIX, record.intentId, nonce, sign(key, record, nonce)].join(".");
  const filePath = intentsPath(env);
  await withStorageFileLock(filePath, async () => {
    const records = retained(await readJson(filePath, []), nowMs);
    await writeSecretJson(filePath, [...records, record]);
  });
  await appendEvent({ type: "whatsapp_repair_intent_issued", accountId: account, intentId: record.intentId, issuedBy: record.issuedBy }, env).catch(() => {});
  return { token, intentId: record.intentId, expiresAt: record.expiresAt };
}

function rejection(record, parsed, key, expected, nowMs) {
  if (!record) return "not_found";
  if (!safeEqual(sha256(parsed.nonce), record.nonceHash) || !safeEqual(sign(key, record, parsed.nonce), parsed.signature)) {
    return "signature_invalid";
  }
  if (record.purpose !== whatsappRepairIntentPurpose) return "purpose_mismatch";
  if (clean(record.consumedAt)) return "replayed";
  if (Date.parse(record.expiresAt || 0) <= nowMs) return "expired";
  if (record.host && record.host !== clean(expected.host).toLowerCase()) return "wrong_host";
  if (clean(expected.accountId) && clean(expected.accountId) !== record.accountId) return "account_substitution";
  return "";
}

/**
 * Validate (and with `consume: true`, atomically consume) a repair intent.
 * Returns `{ ok, reason, accountId, intentId }`. A signature-valid token that
 * is presented with a substituted account or wrong host is burned.
 */
export async function checkWhatsAppRepairIntent(token = "", expected = {}, env = process.env, { consume = false } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: clean(token) ? "malformed" : "missing" };
  const nowMs = Number(expected.nowMs || Date.now());
  const key = await signingKey(env);
  const filePath = intentsPath(env);
  return withStorageFileLock(filePath, async () => {
    const records = retained(await readJson(filePath, []), nowMs);
    const record = records.find((item) => item.intentId === parsed.intentId) || null;
    const reason = rejection(record, parsed, key, expected, nowMs);
    const burn = ["wrong_host", "account_substitution"].includes(reason);
    if ((consume && !reason) || burn) {
      record.consumedAt = new Date(nowMs).toISOString();
      record.consumeResult = reason || "consumed";
      await writeSecretJson(filePath, records);
    }
    return {
      ok: !reason,
      reason,
      intentId: record && !["not_found", "signature_invalid"].includes(reason) ? record.intentId : "",
      accountId: reason ? "" : record.accountId,
    };
  });
}
