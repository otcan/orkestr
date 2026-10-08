import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { normalizeUserId } from "./users.js";
import { openItemPayload, sealItemPayload } from "./vault-crypto.js";
import { normalizeTotpConfig } from "./vault-totp.js";

// Per-user vault file (users/<id>/secrets/vault.json). Only metadata is in
// clear text; every secret field lives in the item's encrypted envelope.

export const VAULT_LIMITS = Object.freeze({
  maxItems: 10_000,
  maxName: 200,
  maxUrl: 2048,
  maxUsername: 512,
  maxPassword: 4096,
  maxNotes: 16 * 1024,
  maxTags: 20,
  maxTag: 40,
  maxFields: 50,
  maxGrants: 50,
});

const APPROVAL_RETENTION_MS = 24 * 60 * 60 * 1000;

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

function clean(value) {
  return String(value ?? "").trim();
}

export function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export async function vaultFilePath(ownerUserId, env = process.env) {
  await ensureDataDirs(env);
  return path.join(userDataPaths(normalizeUserId(ownerUserId), env).secrets, "vault.json");
}

function storeDefaults(raw = {}) {
  return {
    schemaVersion: 1,
    items: Array.isArray(raw?.items) ? raw.items.filter((item) => item && typeof item === "object") : [],
    approvals: Array.isArray(raw?.approvals) ? raw.approvals.filter((item) => item && typeof item === "object") : [],
    updatedAt: clean(raw?.updatedAt) || null,
  };
}

export async function readVault(ownerUserId, env = process.env) {
  return storeDefaults(await readJson(await vaultFilePath(ownerUserId, env), {}));
}

/** Runs `mutate(store)` under the vault file lock and persists the result. */
export async function mutateVault(ownerUserId, mutate, env = process.env) {
  const filePath = await vaultFilePath(ownerUserId, env);
  return withStorageFileLock(filePath, async () => {
    const store = storeDefaults(await readJson(filePath, {}));
    const result = await mutate(store);
    const cutoff = Date.now() - APPROVAL_RETENTION_MS;
    store.approvals = store.approvals.filter((approval) => Date.parse(approval.createdAt) > cutoff);
    store.updatedAt = nowIso();
    await writeSecretJson(filePath, store);
    return result;
  });
}

export function normalizeDomain(url = "") {
  const text = clean(url);
  if (!text) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function limited(value, max, code) {
  const text = String(value ?? "");
  if (text.length > max) throw vaultError(code, 413);
  return text;
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : clean(tags) ? clean(tags).split(",") : [];
  const unique = [...new Set(list.map((tag) => clean(tag).toLowerCase().slice(0, VAULT_LIMITS.maxTag)).filter(Boolean))];
  return unique.slice(0, VAULT_LIMITS.maxTags);
}

function normalizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, VAULT_LIMITS.maxFields)
    .map((field) => ({ name: clean(field?.name).slice(0, 200), value: limited(field?.value ?? "", VAULT_LIMITS.maxNotes, "vault_field_too_large") }))
    .filter((field) => field.name || field.value);
}

/** Applies an input patch to metadata + decrypted payload. Returns new copies. */
export function applyItemInput(meta = {}, payload = {}, input = {}) {
  const nextMeta = { ...meta };
  const next = { username: "", password: "", notes: "", totp: null, fields: [], ...payload };
  if (input.name !== undefined) nextMeta.name = limited(clean(input.name), VAULT_LIMITS.maxName, "vault_name_too_large");
  if (input.url !== undefined) {
    nextMeta.url = limited(clean(input.url), VAULT_LIMITS.maxUrl, "vault_url_too_large");
    nextMeta.domain = normalizeDomain(nextMeta.url);
  }
  if (input.tags !== undefined) nextMeta.tags = normalizeTags(input.tags);
  if (input.username !== undefined) next.username = limited(input.username ?? "", VAULT_LIMITS.maxUsername, "vault_username_too_large");
  if (input.password !== undefined) next.password = limited(input.password ?? "", VAULT_LIMITS.maxPassword, "vault_password_too_large");
  if (input.notes !== undefined) next.notes = limited(input.notes ?? "", VAULT_LIMITS.maxNotes, "vault_notes_too_large");
  if (input.fields !== undefined) next.fields = normalizeFields(input.fields);
  if (input.totp !== undefined) next.totp = input.totp ? normalizeTotpConfig(input.totp) : null;
  if (!clean(nextMeta.name)) nextMeta.name = nextMeta.domain || clean(next.totp?.issuer) || "";
  if (!clean(nextMeta.name)) throw vaultError("vault_name_required");
  nextMeta.hasPassword = Boolean(next.password);
  nextMeta.hasTotp = Boolean(next.totp);
  nextMeta.totpType = next.totp ? (next.totp.type === "hotp" ? "hotp" : "totp") : null;
  return { meta: nextMeta, payload: next };
}

export function newItemMeta(nowMs = Date.now()) {
  const at = nowIso(nowMs);
  return { id: randomId("vi"), name: "", url: "", domain: "", tags: [], hasPassword: false, hasTotp: false, createdAt: at, updatedAt: at, lastUsedAt: null, threadGrants: [] };
}

/** Stored record = metadata + encrypted envelope. */
export async function sealRecord(ownerUserId, meta, payload, env = process.env) {
  return { ...meta, secret: await sealItemPayload(payload, normalizeUserId(ownerUserId), meta.id, env) };
}

export async function openRecord(ownerUserId, record, env = process.env) {
  return openItemPayload(record?.secret, normalizeUserId(ownerUserId), record?.id, env);
}

export function itemMeta(record = {}) {
  return {
    id: clean(record.id),
    name: clean(record.name),
    url: clean(record.url),
    domain: clean(record.domain),
    tags: Array.isArray(record.tags) ? record.tags : [],
    hasPassword: record.hasPassword === true,
    hasTotp: record.hasTotp === true,
    totpType: record.hasTotp === true ? (record.totpType === "hotp" ? "hotp" : "totp") : null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    lastUsedAt: record.lastUsedAt || null,
    threadGrants: (Array.isArray(record.threadGrants) ? record.threadGrants : []).map((grant) => ({ threadId: clean(grant.threadId) })),
  };
}

export function findItem(store, itemId) {
  const id = clean(itemId);
  const record = id ? store.items.find((item) => item.id === id) : null;
  if (!record) throw vaultError("vault_item_not_found", 404);
  return record;
}
