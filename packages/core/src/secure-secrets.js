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

function publicMissingSecretMetadata(request = {}) {
  return {
    id: clean(request.id),
    requestId: clean(request.id),
    name: clean(request.name),
    handle: clean(request.handle),
    scope: clean(request.scope) === "global" ? "global" : "user",
    ownerUserId: clean(request.scope) === "global" ? null : normalizeUserId(request.ownerUserId),
    managedBy: clean(request.managedBy) || "request",
    setByUserId: null,
    status: "missing",
    configured: false,
    createdAt: clean(request.createdAt) || null,
    updatedAt: clean(request.updatedAt || request.lastRequestedAt) || null,
    lastUsedAt: null,
    usedBy: [clean(request.usedBy || request.connector)].filter(Boolean),
    valueFingerprint: null,
    connector: clean(request.connector),
    threadId: clean(request.threadId),
    chatId: clean(request.chatId),
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

async function requestStorePath(env = process.env) {
  const paths = await ensureDataDirs(env);
  return `${paths.secrets}/secure-input-requests.json`;
}

async function listStoreSecrets(target = {}, env = process.env) {
  const filePath = await storePathForTarget(target, env);
  return activeSecrets(await readStore(filePath));
}

async function readRequestStore(env = process.env) {
  const filePath = await requestStorePath(env);
  const raw = await readJson(filePath, { schemaVersion: 1, requests: [] });
  return {
    schemaVersion: 1,
    requests: Array.isArray(raw.requests) ? raw.requests : [],
    updatedAt: clean(raw.updatedAt) || null,
  };
}

async function writeRequestStore(store = {}, env = process.env) {
  const filePath = await requestStorePath(env);
  const next = {
    schemaVersion: 1,
    requests: Array.isArray(store.requests) ? store.requests : [],
    updatedAt: nowIso(),
  };
  await writeSecretJson(filePath, next);
  return next;
}

function activeRequests(store = {}) {
  return (Array.isArray(store.requests) ? store.requests : [])
    .filter((record) => record && typeof record === "object" && clean(record.status || "missing") === "missing");
}

function targetHandle(target = {}) {
  const scope = clean(target.scope) === "global" ? "global" : "user";
  const name = normalizeSecretName(target.name);
  if (!name) return "";
  if (scope === "global") return `secret://global/${name}`;
  return `secret://user/${normalizeUserId(target.ownerUserId || adminUserId)}/${name}`;
}

function requestMatchesTarget(record = {}, target = {}) {
  const scope = clean(target.scope) === "global" ? "global" : "user";
  if (clean(record.scope) !== scope) return false;
  if (clean(record.name) !== normalizeSecretName(target.name)) return false;
  if (scope === "user" && normalizeUserId(record.ownerUserId) !== normalizeUserId(target.ownerUserId)) return false;
  return true;
}

async function closeMatchingSecureInputRequests(target = {}, env = process.env) {
  const store = await readRequestStore(env);
  let changed = false;
  const now = nowIso();
  const requests = store.requests.map((record) => {
    if (!requestMatchesTarget(record, target) || clean(record.status || "missing") !== "missing") return record;
    changed = true;
    return { ...record, status: "configured", updatedAt: now, resolvedAt: now };
  });
  if (changed) await writeRequestStore({ ...store, requests }, env);
}

async function listRequestRecords(target = {}, env = process.env) {
  const store = await readRequestStore(env);
  const scope = clean(target.scope);
  const ownerUserId = normalizeUserId(target.ownerUserId || target.userId || "");
  return activeRequests(store)
    .filter((record) => {
      const recordScope = clean(record.scope) === "global" ? "global" : "user";
      if (scope && recordScope !== scope) return false;
      if (recordScope === "user" && ownerUserId && normalizeUserId(record.ownerUserId) !== ownerUserId) return false;
      return true;
    });
}

function configuredSecretKey(record = {}) {
  return `${clean(record.scope) === "global" ? "global" : "user"}:${normalizeUserId(record.ownerUserId || "")}:${clean(record.name)}`;
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
  await closeMatchingSecureInputRequests({ scope, ownerUserId, name }, env).catch(() => {});
  return { ok: true, secret: publicSecretMetadata(record) };
}

export async function listSecureSecrets(options = {}, principal = {}, env = process.env) {
  const scope = clean(options.scope);
  const results = [];
  if (!scope || scope === "user") {
    const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || principal.userId || adminUserId);
    assertSecretReadAllowed(principal, { scope: "user", ownerUserId }, "secret.list", env);
    const configured = (await listStoreSecrets({ scope: "user", ownerUserId }, env)).map(publicSecretMetadata);
    const configuredKeys = new Set(configured.map(configuredSecretKey));
    const missing = (await listRequestRecords({ scope: "user", ownerUserId }, env))
      .map(publicMissingSecretMetadata)
      .filter((request) => !configuredKeys.has(configuredSecretKey(request)));
    results.push(...configured, ...missing);
  }
  if (!scope || scope === "global") {
    assertSecretReadAllowed(principal, { scope: "global" }, "secret.list", env);
    const configured = (await listStoreSecrets({ scope: "global" }, env)).map(publicSecretMetadata);
    const configuredKeys = new Set(configured.map(configuredSecretKey));
    const missing = (await listRequestRecords({ scope: "global" }, env))
      .map(publicMissingSecretMetadata)
      .filter((request) => !configuredKeys.has(configuredSecretKey(request)));
    results.push(...configured, ...missing);
  }
  return { ok: true, secrets: results.sort((left, right) => left.handle.localeCompare(right.handle)) };
}

export async function listSecureInputRequests(options = {}, principal = {}, env = process.env) {
  const scope = clean(options.scope);
  const results = [];
  if (!scope || scope === "user") {
    const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || principal.userId || adminUserId);
    assertSecretReadAllowed(principal, { scope: "user", ownerUserId }, "secure_input.request.list", env);
    results.push(...(await listRequestRecords({ scope: "user", ownerUserId }, env)).map(publicMissingSecretMetadata));
  }
  if (!scope || scope === "global") {
    assertSecretReadAllowed(principal, { scope: "global" }, "secure_input.request.list", env);
    results.push(...(await listRequestRecords({ scope: "global" }, env)).map(publicMissingSecretMetadata));
  }
  return { ok: true, requests: results.sort((left, right) => left.handle.localeCompare(right.handle)) };
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

export function parseSecureSecretReference(reference = "", options = {}) {
  const raw = clean(reference);
  const match = raw.match(/^secret:\/\/(global|user)\/(.+)$/i);
  const requestedOwnerRaw = clean(options.ownerUserId || options.userId);
  const requestedOwner = requestedOwnerRaw ? normalizeUserId(requestedOwnerRaw) : "";
  const fallbackOwner = requestedOwner || adminUserId;
  if (!match) {
    return {
      scope: "user",
      ownerUserId: fallbackOwner,
      name: normalizeSecretName(raw),
      exactScope: false,
      handle: secureSecretHandleFor(raw, { ownerUserId: fallbackOwner }),
    };
  }
  const scope = match[1].toLowerCase() === "global" ? "global" : "user";
  const rest = clean(match[2]);
  if (scope === "global") {
    const name = normalizeSecretName(rest);
    return {
      scope,
      ownerUserId: "",
      name,
      exactScope: true,
      handle: targetHandle({ scope, name }),
    };
  }
  const parts = rest.split("/").map(clean).filter(Boolean);
  let ownerUserId = fallbackOwner;
  let nameParts = parts;
  if (parts.length >= 3) {
    const explicitOwner = normalizeUserId(parts[0]);
    if (requestedOwner && explicitOwner && explicitOwner !== fallbackOwner && clean(options.allowCrossUserHandle) !== "true") {
      const error = new Error("secure_secret_owner_mismatch");
      error.statusCode = 403;
      error.ownerUserId = explicitOwner;
      throw error;
    }
    if (explicitOwner) {
      ownerUserId = explicitOwner;
      nameParts = parts.slice(1);
    }
  }
  const name = normalizeSecretName(nameParts.join("/"));
  return {
    scope,
    ownerUserId,
    name,
    exactScope: false,
    handle: targetHandle({ scope, ownerUserId, name }),
  };
}

export async function createSecureInputRequest(input = {}, env = process.env) {
  const scope = clean(input.scope) === "global" ? "global" : "user";
  const ownerUserId = scope === "user" ? normalizeUserId(input.ownerUserId || input.userId || adminUserId) : "";
  const name = normalizeSecretName(input.name);
  if (!name) {
    const error = new Error("secret_name_required");
    error.statusCode = 400;
    throw error;
  }
  const store = await readRequestStore(env);
  const now = nowIso();
  const handle = targetHandle({ scope, ownerUserId, name });
  const connector = clean(input.connector || input.usedBy || "connector");
  const usedBy = clean(input.usedBy || connector);
  const threadId = clean(input.threadId);
  const chatId = clean(input.chatId);
  const keyMatches = (record) =>
    requestMatchesTarget(record, { scope, ownerUserId, name }) &&
    clean(record.connector) === connector &&
    clean(record.usedBy) === usedBy &&
    clean(record.threadId) === threadId &&
    clean(record.chatId) === chatId &&
    clean(record.status || "missing") === "missing";
  const priorIndex = store.requests.findIndex(keyMatches);
  const prior = priorIndex >= 0 ? store.requests[priorIndex] : {};
  const request = {
    ...prior,
    id: clean(prior.id) || `sir_${randomUUID().slice(0, 12)}`,
    scope,
    ownerUserId,
    name,
    handle,
    connector,
    usedBy,
    threadId,
    chatId,
    status: "missing",
    configured: false,
    createdAt: clean(prior.createdAt) || now,
    updatedAt: now,
    lastRequestedAt: now,
    requestCount: Number(prior.requestCount || 0) + 1,
  };
  const requests = priorIndex >= 0
    ? store.requests.map((item, index) => index === priorIndex ? request : item)
    : [...store.requests, request];
  await writeRequestStore({ ...store, requests }, env);
  await appendEvent({
    type: "secure_input_requested",
    requestId: request.id,
    scope,
    ownerUserId: ownerUserId || null,
    name,
    handle,
    connector,
    usedBy,
    threadId: threadId || null,
    chatId: chatId || null,
  }, env).catch(() => {});
  return { ok: true, request: publicMissingSecretMetadata(request) };
}

export async function resolveSecureSecretReference(reference, options = {}, env = process.env) {
  const target = parseSecureSecretReference(reference, options);
  if (!target.name) return null;
  const usedBy = clean(options.usedBy || options.connector || options.runtime || "");
  if (target.scope === "global" && target.exactScope) {
    const record = (await listStoreSecrets({ scope: "global" }, env)).find((item) => item.name === target.name);
    if (record) return resolvedSecret(record, { scope: "global" }, env, usedBy);
  } else {
    const resolved = await resolveSecureSecretValue(target.name, { ownerUserId: target.ownerUserId, usedBy }, env);
    if (resolved) return resolved;
  }
  if (options.createRequest === false) return null;
  const request = await createSecureInputRequest({
    ...target,
    connector: options.connector,
    usedBy,
    threadId: options.threadId,
    chatId: options.chatId,
  }, env);
  return {
    value: null,
    missing: true,
    secret: request.request,
    request: request.request,
  };
}

export function secureSecretHandleFor(name, options = {}) {
  const normalizedName = normalizeSecretName(name);
  if (!normalizedName) return "";
  if (clean(options.scope) === "global") return `secret://global/${normalizedName}`;
  return `secret://user/${normalizeUserId(options.ownerUserId || options.userId || adminUserId)}/${normalizedName}`;
}
