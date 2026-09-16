import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import * as age from "age-encryption";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

const registryVersion = 1;
const mutationQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function ownerId(value, env = process.env) {
  return normalizeUserId(value || env.ORKESTR_ADMIN_USER_ID || "admin");
}

function defaults(raw = {}) {
  return {
    version: registryVersion,
    revision: Math.max(0, Number(raw?.revision || 0) || 0),
    descriptorSecret: clean(raw?.descriptorSecret),
    keys: Array.isArray(raw?.keys) ? raw.keys : [],
  };
}

async function readRegistry(env = process.env) {
  return defaults(await readJson(dataPaths(env).inboundAttachmentKeys, null));
}

async function writeRegistry(registry, env = process.env) {
  const next = {
    ...defaults(registry),
    version: registryVersion,
    revision: Math.max(0, Number(registry.revision || 0) || 0) + 1,
    updatedAt: nowIso(),
  };
  if (!next.descriptorSecret) next.descriptorSecret = randomBytes(32).toString("base64url");
  const filePath = dataPaths(env).inboundAttachmentKeys;
  await writeSecretJson(filePath, next);
  await fs.chmod(filePath, 0o600);
  return next;
}

function descriptorFields(session = {}, key = {}, policy = {}) {
  return {
    version: 1,
    sessionId: clean(session.id),
    keyId: clean(key.id || session.keyId),
    keyVersion: Math.max(1, Number(key.version || session.keyVersion || 1) || 1),
    recipient: clean(key.recipient),
    purpose: "inbound_attachment_upload",
    expiresAt: clean(session.expiresAt),
    maxPlaintextBytes: Math.max(0, Number(session.plaintextSize || policy.maxFileBytes || 0) || 0),
  };
}

function descriptorSignature(fields, secret) {
  return createHmac("sha256", secret).update(JSON.stringify(fields)).digest("base64url");
}

function signatureMatches(actual, expected) {
  const left = Buffer.from(clean(actual));
  const right = Buffer.from(clean(expected));
  return left.byteLength === right.byteLength && left.byteLength > 0 && timingSafeEqual(left, right);
}

function enqueue(env, operation) {
  const key = dataPaths(env).inboundAttachmentKeys;
  const prior = mutationQueues.get(key) || Promise.resolve();
  const next = prior.then(operation, operation);
  const settled = next.catch(() => {});
  mutationQueues.set(key, settled);
  return next.finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
}

function publicKey(record = {}) {
  return {
    id: clean(record.id),
    ownerUserId: clean(record.ownerUserId),
    version: Math.max(1, Number(record.version || 1) || 1),
    recipient: clean(record.recipient),
    status: clean(record.status),
    createdAt: clean(record.createdAt),
    retiredAt: clean(record.retiredAt),
    revokedAt: clean(record.revokedAt),
  };
}

function activeKey(registry, owner) {
  return registry.keys.find((key) => clean(key.ownerUserId) === owner && key.status === "active" && !key.revokedAt) || null;
}

async function createKey(registry, owner, env) {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const version = registry.keys
    .filter((key) => clean(key.ownerUserId) === owner)
    .reduce((highest, key) => Math.max(highest, Number(key.version || 0) || 0), 0) + 1;
  const record = {
    id: `inbound-key-${randomUUID()}`,
    ownerUserId: owner,
    version,
    identity,
    recipient,
    status: "active",
    createdAt: nowIso(),
    retiredAt: "",
    revokedAt: "",
  };
  registry.keys.push(record);
  await writeRegistry(registry, env);
  await appendEvent({
    type: "inbound_attachment_key_created",
    ownerUserId: owner,
    keyId: record.id,
    keyVersion: version,
  }, env).catch(() => {});
  return record;
}

export async function ensureInboundAttachmentKey(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  return enqueue(env, async () => {
    const registry = await readRegistry(env);
    return activeKey(registry, owner) || createKey(registry, owner, env);
  });
}

export async function rotateInboundAttachmentKey(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  return enqueue(env, async () => {
    const registry = await readRegistry(env);
    const current = activeKey(registry, owner);
    if (current) {
      current.status = "retired";
      current.retiredAt = nowIso();
    }
    const created = await createKey(registry, owner, env);
    await appendEvent({
      type: "inbound_attachment_key_rotated",
      ownerUserId: owner,
      previousKeyId: clean(current?.id),
      keyId: created.id,
      keyVersion: created.version,
    }, env).catch(() => {});
    return publicKey(created);
  });
}

export async function revokeInboundAttachmentKey(ownerUserId, keyId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const wanted = clean(keyId);
  return enqueue(env, async () => {
    const registry = await readRegistry(env);
    const key = registry.keys.find((candidate) => clean(candidate.ownerUserId) === owner && clean(candidate.id) === wanted);
    if (!key) {
      const error = new Error("inbound_attachment_key_not_found");
      error.statusCode = 404;
      throw error;
    }
    key.status = "revoked";
    key.revokedAt = nowIso();
    await writeRegistry(registry, env);
    await appendEvent({ type: "inbound_attachment_key_revoked", ownerUserId: owner, keyId: wanted }, env).catch(() => {});
    return publicKey(key);
  });
}

export async function inboundAttachmentKeyById(ownerUserId, keyId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const key = (await readRegistry(env)).keys.find((candidate) =>
    clean(candidate.ownerUserId) === owner && clean(candidate.id) === clean(keyId));
  return key || null;
}

export async function inboundAttachmentKeyStatus(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const registry = await readRegistry(env);
  return registry.keys
    .filter((key) => clean(key.ownerUserId) === owner)
    .map(publicKey);
}

export async function inboundAttachmentRecipientDescriptor(session, key, policy, env = process.env) {
  if (!key || clean(key.status) === "revoked" || !clean(key.recipient)) return null;
  const registry = await readRegistry(env);
  const secret = clean(registry.descriptorSecret);
  if (!secret) throw new Error("inbound_attachment_descriptor_secret_unavailable");
  const fields = descriptorFields(session, key, policy);
  return { ...fields, signature: descriptorSignature(fields, secret) };
}

export async function verifyInboundAttachmentRecipientDescriptor(descriptor, session, key, policy, env = process.env) {
  const registry = await readRegistry(env);
  const secret = clean(registry.descriptorSecret);
  const fields = descriptorFields(session, key, policy);
  if (!descriptor || typeof descriptor !== "object" || !secret || !signatureMatches(descriptor.signature, descriptorSignature(fields, secret))) {
    throw new Error("inbound_upload_descriptor_invalid");
  }
  for (const [field, value] of Object.entries(fields)) {
    if (String(descriptor[field] ?? "") !== String(value)) throw new Error("inbound_upload_descriptor_invalid");
  }
  if (!Number.isFinite(Date.parse(fields.expiresAt)) || Date.parse(fields.expiresAt) <= Date.now()) {
    throw new Error("inbound_upload_descriptor_expired");
  }
  return fields;
}
