import fs from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as age from "age-encryption";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

const registryVersion = 1;
const defaultChallengeTtlMs = 15 * 60 * 1000;
const registryMutationQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function booleanValue(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ownerId(value, env = process.env) {
  return normalizeUserId(value || env.ORKESTR_ADMIN_USER_ID || "admin");
}

function publicKeyRecord(record = {}) {
  return {
    id: clean(record.id),
    ownerUserId: clean(record.ownerUserId),
    label: clean(record.label),
    fingerprint: clean(record.fingerprint),
    status: clean(record.status),
    createdAt: clean(record.createdAt),
    verifiedAt: clean(record.verifiedAt),
    revokedAt: clean(record.revokedAt),
    revokedReason: clean(record.revokedReason),
    challenge: record.status === "pending_verification" && record.challenge ? {
      id: clean(record.challenge.id),
      ciphertext: clean(record.challenge.ciphertext),
      ciphertextChecksum: clean(record.challenge.ciphertextChecksum),
      expiresAt: clean(record.challenge.expiresAt),
      format: "age",
    } : null,
  };
}

async function readRegistry(env = process.env) {
  const stored = await readJson(dataPaths(env).attachmentEncryption, null);
  if (!stored || typeof stored !== "object") return { version: registryVersion, revision: 0, policies: [], keys: [] };
  return {
    version: registryVersion,
    revision: Math.max(0, Number(stored.revision || 0) || 0),
    policies: Array.isArray(stored.policies) ? stored.policies : [],
    keys: Array.isArray(stored.keys) ? stored.keys : [],
  };
}

async function writeRegistry(registry, env = process.env) {
  const next = {
    ...registry,
    version: registryVersion,
    revision: Math.max(0, Number(registry.revision || 0) || 0) + 1,
    updatedAt: nowIso(),
  };
  const registryPath = dataPaths(env).attachmentEncryption;
  await writeJson(registryPath, next);
  await fs.chmod(registryPath, 0o600);
  return next;
}

function enqueueRegistryMutation(env, operation) {
  const key = dataPaths(env).attachmentEncryption;
  const previous = registryMutationQueues.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.catch(() => {});
  registryMutationQueues.set(key, settled);
  return current.finally(() => {
    if (registryMutationQueues.get(key) === settled) registryMutationQueues.delete(key);
  });
}

export function attachmentEncryptionGloballyRequired(env = process.env) {
  return booleanValue(env.ORKESTR_ATTACHMENT_ENCRYPTION_REQUIRED, false);
}

export async function attachmentEncryptionPolicy(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const registry = await readRegistry(env);
  const stored = registry.policies.find((policy) => ownerId(policy.ownerUserId, env) === owner) || {};
  const required = attachmentEncryptionGloballyRequired(env) || stored.required === true;
  return {
    ownerUserId: owner,
    required,
    enabled: required || stored.enabled === true,
    revision: Math.max(0, Number(stored.revision || 0) || 0),
    updatedAt: clean(stored.updatedAt),
  };
}

export async function activeAttachmentEncryptionRecipients(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const registry = await readRegistry(env);
  return registry.keys
    .filter((record) => ownerId(record.ownerUserId, env) === owner && record.status === "active" && !record.revokedAt)
    .map((record) => ({
      id: clean(record.id),
      recipient: clean(record.recipient),
      fingerprint: clean(record.fingerprint),
      label: clean(record.label),
      verifiedAt: clean(record.verifiedAt),
    }));
}

export async function attachmentEncryptionStatus(ownerUserId, env = process.env) {
  const owner = ownerId(ownerUserId, env);
  const registry = await readRegistry(env);
  const policy = await attachmentEncryptionPolicy(owner, env);
  const keys = registry.keys.filter((record) => ownerId(record.ownerUserId, env) === owner).map(publicKeyRecord);
  return {
    ownerUserId: owner,
    policy,
    ready: keys.some((record) => record.status === "active"),
    keys,
  };
}

function challengeTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_ATTACHMENT_KEY_CHALLENGE_TTL_MS || defaultChallengeTtlMs);
  return Number.isFinite(parsed) ? Math.max(60_000, Math.min(parsed, 24 * 60 * 60 * 1000)) : defaultChallengeTtlMs;
}

async function encryptedChallenge(recipient, nonce) {
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(`orkestr-recipient-proof-v1:${nonce}`);
}

async function registerAttachmentEncryptionRecipientUnlocked(input = {}, principal = {}, env = process.env) {
  const owner = ownerId(input.ownerUserId || principal.userId, env);
  const recipient = clean(input.recipient);
  if (!recipient || recipient.length > 500 || !recipient.startsWith("age1")) {
    const error = new Error("attachment_encryption_recipient_invalid");
    error.statusCode = 400;
    throw error;
  }
  const nonce = randomBytes(32).toString("base64url");
  let ciphertext;
  try {
    ciphertext = await encryptedChallenge(recipient, nonce);
  } catch {
    const error = new Error("attachment_encryption_recipient_invalid");
    error.statusCode = 400;
    throw error;
  }
  const fingerprint = `SHA256:${digest(recipient).slice(0, 32)}`;
  const registry = await readRegistry(env);
  const existing = registry.keys.find((record) => ownerId(record.ownerUserId, env) === owner && clean(record.fingerprint) === fingerprint);
  if (existing?.status === "active" && !existing.revokedAt) return { key: publicKeyRecord(existing), duplicate: true };
  const timestamp = nowIso();
  const record = {
    ...(existing || {}),
    id: clean(existing?.id) || randomUUID(),
    ownerUserId: owner,
    label: clean(input.label).slice(0, 120),
    recipient,
    fingerprint,
    status: "pending_verification",
    createdAt: clean(existing?.createdAt) || timestamp,
    verifiedAt: "",
    revokedAt: "",
    revokedReason: "",
    challenge: {
      id: randomUUID(),
      nonceHash: digest(`orkestr-recipient-proof-v1:${nonce}`),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      ciphertextChecksum: digest(ciphertext),
      createdAt: timestamp,
      expiresAt: new Date(Date.now() + challengeTtlMs(env)).toISOString(),
      attempts: 0,
    },
  };
  const keys = registry.keys.filter((candidate) => clean(candidate.id) !== record.id);
  await writeRegistry({ ...registry, keys: [...keys, record] }, env);
  await appendEvent({
    type: "attachment_encryption_recipient_registered",
    ownerUserId: owner,
    recipientId: record.id,
    fingerprint,
  }, env).catch(() => {});
  return { key: publicKeyRecord(record), duplicate: false };
}

async function verifyAttachmentEncryptionRecipientUnlocked(recipientId, proof, principal = {}, env = process.env) {
  const owner = ownerId(principal.userId, env);
  const registry = await readRegistry(env);
  const index = registry.keys.findIndex((record) => clean(record.id) === clean(recipientId) && ownerId(record.ownerUserId, env) === owner);
  if (index < 0) {
    const error = new Error("attachment_encryption_recipient_not_found");
    error.statusCode = 404;
    throw error;
  }
  const record = registry.keys[index];
  if (record.status !== "pending_verification" || !record.challenge) {
    const error = new Error("attachment_encryption_challenge_not_pending");
    error.statusCode = 409;
    throw error;
  }
  if (Date.parse(record.challenge.expiresAt) <= Date.now()) {
    const error = new Error("attachment_encryption_challenge_expired");
    error.statusCode = 409;
    throw error;
  }
  if (Math.max(0, Number(record.challenge.attempts || 0) || 0) >= 5) {
    const error = new Error("attachment_encryption_challenge_locked");
    error.statusCode = 409;
    throw error;
  }
  const expected = Buffer.from(clean(record.challenge.nonceHash), "hex");
  const actual = Buffer.from(digest(clean(proof)), "hex");
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!valid) {
    record.challenge.attempts = Math.max(0, Number(record.challenge.attempts || 0) || 0) + 1;
    await writeRegistry({ ...registry, keys: registry.keys }, env);
    const error = new Error("attachment_encryption_challenge_invalid");
    error.statusCode = 400;
    throw error;
  }
  const timestamp = nowIso();
  const active = { ...record, status: "active", verifiedAt: timestamp, challenge: null };
  const keys = [...registry.keys];
  keys[index] = active;
  await writeRegistry({ ...registry, keys }, env);
  await appendEvent({
    type: "attachment_encryption_recipient_verified",
    ownerUserId: owner,
    recipientId: active.id,
    fingerprint: active.fingerprint,
  }, env).catch(() => {});
  return { key: publicKeyRecord(active) };
}

async function revokeAttachmentEncryptionRecipientUnlocked(recipientId, reason, principal = {}, env = process.env) {
  const owner = ownerId(principal.userId, env);
  const registry = await readRegistry(env);
  const index = registry.keys.findIndex((record) => clean(record.id) === clean(recipientId) && ownerId(record.ownerUserId, env) === owner);
  if (index < 0) {
    const error = new Error("attachment_encryption_recipient_not_found");
    error.statusCode = 404;
    throw error;
  }
  const timestamp = nowIso();
  const revoked = {
    ...registry.keys[index],
    status: "revoked",
    revokedAt: timestamp,
    revokedReason: clean(reason).slice(0, 300) || "recipient_revoked",
    challenge: null,
  };
  const keys = [...registry.keys];
  keys[index] = revoked;
  await writeRegistry({ ...registry, keys }, env);
  await appendEvent({
    type: "attachment_encryption_recipient_revoked",
    ownerUserId: owner,
    recipientId: revoked.id,
    fingerprint: revoked.fingerprint,
    reason: revoked.revokedReason,
  }, env).catch(() => {});
  return { key: publicKeyRecord(revoked) };
}

async function setAttachmentEncryptionPolicyUnlocked(input = {}, principal = {}, env = process.env) {
  const owner = ownerId(input.ownerUserId || principal.userId, env);
  const enabled = input.enabled === true || input.required === true;
  const required = input.required === true;
  if (enabled && !(await activeAttachmentEncryptionRecipients(owner, env)).length) {
    const error = new Error("attachment_encryption_verified_recipient_required");
    error.statusCode = 409;
    throw error;
  }
  const registry = await readRegistry(env);
  const current = registry.policies.find((policy) => ownerId(policy.ownerUserId, env) === owner) || {};
  const policy = {
    ownerUserId: owner,
    enabled,
    required,
    revision: Math.max(0, Number(current.revision || 0) || 0) + 1,
    updatedAt: nowIso(),
  };
  const policies = registry.policies.filter((candidate) => ownerId(candidate.ownerUserId, env) !== owner);
  await writeRegistry({ ...registry, policies: [...policies, policy] }, env);
  await appendEvent({
    type: "attachment_encryption_policy_updated",
    ownerUserId: owner,
    enabled,
    required,
    policyRevision: policy.revision,
  }, env).catch(() => {});
  return { policy };
}

export function registerAttachmentEncryptionRecipient(input = {}, principal = {}, env = process.env) {
  return enqueueRegistryMutation(env, () => registerAttachmentEncryptionRecipientUnlocked(input, principal, env));
}

export function verifyAttachmentEncryptionRecipient(recipientId, proof, principal = {}, env = process.env) {
  return enqueueRegistryMutation(env, () => verifyAttachmentEncryptionRecipientUnlocked(recipientId, proof, principal, env));
}

export function revokeAttachmentEncryptionRecipient(recipientId, reason, principal = {}, env = process.env) {
  return enqueueRegistryMutation(env, () => revokeAttachmentEncryptionRecipientUnlocked(recipientId, reason, principal, env));
}

export function setAttachmentEncryptionPolicy(input = {}, principal = {}, env = process.env) {
  return enqueueRegistryMutation(env, () => setAttachmentEncryptionPolicyUnlocked(input, principal, env));
}
