import { randomBytes, createHash } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

function clean(value = "") {
  return String(value || "").trim();
}

function splitScopeList(value = []) {
  if (Array.isArray(value)) return value.map((item) => clean(item).toLowerCase()).filter(Boolean);
  return clean(value).split(/[\s,]+/g).map((item) => item.toLowerCase()).filter(Boolean);
}

function splitStringList(value = []) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean);
  return clean(value).split(/[\s,]+/g).filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function scopedTokenPath(env = process.env) {
  return `${dataPaths(env).secrets}/whatsapp-scoped-tokens.json`;
}

function tokenFingerprint(value = "") {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function newToken() {
  return `wa_${randomBytes(32).toString("base64url")}`;
}

function normalizeTokenRecord(input = {}, prior = {}) {
  const token = clean(input.token || prior.token);
  return {
    id: clean(input.id || input.tokenId || prior.id || prior.tokenId),
    tokenId: clean(input.tokenId || input.id || prior.tokenId || prior.id),
    token,
    tokenFingerprint: token ? tokenFingerprint(token) : clean(input.tokenFingerprint || prior.tokenFingerprint),
    scopes: splitScopeList(input.scopes || input.scope || input.capabilities || prior.scopes),
    principalKind: clean(input.principalKind || input.kind || prior.principalKind || "external_instance"),
    principalId: clean(input.principalId || input.userId || input.ownerUserId || input.instanceId || prior.principalId),
    ownerUserId: normalizeUserId(input.ownerUserId || input.userId || prior.ownerUserId || ""),
    instanceId: clean(input.instanceId || input.instance || prior.instanceId),
    accountId: clean(input.accountId || prior.accountId),
    bindingId: clean(input.bindingId || prior.bindingId),
    chatId: clean(input.chatId || prior.chatId),
    allowedChatIds: splitStringList(input.allowedChatIds || input.allowedChats || input.chatIds || prior.allowedChatIds),
    allowedPhoneNumbers: splitStringList(input.allowedPhoneNumbers || input.whatsappNumbers || input.phoneNumbers || prior.allowedPhoneNumbers),
    allowedRecipients: splitStringList(input.allowedRecipients || input.allowedRecipientIds || input.recipientIds || prior.allowedRecipients),
    routeKind: clean(input.routeKind || prior.routeKind),
    purpose: clean(input.purpose || prior.purpose),
    expiresAt: clean(input.expiresAt || prior.expiresAt),
    disabled: input.disabled === true || input.enabled === false || prior.disabled === true,
    createdAt: clean(prior.createdAt) || nowIso(),
    updatedAt: nowIso(),
  };
}

function publicTokenRecord(record = {}) {
  return {
    id: clean(record.id || record.tokenId),
    tokenId: clean(record.tokenId || record.id),
    token: "[redacted]",
    tokenConfigured: Boolean(clean(record.token) || clean(record.tokenHash)),
    tokenFingerprint: clean(record.tokenFingerprint),
    scopes: splitScopeList(record.scopes),
    principalKind: clean(record.principalKind),
    principalId: clean(record.principalId),
    ownerUserId: normalizeUserId(record.ownerUserId || ""),
    instanceId: clean(record.instanceId),
    accountId: clean(record.accountId),
    bindingId: clean(record.bindingId),
    chatId: clean(record.chatId),
    allowedChatIds: splitStringList(record.allowedChatIds),
    allowedPhoneNumbers: splitStringList(record.allowedPhoneNumbers),
    allowedRecipients: splitStringList(record.allowedRecipients),
    routeKind: clean(record.routeKind),
    purpose: clean(record.purpose),
    expiresAt: clean(record.expiresAt),
    disabled: record.disabled === true,
    createdAt: clean(record.createdAt),
    updatedAt: clean(record.updatedAt),
  };
}

export async function readWhatsAppScopedTokenStore(env = process.env) {
  const raw = await readJson(scopedTokenPath(env), { schemaVersion: 1, tokens: [] });
  return {
    schemaVersion: 1,
    tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
    updatedAt: clean(raw.updatedAt),
  };
}

export async function writeWhatsAppScopedTokenStore(store = {}, env = process.env) {
  await ensureDataDirs(env);
  const next = {
    schemaVersion: 1,
    tokens: Array.isArray(store.tokens) ? store.tokens : [],
    updatedAt: nowIso(),
  };
  await writeSecretJson(scopedTokenPath(env), next);
  return next;
}

export async function readWhatsAppScopedTokenRecords(env = process.env) {
  const store = await readWhatsAppScopedTokenStore(env);
  return store.tokens
    .filter((record) => record && typeof record === "object" && !record.deletedAt)
    .map((record) => normalizeTokenRecord(record, record));
}

export async function ensureWhatsAppScopedTokens(plans = [], env = process.env) {
  const store = await readWhatsAppScopedTokenStore(env);
  const records = Array.isArray(store.tokens) ? store.tokens : [];
  const byId = new Map(records.map((record, index) => [clean(record.tokenId || record.id), { record, index }]).filter(([id]) => id));
  let created = 0;
  let reused = 0;
  const nextRecords = [...records];
  for (const plan of plans) {
    const tokenId = clean(plan.tokenId || plan.id);
    if (!tokenId) continue;
    const prior = byId.get(tokenId);
    if (prior?.record && !prior.record.deletedAt) {
      reused += 1;
      continue;
    }
    const record = normalizeTokenRecord({
      ...plan,
      id: tokenId,
      tokenId,
      token: newToken(),
    });
    if (prior) nextRecords[prior.index] = record;
    else nextRecords.push(record);
    created += 1;
  }
  if (created) await writeWhatsAppScopedTokenStore({ ...store, tokens: nextRecords }, env);
  const nextStore = created ? { ...store, tokens: nextRecords } : store;
  return {
    ok: true,
    created,
    reused,
    tokens: nextStore.tokens.map(publicTokenRecord),
  };
}

export function publicWhatsAppScopedTokenRecord(record = {}) {
  return publicTokenRecord(record);
}
