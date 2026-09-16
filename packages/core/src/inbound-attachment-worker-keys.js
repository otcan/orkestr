import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import * as age from "age-encryption";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

const registryVersion = 1;

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function defaults(raw = {}) {
  return {
    version: registryVersion,
    revision: Math.max(0, Number(raw?.revision || 0) || 0),
    keys: Array.isArray(raw?.keys) ? raw.keys : [],
  };
}

async function readRegistry(filePath) {
  return defaults(await readJson(filePath, null));
}

async function writeRegistry(filePath, registry) {
  const next = { ...defaults(registry), revision: Number(registry.revision || 0) + 1, updatedAt: nowIso() };
  await writeSecretJson(filePath, next);
  await fs.chmod(filePath, 0o600);
  return next;
}

function publicKey(key = {}) {
  return {
    id: clean(key.id),
    ownerUserId: clean(key.ownerUserId),
    version: Math.max(1, Number(key.version || 1) || 1),
    recipient: clean(key.recipient),
    status: clean(key.status),
    createdAt: clean(key.createdAt),
    retiredAt: clean(key.retiredAt),
    revokedAt: clean(key.revokedAt),
  };
}

function activeKey(registry, ownerUserId) {
  return registry.keys.find((key) => clean(key.ownerUserId) === clean(ownerUserId) && key.status === "active" && !key.revokedAt) || null;
}

async function createKey(registry, ownerUserId) {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const version = registry.keys.filter((key) => clean(key.ownerUserId) === clean(ownerUserId))
    .reduce((highest, key) => Math.max(highest, Number(key.version || 0) || 0), 0) + 1;
  return {
    id: "inbound-key-" + randomUUID(),
    ownerUserId: clean(ownerUserId),
    version,
    identity,
    recipient,
    status: "active",
    createdAt: nowIso(),
    retiredAt: "",
    revokedAt: "",
  };
}

export async function ensureInboundAttachmentWorkerKey(filePath, ownerUserId) {
  return withStorageFileLock(filePath, async () => {
    const registry = await readRegistry(filePath);
    const existing = activeKey(registry, ownerUserId);
    if (existing) return publicKey(existing);
    const created = await createKey(registry, ownerUserId);
    registry.keys.push(created);
    await writeRegistry(filePath, registry);
    return publicKey(created);
  });
}

export async function rotateInboundAttachmentWorkerKey(filePath, ownerUserId) {
  return withStorageFileLock(filePath, async () => {
    const registry = await readRegistry(filePath);
    const current = activeKey(registry, ownerUserId);
    if (current) {
      current.status = "retired";
      current.retiredAt = nowIso();
    }
    const created = await createKey(registry, ownerUserId);
    registry.keys.push(created);
    await writeRegistry(filePath, registry);
    return publicKey(created);
  });
}

export async function revokeInboundAttachmentWorkerKey(filePath, ownerUserId, keyId) {
  return withStorageFileLock(filePath, async () => {
    const registry = await readRegistry(filePath);
    const key = registry.keys.find((item) => clean(item.ownerUserId) === clean(ownerUserId) && clean(item.id) === clean(keyId));
    if (!key) throw new Error("inbound_attachment_key_not_found");
    key.status = "revoked";
    key.revokedAt = nowIso();
    await writeRegistry(filePath, registry);
    return publicKey(key);
  });
}

export async function inboundAttachmentWorkerKeyById(filePath, ownerUserId, keyId) {
  const registry = await readRegistry(filePath);
  return registry.keys.find((item) => clean(item.ownerUserId) === clean(ownerUserId) && clean(item.id) === clean(keyId)) || null;
}
