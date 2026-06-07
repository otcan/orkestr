import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, policyError } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSecretName(value = "") {
  return clean(value)
    .replace(/^secret:\/\/(?:global|user)\//i, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.\/-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160);
}

function secretFingerprint(value = "") {
  const text = String(value || "");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function secureInputKey(env = process.env) {
  const configured = clean(env.ORKESTR_SECURE_INPUT_KEY || env.ORKESTR_SECRET_KEY || "");
  if (configured) return createHash("sha256").update(configured).digest();
  const paths = await ensureDataDirs(env);
  const keyPath = path.join(paths.secrets, "secure-input.key");
  const existing = await fs.readFile(keyPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (existing.trim()) return Buffer.from(existing.trim(), "base64url");
  const key = randomBytes(32);
  await fs.writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await fs.chmod(keyPath, 0o600).catch(() => {});
  const written = await fs.readFile(keyPath, "utf8");
  return Buffer.from(written.trim(), "base64url");
}

async function encryptSecretValue(value = "", env = process.env) {
  const iv = randomBytes(12);
  const key = await secureInputKey(env);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: ciphertext.toString("base64url"),
  };
}

async function decryptSecretValue(record = {}, env = process.env) {
  const encrypted = record.encryptedValue && typeof record.encryptedValue === "object" ? record.encryptedValue : null;
  if (!encrypted) return String(record.value || "");
  const key = await secureInputKey(env);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(encrypted.iv || ""), "base64url"));
  decipher.setAuthTag(Buffer.from(String(encrypted.tag || ""), "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(String(encrypted.data || ""), "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function publicHandle(record = {}) {
  if (record.scope === "global") return `secret://global/${record.name}`;
  return `secret://user/${record.ownerUserId}/${record.name}`;
}

function storeDefaults(raw = {}) {
  return {
    schemaVersion: 1,
    secrets: Array.isArray(raw.secrets) ? raw.secrets : [],
    updatedAt: clean(raw.updatedAt) || null,
  };
}

async function globalStorePath(env = process.env) {
  const paths = await ensureDataDirs(env);
  return `${paths.secrets}/secure-input-global.json`;
}

async function userStorePath(userId, env = process.env) {
  const paths = userDataPaths(normalizeUserId(userId), env);
  await ensureDataDirs(env);
  return `${paths.secrets}/secure-input.json`;
}

async function readStore(filePath) {
  return storeDefaults(await readJson(filePath, { schemaVersion: 1, secrets: [] }));
}

async function writeStore(filePath, store = {}) {
  const next = storeDefaults({ ...store, updatedAt: nowIso() });
  await writeSecretJson(filePath, next);
  return next;
}

function activeSecrets(store = {}) {
  return (Array.isArray(store.secrets) ? store.secrets : [])
    .filter((record) => record && typeof record === "object" && !record.deletedAt);
}

function publicSecretMetadata(record = {}) {
  return {
    id: clean(record.id),
    name: clean(record.name),
    handle: publicHandle(record),
    scope: clean(record.scope),
    ownerUserId: record.scope === "user" ? normalizeUserId(record.ownerUserId) : null,
    managedBy: clean(record.managedBy) || "user",
    setByUserId: normalizeUserId(record.setByUserId || adminUserId),
    status: clean(record.status) || "configured",
    configured: true,
    createdAt: clean(record.createdAt) || null,
    updatedAt: clean(record.updatedAt) || null,
    lastUsedAt: clean(record.lastUsedAt) || null,
    usedBy: Array.isArray(record.usedBy) ? record.usedBy.map(clean).filter(Boolean) : [],
    valueFingerprint: clean(record.valueFingerprint) || null,
  };
}

function assertSecretMutationAllowed(principal = {}, target = {}, action = "secret.write", env = process.env) {
  if (target.scope === "global") {
    if (isAdminPrincipal(principal)) return true;
    throw policyError(`${action}_global_forbidden`, 403);
  }
  const owner = normalizeUserId(target.ownerUserId || principal.userId || adminUserId);
  if (isAdminPrincipal(principal) || canAccessOwner(principal, owner, env)) return true;
  throw policyError(`${action}_forbidden`, 403);
}

function assertSecretReadAllowed(principal = {}, target = {}, action = "secret.list", env = process.env) {
  if (target.scope === "global") {
    if (isAdminPrincipal(principal)) return true;
    throw policyError(`${action}_global_forbidden`, 403);
  }
  const owner = normalizeUserId(target.ownerUserId || principal.userId || adminUserId);
  if (isAdminPrincipal(principal) || canAccessOwner(principal, owner, env)) return true;
  throw policyError(`${action}_forbidden`, 403);
}

function managedByForWrite(principal = {}, target = {}) {
  if (target.scope === "global") return "admin";
  const owner = normalizeUserId(target.ownerUserId || principal.userId || adminUserId);
  return isAdminPrincipal(principal) && normalizeUserId(principal.userId) !== owner ? "admin" : "user";
}

function secretRecord(input = {}, prior = {}, principal = {}) {
  const scope = clean(input.scope) === "global" ? "global" : "user";
  const ownerUserId = scope === "user" ? normalizeUserId(input.ownerUserId || principal.userId || adminUserId) : "";
  const name = normalizeSecretName(input.name);
  if (!name) {
    const error = new Error("secret_name_required");
    error.statusCode = 400;
    throw error;
  }
  const value = String(input.value ?? "");
  if (!value) {
    const error = new Error("secret_value_required");
    error.statusCode = 400;
    throw error;
  }
  const now = nowIso();
  const { value: _priorValue, ...priorSafe } = prior;
  return {
    ...priorSafe,
    id: clean(prior.id) || `sec_${randomUUID().slice(0, 12)}`,
    name,
    scope,
    ownerUserId: scope === "user" ? ownerUserId : "",
    managedBy: managedByForWrite(principal, { scope, ownerUserId }),
    setByUserId: normalizeUserId(principal.userId || adminUserId),
    encryptedValue: input.encryptedValue,
    valueFingerprint: secretFingerprint(value),
    status: "configured",
    usedBy: Array.isArray(prior.usedBy) ? prior.usedBy : [],
    lastUsedAt: clean(prior.lastUsedAt) || null,
    createdAt: clean(prior.createdAt) || now,
    updatedAt: now,
  };
}

async function storePathForTarget(target = {}, env = process.env) {
  return target.scope === "global"
    ? globalStorePath(env)
    : userStorePath(target.ownerUserId, env);
}

async function listStoreSecrets(target = {}, env = process.env) {
  const filePath = await storePathForTarget(target, env);
  return activeSecrets(await readStore(filePath));
}

export async function setSecureSecret(input = {}, principal = {}, env = process.env) {
  const scope = clean(input.scope) === "global" ? "global" : "user";
  const ownerUserId = scope === "user" ? normalizeUserId(input.ownerUserId || principal.userId || adminUserId) : "";
  assertSecretMutationAllowed(principal, { scope, ownerUserId }, "secret.write", env);
  const name = normalizeSecretName(input.name);
  const filePath = await storePathForTarget({ scope, ownerUserId }, env);
  const store = await readStore(filePath);
  const records = Array.isArray(store.secrets) ? store.secrets : [];
  const managedBy = managedByForWrite(principal, { scope, ownerUserId });
  const index = records.findIndex((record) =>
    !record.deletedAt &&
    clean(record.name) === name &&
    clean(record.scope) === scope &&
    normalizeUserId(record.ownerUserId || ownerUserId) === normalizeUserId(ownerUserId || record.ownerUserId) &&
    clean(record.managedBy || "user") === managedBy
  );
  const prior = index >= 0 ? records[index] : {};
  const encryptedValue = await encryptSecretValue(String(input.value ?? ""), env);
  const record = secretRecord({ ...input, scope, ownerUserId, name, encryptedValue }, prior, principal);
  const nextRecords = index >= 0
    ? records.map((item, itemIndex) => itemIndex === index ? record : item)
    : [...records, record];
  await writeStore(filePath, { ...store, secrets: nextRecords });
  await appendEvent({
    type: "secure_secret_set",
    scope,
    ownerUserId: ownerUserId || null,
    name,
    managedBy: record.managedBy,
    actorUserId: normalizeUserId(principal.userId || adminUserId),
  }, env).catch(() => {});
  return { ok: true, secret: publicSecretMetadata(record) };
}

export async function listSecureSecrets(options = {}, principal = {}, env = process.env) {
  const scope = clean(options.scope);
  const results = [];
  if (!scope || scope === "user") {
    const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || principal.userId || adminUserId);
    assertSecretReadAllowed(principal, { scope: "user", ownerUserId }, "secret.list", env);
    results.push(...(await listStoreSecrets({ scope: "user", ownerUserId }, env)).map(publicSecretMetadata));
  }
  if (!scope || scope === "global") {
    assertSecretReadAllowed(principal, { scope: "global" }, "secret.list", env);
    results.push(...(await listStoreSecrets({ scope: "global" }, env)).map(publicSecretMetadata));
  }
  return { ok: true, secrets: results.sort((left, right) => left.handle.localeCompare(right.handle)) };
}

export async function deleteSecureSecret(input = {}, principal = {}, env = process.env) {
  const scope = clean(input.scope) === "global" ? "global" : "user";
  const ownerUserId = scope === "user" ? normalizeUserId(input.ownerUserId || principal.userId || adminUserId) : "";
  const name = normalizeSecretName(input.name);
  if (!name) {
    const error = new Error("secret_name_required");
    error.statusCode = 400;
    throw error;
  }
  assertSecretMutationAllowed(principal, { scope, ownerUserId }, "secret.delete", env);
  const filePath = await storePathForTarget({ scope, ownerUserId }, env);
  const store = await readStore(filePath);
  let deleted = null;
  const records = (Array.isArray(store.secrets) ? store.secrets : []).map((record) => {
    if (record.deletedAt || clean(record.name) !== name || clean(record.scope) !== scope) return record;
    if (scope === "user" && normalizeUserId(record.ownerUserId) !== ownerUserId) return record;
    if (!isAdminPrincipal(principal) && clean(record.managedBy || "user") !== "user") return record;
    deleted = {
      ...record,
      deletedAt: nowIso(),
      updatedAt: nowIso(),
      deletedByUserId: normalizeUserId(principal.userId || adminUserId),
    };
    return deleted;
  });
  if (!deleted) {
    const error = new Error("secret_not_found");
    error.statusCode = 404;
    throw error;
  }
  await writeStore(filePath, { ...store, secrets: records });
  await appendEvent({
    type: "secure_secret_deleted",
    scope,
    ownerUserId: ownerUserId || null,
    name,
    actorUserId: normalizeUserId(principal.userId || adminUserId),
  }, env).catch(() => {});
  return { ok: true, secret: publicSecretMetadata(deleted) };
}

async function markSecretUsed(record = {}, target = {}, env = process.env, usedBy = "") {
  const filePath = await storePathForTarget(target, env);
  const store = await readStore(filePath);
  const now = nowIso();
  let updated = record;
  const nextRecords = (Array.isArray(store.secrets) ? store.secrets : []).map((item) => {
    if (clean(item.id) !== clean(record.id)) return item;
    const nextUsedBy = [...new Set([...(Array.isArray(item.usedBy) ? item.usedBy.map(clean).filter(Boolean) : []), clean(usedBy)].filter(Boolean))].sort();
    updated = { ...item, lastUsedAt: now, usedBy: nextUsedBy, updatedAt: clean(item.updatedAt) || now };
    return updated;
  });
  await writeStore(filePath, { ...store, secrets: nextRecords });
  return updated;
}

async function resolvedSecret(record = {}, target = {}, env = process.env, usedBy = "") {
  const value = await decryptSecretValue(record, env);
  const updated = await markSecretUsed(record, target, env, usedBy);
  return { value, secret: publicSecretMetadata(updated) };
}

export async function resolveSecureSecretValue(name, options = {}, env = process.env) {
  const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || adminUserId);
  const normalizedName = normalizeSecretName(name);
  const usedBy = clean(options.usedBy || options.connector || options.runtime || "");
  if (!normalizedName) return null;
  const userRecords = await listStoreSecrets({ scope: "user", ownerUserId }, env);
  const userOwned = userRecords.find((record) => record.name === normalizedName && clean(record.managedBy || "user") === "user");
  if (userOwned) return resolvedSecret(userOwned, { scope: "user", ownerUserId }, env, usedBy);
  const adminUser = userRecords.find((record) => record.name === normalizedName && clean(record.managedBy) === "admin");
  if (adminUser) return resolvedSecret(adminUser, { scope: "user", ownerUserId }, env, usedBy);
  const globalRecord = (await listStoreSecrets({ scope: "global" }, env)).find((record) => record.name === normalizedName);
  if (globalRecord) return resolvedSecret(globalRecord, { scope: "global" }, env, usedBy);
  return null;
}

export function secureSecretHandleFor(name, options = {}) {
  const normalizedName = normalizeSecretName(name);
  if (!normalizedName) return "";
  if (clean(options.scope) === "global") return `secret://global/${normalizedName}`;
  return `secret://user/${normalizeUserId(options.ownerUserId || options.userId || adminUserId)}/${normalizedName}`;
}
