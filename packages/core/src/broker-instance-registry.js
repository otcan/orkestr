import crypto from "node:crypto";
import os from "node:os";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson, writeSecretJson, appendEvent } from "../../storage/src/store.js";
import {
  assignSqliteBrokerInstancePublicRefs,
  getSqliteBrokerInstance,
  readSqliteBrokerRegistry,
  rollbackSqliteBrokerInstancePublicRefs,
  writeSqliteBrokerRegistry,
} from "./broker-instance-sqlite-store.js";
import {
  assertUniquePublicRefs,
  assertPublicRefInvariant,
  canonicalInstanceUrlsEnabled,
  generateUniquePublicRef,
  parseInstancePublicRef,
} from "./canonical-public-references.js";
import { readInstanceIdentity, syncBrokerAuthoritativeInstanceIdentity } from "./instance-identity.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";
import {
  clearBrokerRegistrationIntent,
  ensureBrokerRegistrationIntent,
  normalizeBrokerBaseUrl,
  parseBrokerRegistrationIntentId,
  readBrokerRegistrationIntent,
} from "./broker-registration-intent.js";
const DEFAULT_MAX_INSTANCES = 10000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_TOKEN_MAX_USES = 1000;
const BROKER_REGISTRATION_INTENT_FIELDS = [
  "registrationIntentHash",
  "registrationIntentBindingHash",
  "registrationIntentAuthScopeHash",
  "registrationIntentScopeHash",
];

function clean(value) {
  return String(value || "").trim();
}
function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}
function falsey(value) {
  return ["0", "false", "no", "off"].includes(clean(value).toLowerCase());
}
function numberEnv(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const text = clean(value);
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
function hashBuffer(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function normalizeWhatsAppNumberTarget(value = "") {
  const text = clean(value);
  if (!text) return "";
  const digits = text.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : "";
}
function brokerWhatsAppChatHash(body = {}) {
  const chatId = normalizeWhatsAppNumberTarget(
    body.whatsappNumber ||
      body.targetWhatsAppNumber ||
      body.whatsappPhoneNumber ||
      body.targetPhoneNumber ||
      "",
  );
  return chatId ? sha256(chatId) : "";
}
function brokerRegistrationTargetScopeHash(body = {}) {
  return sha256(JSON.stringify({
    relayAccountId: clean(body.relayAccountId || body.whatsappRelayAccountId),
    whatsappTargetHash: brokerWhatsAppChatHash(body),
  }));
}
function brokerRegistrationRecordTargetScopeHash(record = {}) {
  return sha256(JSON.stringify({
    relayAccountId: clean(record.relayAccountId),
    whatsappTargetHash: clean(record.whatsappChatHash),
  }));
}
function brokerRegistrationAuthScopeHash(token = {}) {
  const scope = token.trustedAdmin
    ? "authenticated-admin"
    : token.open
      ? token.tokenHash === "open" ? "open" : `open-token:${token.tokenHash}`
      : `token:${token.tokenHash}`;
  return sha256(scope);
}
function brokerRegistrationIntentBinding({ intentHash, keyFingerprint, authScopeHash, targetScopeHash }) {
  return sha256(JSON.stringify({ version: 1, intentHash, keyFingerprint, authScopeHash, targetScopeHash }));
}
function publicBrokerClientRegistration(registration = {}, extra = {}) {
  const { registrationIntentId: _privateRegistrationIntentId, ...safe } = registration;
  return { ...extra, ...safe };
}
function assertUniqueBrokerRegistrationIntents(instances = []) {
  const seen = new Set();
  for (const instance of instances) {
    const intentHash = clean(instance?.registrationIntentHash);
    if (!intentHash) continue;
    if (seen.has(intentHash)) {
      throw Object.assign(new Error("broker_registration_intent_duplicate"), { statusCode: 409 });
    }
    seen.add(intentHash);
  }
}
export function brokerWhatsAppRelayAccountId(record = {}, env = process.env) {
  return clean(
    record.relayAccountId ||
      env.ORKESTR_BROKER_WHATSAPP_ONBOARDING_ACCOUNT_ID ||
      env.ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID ||
      env.ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID ||
      env.WHATSAPP_SENDER_ACCOUNT_ID ||
      env.ORKESTR_WHATSAPP_INBOUND_ACCOUNT_ID ||
      env.WHATSAPP_INBOUND_ACCOUNT_ID ||
      env.ORKESTR_WHATSAPP_SENDER_ROLE ||
      env.WHATSAPP_SENDER_ROLE ||
      env.ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID ||
      "sender",
  );
}
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function nowIso() {
  return new Date().toISOString();
}
function requestIp(request) {
  const forwarded = clean(request?.headers?.["x-forwarded-for"] || request?.headers?.["X-Forwarded-For"]);
  if (forwarded) return forwarded.split(",")[0].trim();
  return clean(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "unknown") || "unknown";
}

function requestUserAgent(request) {
  return clean(request?.headers?.["user-agent"] || request?.headers?.["User-Agent"]).slice(0, 300);
}
function publicKeyFingerprint(publicKey = "") {
  return sha256(clean(publicKey)).slice(0, 32);
}

function parsePublicKey(publicKeyPem) {
  const publicKey = clean(publicKeyPem);
  if (!publicKey.includes("BEGIN PUBLIC KEY")) throw Object.assign(new Error("invalid_instance_public_key"), { statusCode: 400 });
  try {
    return crypto.createPublicKey(publicKey);
  } catch {
    throw Object.assign(new Error("invalid_instance_public_key"), { statusCode: 400 });
  }
}

function createX25519Identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function deriveSharedSecret(privateKeyPem, publicKeyPem) {
  const privateKey = crypto.createPrivateKey(clean(privateKeyPem));
  const publicKey = parsePublicKey(publicKeyPem);
  return crypto.diffieHellman({ privateKey, publicKey });
}

function deriveChannelKey(sharedSecret, salt, info = "orkestr-broker-channel-v1") {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.from(clean(salt) || "orkestr-broker", "utf8"), Buffer.from(info, "utf8"), 32));
}

function encryptJson(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { alg: "X25519-HKDF-SHA256+A256GCM", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptJson(envelope, key) {
  const iv = Buffer.from(clean(envelope?.iv), "base64");
  const ciphertext = Buffer.from(clean(envelope?.ciphertext), "base64");
  const tag = Buffer.from(clean(envelope?.tag), "base64");
  if (iv.length !== 12 || !ciphertext.length || tag.length !== 16) {
    throw Object.assign(new Error("invalid_encrypted_payload"), { statusCode: 400 });
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function publicBrokerRecord(channel) {
  return { keyId: channel.keyId, publicKey: channel.publicKey, createdAt: channel.createdAt };
}

async function readRegistry(env = process.env) {
  const sqliteRegistry = await readSqliteBrokerRegistry(env);
  if (sqliteRegistry) return sqliteRegistry;
  const paths = dataPaths(env);
  const registry = await readJson(paths.brokerInstances, {});
  return {
    schemaVersion: 1, backend: "json",
    broker: registry.broker && typeof registry.broker === "object" ? registry.broker : {},
    instances: Array.isArray(registry.instances) ? registry.instances : [],
    rateLimits: registry.rateLimits && typeof registry.rateLimits === "object" ? registry.rateLimits : {},
    updatedAt: registry.updatedAt || null,
  };
}

async function writeRegistry(registry, env = process.env, options = {}) {
  assertUniquePublicRefs(registry.instances, "instance");
  assertUniqueBrokerRegistrationIntents(registry.instances);
  const localIdentity = await readInstanceIdentity(env);
  if (localIdentity?.publicRef) {
    assertUniquePublicRefs([{ id: localIdentity.internalInstanceId, publicRef: localIdentity.publicRef }, ...registry.instances], "instance");
  }
  const current = options.previousRegistry || await readRegistry(env);
  const priorById = new Map(current.instances.map((instance) => [clean(instance.instanceId), instance]));
  for (const instance of registry.instances) {
    const prior = priorById.get(clean(instance.instanceId));
    if (!prior) continue;
    if (!(options.rollbackAssignments === true && prior.publicRef && !instance.publicRef)) {
      assertPublicRefInvariant(prior.publicRef, instance.publicRef, "instance", options);
    }
    if (!options.rollbackAssignments && prior.publicRefAssignedAt && prior.publicRefAssignedAt !== instance.publicRefAssignedAt) {
      throw Object.assign(new Error("broker_instance_public_ref_metadata_immutable"), { statusCode: 409 });
    }
    for (const field of BROKER_REGISTRATION_INTENT_FIELDS) {
      if (prior[field] && prior[field] !== instance[field]) {
        throw Object.assign(new Error("broker_registration_intent_binding_immutable"), { statusCode: 409 });
      }
    }
  }
  const sqliteWritten = options.allowAssignment
    ? await assignSqliteBrokerInstancePublicRefs(registry, env)
    : options.rollbackAssignments
      ? await rollbackSqliteBrokerInstancePublicRefs(registry, env)
      : await writeSqliteBrokerRegistry(registry, env);
  if (sqliteWritten) return;
  const paths = await ensureDataDirs(env);
  await writeJson(paths.brokerInstances, {
    schemaVersion: 1,
    broker: registry.broker || {},
    instances: Array.isArray(registry.instances) ? registry.instances : [],
    rateLimits: registry.rateLimits || {},
    updatedAt: nowIso(),
  });
}

async function ensureBrokerChannel(env = process.env) {
  const paths = await ensureDataDirs(env);
  const prior = await readJson(paths.brokerChannel, null);
  if (prior?.privateKey && prior?.publicKey && prior?.keyId) return prior;
  const identity = createX25519Identity();
  const channel = { schemaVersion: 1, keyId: crypto.randomUUID(), publicKey: identity.publicKey, privateKey: identity.privateKey, createdAt: nowIso() };
  await writeSecretJson(paths.brokerChannel, channel);
  return channel;
}

async function ensureClientIdentity(env = process.env) {
  const paths = await ensureDataDirs(env);
  const prior = await readJson(paths.brokerClientIdentity, null);
  if (prior?.privateKey && prior?.publicKey && prior?.keyId) return prior;
  const identity = createX25519Identity();
  const client = { schemaVersion: 1, keyId: crypto.randomUUID(), publicKey: identity.publicKey, privateKey: identity.privateKey, createdAt: nowIso() };
  await writeSecretJson(paths.brokerClientIdentity, client);
  return client;
}

function registrationTokenFromRequest(body = {}, request = {}) {
  const bearer = clean(request?.headers?.authorization || request?.headers?.Authorization).match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return clean(body.registrationToken || body.token || request?.headers?.["x-orkestr-registration-token"] || bearer);
}

function allowedTokenHashes(env = process.env) {
  const hashes = [];
  const rawHash = clean(env.ORKESTR_BROKER_REGISTRATION_TOKEN_SHA256);
  if (/^[a-f0-9]{64}$/i.test(rawHash)) hashes.push(rawHash.toLowerCase());
  const token = clean(env.ORKESTR_BROKER_REGISTRATION_TOKEN);
  if (token) hashes.push(sha256(token));
  return hashes;
}

function assertRegistrationToken({ body = {}, request = {}, env = process.env, trustedAdmin = false } = {}) {
  if (trustedAdmin) return { tokenHash: "authenticated-admin", open: false, trustedAdmin: true };
  const open = truthy(env.ORKESTR_BROKER_REGISTRATION_OPEN);
  const token = registrationTokenFromRequest(body, request);
  const tokenHash = token ? sha256(token) : "";
  if (open) return { tokenHash: tokenHash || "open", open: true };
  const hashes = allowedTokenHashes(env);
  if (!hashes.length) throw Object.assign(new Error("broker_registration_token_not_configured"), { statusCode: 503 });
  if (!tokenHash || !hashes.some((hash) => safeEqual(hash, tokenHash))) {
    throw Object.assign(new Error("broker_registration_token_denied"), { statusCode: 401 });
  }
  return { tokenHash, open: false };
}

function assertLimits(registry, { tokenHash, ip, env = process.env, replacingInstanceId = "" } = {}) {
  const instances = clean(replacingInstanceId)
    ? registry.instances.filter((instance) => instance.instanceId !== clean(replacingInstanceId))
    : registry.instances;
  const maxInstances = numberEnv(env.ORKESTR_BROKER_REGISTRATION_MAX_INSTANCES, DEFAULT_MAX_INSTANCES, 1);
  if (instances.length >= maxInstances) {
    throw Object.assign(new Error("broker_registration_instance_limit"), { statusCode: 429 });
  }

  const tokenMaxUses = numberEnv(env.ORKESTR_BROKER_REGISTRATION_TOKEN_MAX_USES, DEFAULT_TOKEN_MAX_USES, 1);
  const tokenUses = instances.filter((instance) => instance.registrationTokenHash === tokenHash).length;
  if (tokenHash && tokenHash !== "authenticated-admin" && tokenUses >= tokenMaxUses) {
    throw Object.assign(new Error("broker_registration_token_use_limit"), { statusCode: 429 });
  }

  const windowMs = numberEnv(env.ORKESTR_BROKER_REGISTRATION_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS, 1000);
  const maxPerIp = numberEnv(env.ORKESTR_BROKER_REGISTRATION_RATE_LIMIT, DEFAULT_RATE_LIMIT, 1);
  const cutoff = Date.now() - windowMs;
  const recent = instances.filter((instance) => {
    return instance.requestIp === ip && Date.parse(instance.createdAt || "") >= cutoff;
  }).length;
  if (recent >= maxPerIp) {
    throw Object.assign(new Error("broker_registration_rate_limited"), { statusCode: 429 });
  }
}

function instanceResponse(record, brokerChannel, encryptedWelcome, options = {}) {
  return {
    ok: true,
    replayed: options.replayed === true,
    instanceId: record.instanceId,
    publicRef: record.publicRef || null,
    channelId: record.channelId,
    registeredAt: record.createdAt,
    broker: publicBrokerRecord(brokerChannel),
    encryptedWelcome,
    limits: record.limits || {},
  };
}

function requestedBrokerInstanceId(body = {}, token = {}) {
  const requested = clean(body.brokerInstanceId || body.requestedInstanceId);
  if (!requested) return "";
  if (token.open && !token.trustedAdmin) {
    throw Object.assign(new Error("broker_requested_instance_id_requires_token"), { statusCode: 401 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)) {
    throw Object.assign(new Error("broker_requested_instance_id_invalid"), { statusCode: 400 });
  }
  return requested;
}

export async function registerBrokerInstance({ body = {}, request = {}, env = process.env, trustedAdmin = false } = {}) {
  return withCanonicalPublicReferenceLock(
    () => registerBrokerInstanceLocked({ body, request, env, trustedAdmin }),
    env,
  );
}

async function registerBrokerInstanceLocked({ body = {}, request = {}, env = process.env, trustedAdmin = false } = {}) {
  const token = assertRegistrationToken({ body, request, env, trustedAdmin });
  const encryptionPublicKey = clean(body.encryptionPublicKey || body.publicKey);
  parsePublicKey(encryptionPublicKey);
  const ip = requestIp(request);
  const registry = await readRegistry(env);
  const keyFingerprint = publicKeyFingerprint(encryptionPublicKey);
  const registrationIntentId = clean(body.registrationIntentId);
  const registrationIntentHash = registrationIntentId
    ? sha256(`broker-registration-intent-v1:${parseBrokerRegistrationIntentId(registrationIntentId)}`)
    : "";
  const registrationIntentAuthScopeHash = brokerRegistrationAuthScopeHash(token);
  const registrationIntentScopeHash = brokerRegistrationTargetScopeHash(body);
  const registrationIntentBindingHash = registrationIntentHash ? brokerRegistrationIntentBinding({
    intentHash: registrationIntentHash,
    keyFingerprint,
    authScopeHash: registrationIntentAuthScopeHash,
    targetScopeHash: registrationIntentScopeHash,
  }) : "";
  const intentMatches = registrationIntentHash
    ? registry.instances.map((instance, index) => ({ instance, index })).filter(({ instance }) => instance.registrationIntentHash === registrationIntentHash)
    : [];
  if (intentMatches.length > 1) throw Object.assign(new Error("broker_registration_intent_ambiguous"), { statusCode: 409 });
  const intentReplay = intentMatches[0] || null;
  const rawRequestedInstanceId = clean(body.brokerInstanceId || body.requestedInstanceId);
  if (intentReplay && intentReplay.instance.registrationIntentBindingHash !== registrationIntentBindingHash) {
    throw Object.assign(new Error("broker_registration_intent_binding_conflict"), { statusCode: 409 });
  }
  if (intentReplay && rawRequestedInstanceId && rawRequestedInstanceId !== intentReplay.instance.instanceId) {
    throw Object.assign(new Error("broker_registration_intent_instance_conflict"), { statusCode: 409 });
  }
  const legacyCandidateIndex = !intentReplay && rawRequestedInstanceId
    ? registry.instances.findIndex((instance) => instance.instanceId === rawRequestedInstanceId)
    : -1;
  const legacyCandidate = legacyCandidateIndex >= 0 ? registry.instances[legacyCandidateIndex] : null;
  const legacyAdoption = Boolean(
    canonicalInstanceUrlsEnabled(env) &&
      registrationIntentHash &&
      legacyCandidate &&
      !legacyCandidate.registrationIntentHash,
  );
  if (legacyAdoption) {
    if (legacyCandidate.encryptionPublicKeyFingerprint !== keyFingerprint) {
      throw Object.assign(new Error("broker_registration_adoption_key_conflict"), { statusCode: 409 });
    }
    if (legacyCandidate.registrationTokenHash !== token.tokenHash) {
      throw Object.assign(new Error("broker_registration_adoption_auth_conflict"), { statusCode: 409 });
    }
    if (brokerRegistrationRecordTargetScopeHash(legacyCandidate) !== registrationIntentScopeHash) {
      throw Object.assign(new Error("broker_registration_adoption_target_conflict"), { statusCode: 409 });
    }
    const proof = body.legacyAdoptionProof;
    if (!proof || clean(proof.channelId) !== legacyCandidate.channelId) {
      throw Object.assign(new Error("broker_registration_adoption_proof_required"), { statusCode: 401 });
    }
    const adoptionBrokerChannel = await ensureBrokerChannel(env);
    let proofPayload;
    try {
      proofPayload = decryptBrokerChannelPayload(proof.envelope || proof, {
        brokerPrivateKey: adoptionBrokerChannel.privateKey,
        instancePublicKey: legacyCandidate.encryptionPublicKey,
        channelId: legacyCandidate.channelId,
      });
    } catch {
      throw Object.assign(new Error("broker_registration_adoption_proof_denied"), { statusCode: 401 });
    }
    if (
      clean(proofPayload.kind) !== "broker_registration_legacy_adoption_v1" ||
      clean(proofPayload.instanceId) !== legacyCandidate.instanceId ||
      clean(proofPayload.registrationIntentId) !== registrationIntentId ||
      clean(proofPayload.authorizationCredentialHash) !== token.tokenHash ||
      clean(proofPayload.targetScopeHash) !== registrationIntentScopeHash
    ) {
      throw Object.assign(new Error("broker_registration_adoption_proof_mismatch"), { statusCode: 409 });
    }
  }
  const requestedInstanceId = intentReplay?.instance.instanceId || (legacyAdoption
    ? legacyCandidate.instanceId
    : requestedBrokerInstanceId(body, token));
  const existingIndex = intentReplay?.index ?? (legacyAdoption ? legacyCandidateIndex : (requestedInstanceId
    ? registry.instances.findIndex((instance) => instance.instanceId === requestedInstanceId)
    : -1));
  const existing = existingIndex >= 0 ? registry.instances[existingIndex] : null;
  if (existing?.registrationIntentHash && registrationIntentHash && existing.registrationIntentHash !== registrationIntentHash) {
    throw Object.assign(new Error("broker_registration_intent_rebind_denied"), { statusCode: 409 });
  }
  assertLimits(registry, { tokenHash: token.tokenHash, ip, env, replacingInstanceId: requestedInstanceId });

  const brokerChannel = await ensureBrokerChannel(env);
  registry.broker = publicBrokerRecord(brokerChannel);
  const sharedSecret = deriveSharedSecret(brokerChannel.privateKey, encryptionPublicKey);
  const channelId = crypto.randomUUID();
  const channelKey = deriveChannelKey(sharedSecret, channelId);
  const createdAt = nowIso();
  const localIdentity = canonicalInstanceUrlsEnabled(env) ? await readInstanceIdentity(env) : null;
  const reservedInstanceRefs = new Set([
    ...(localIdentity?.publicRef ? [localIdentity.publicRef] : []),
    ...registry.instances.map((instance) => clean(instance.publicRef)).filter(Boolean),
  ]);
  const record = {
    ...(existing || {}),
    instanceId: crypto.randomUUID(),
    ...(existing?.publicRef ? { publicRef: existing.publicRef } : canonicalInstanceUrlsEnabled(env) ? {
      publicRef: generateUniquePublicRef("instance", reservedInstanceRefs),
      publicRefAssignedAt: createdAt,
    } : {}),
    channelId,
    status: "registered",
    displayName: clean(body.displayName || body.name || os.hostname()).slice(0, 120),
    version: clean(body.version).slice(0, 80),
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.map((value) => clean(value)).filter(Boolean).slice(0, 30) : [],
    encryptionPublicKey,
    encryptionPublicKeyFingerprint: keyFingerprint,
    signingPublicKey: clean(body.signingPublicKey).slice(0, 4096),
    channelKeyHash: hashBuffer(channelKey),
    registrationTokenHash: token.tokenHash,
    ...(registrationIntentHash ? {
      registrationIntentHash,
      registrationIntentBindingHash,
      registrationIntentAuthScopeHash,
      registrationIntentScopeHash,
    } : {}),
    requestIp: ip,
    userAgent: requestUserAgent(request),
    endpointBaseUrl: clean(body.endpointBaseUrl || body.baseUrl || body.apiBaseUrl).slice(0, 500),
    connectBaseUrl: clean(body.connectBaseUrl || body.publicBaseUrl || body.publicUrl).slice(0, 500),
    setupUrl: clean(body.setupUrl || body.publicSetupUrl).slice(0, 800),
    relayAccountId: clean(body.relayAccountId || body.whatsappRelayAccountId).slice(0, 120),
    whatsappChatHash: brokerWhatsAppChatHash(body),
    createdAt,
    lastSeenAt: createdAt,
    limits: {
      heartbeatTtlSeconds: numberEnv(env.ORKESTR_BROKER_HEARTBEAT_TTL_SECONDS, 300, 30),
    },
  };
  record.instanceId = requestedInstanceId || record.instanceId;
  record.createdAt = existing?.createdAt || createdAt;
  record.lastSeenAt = createdAt;
  if (existingIndex >= 0) registry.instances[existingIndex] = record;
  else registry.instances.push(record);
  await writeRegistry(registry, env, { allowAssignment: legacyAdoption });
  await appendEvent({
    type: intentReplay ? "broker_instance_registration_replayed" : "broker_instance_registered",
    action: "broker.instances.register",
    outcome: "success",
    resourceType: "broker_instance",
    instanceId: record.instanceId,
    channelId: record.channelId,
    displayName: record.displayName,
    version: record.version,
    tokenMode: token.open ? "open" : "token",
  }, env).catch(() => null);

  const encryptedWelcome = encryptJson({
    instanceId: record.instanceId, channelId: record.channelId, brokerKeyId: brokerChannel.keyId,
    issuedAt: createdAt, serverNonce: crypto.randomBytes(16).toString("base64"),
  }, channelKey);
  return instanceResponse(record, brokerChannel, encryptedWelcome, { replayed: Boolean(intentReplay) });
}

export async function listBrokerInstances(env = process.env) {
  const registry = await readRegistry(env);
  return {
    broker: registry.broker || {},
    backend: registry.backend || "json",
    instances: registry.instances.map((instance) => ({
      instanceId: instance.instanceId,
      publicRef: instance.publicRef || null,
      channelId: instance.channelId,
      status: instance.status,
      displayName: instance.displayName,
      version: instance.version,
      capabilities: instance.capabilities || [],
      endpointBaseUrl: instance.endpointBaseUrl || "",
      connectBaseUrl: instance.connectBaseUrl || "",
      setupUrl: instance.setupUrl || "",
      relayAccountId: instance.relayAccountId || "",
      whatsappChatHashConfigured: Boolean(instance.whatsappChatHash),
      expiresAt: instance.expiresAt || null,
      disabledAt: instance.disabledAt || null,
      auditStatus: instance.auditStatus || "",
      auditUpdatedAt: instance.auditUpdatedAt || null,
      encryptionPublicKeyFingerprint: instance.encryptionPublicKeyFingerprint,
      requestIp: instance.requestIp,
      userAgent: instance.userAgent,
      createdAt: instance.createdAt,
      lastSeenAt: instance.lastSeenAt,
      lastHeartbeatAt: instance.lastHeartbeatAt || null,
    })),
    generatedAt: nowIso(),
  };
}

export async function brokerInstance(instanceId, env = process.env) {
  const sqlite = await getSqliteBrokerInstance(instanceId, env);
  if (sqlite.available) return sqlite.instance;
  const registry = await readRegistry(env);
  return registry.instances.find((instance) => instance.instanceId === clean(instanceId)) || null;
}

function expired(record) {
  const expiresAt = Date.parse(clean(record?.expiresAt));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function heartbeatExpired(record) {
  const ttlSeconds = Number(record?.limits?.heartbeatTtlSeconds || 0);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  const last = Date.parse(clean(record?.lastHeartbeatAt || record?.lastSeenAt || record?.createdAt));
  return Number.isFinite(last) && last + ttlSeconds * 1000 < Date.now();
}

function publicConnectRecord(record) {
  return {
    instanceId: record.instanceId, publicRef: record.publicRef || null, channelId: record.channelId, status: record.status,
    displayName: record.displayName, version: record.version,
    endpointBaseUrl: record.endpointBaseUrl || "",
    connectBaseUrl: record.connectBaseUrl || "",
    setupUrl: record.setupUrl || "",
    relayAccountId: record.relayAccountId || "",
    lastSeenAt: record.lastSeenAt || null,
    lastHeartbeatAt: record.lastHeartbeatAt || null,
  };
}

export async function readBrokerInstanceRegistry(env = process.env) {
  return readRegistry(env);
}

export async function writeBrokerInstanceRegistry(registry, env = process.env) {
  return withCanonicalPublicReferenceLock(() => writeBrokerInstanceRegistryLocked(registry, env), env);
}

export async function updateBrokerInstanceRecord(instanceId, patch = {}, env = process.env) {
  return withCanonicalPublicReferenceLock(async () => {
    if (Object.hasOwn(patch, "publicRef") || Object.hasOwn(patch, "publicRefAssignedAt")) {
      throw Object.assign(new Error("broker_instance_public_ref_immutable"), { statusCode: 409 });
    }
    if (BROKER_REGISTRATION_INTENT_FIELDS.some((field) => Object.hasOwn(patch, field))) {
      throw Object.assign(new Error("broker_registration_intent_binding_immutable"), { statusCode: 409 });
    }
    const registry = await readRegistry(env);
    const id = clean(instanceId);
    const index = registry.instances.findIndex((instance) => clean(instance.instanceId) === id);
    if (index < 0) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
    registry.instances[index] = { ...registry.instances[index], ...patch, instanceId: registry.instances[index].instanceId };
    await writeRegistry(registry, env);
    return registry.instances[index];
  }, env);
}

async function writeBrokerInstanceRegistryLocked(registry, env = process.env) {
  const current = await readRegistry(env);
  const existingById = new Map(current.instances.map((instance) => [clean(instance.instanceId), instance]));
  for (const candidate of Array.isArray(registry?.instances) ? registry.instances : []) {
    const prior = existingById.get(clean(candidate.instanceId));
    if (!prior) continue;
    if (prior.publicRef !== candidate.publicRef || prior.publicRefAssignedAt !== candidate.publicRefAssignedAt) {
      throw Object.assign(new Error("broker_instance_public_ref_immutable"), { statusCode: 409 });
    }
  }
  await writeRegistry(registry, env);
  return readRegistry(env);
}

export async function assignBrokerInstancePublicRefs(assignments = [], env = process.env) {
  return withCanonicalPublicReferenceLock(() => assignBrokerInstancePublicRefsLocked(assignments, env), env);
}

async function assignBrokerInstancePublicRefsLocked(assignments = [], env = process.env) {
  const registry = await readRegistry(env);
  const byId = new Map(assignments.map((item) => [clean(item.instanceId), item]));
  const found = new Set();
  const next = {
    ...registry,
    instances: registry.instances.map((instance) => {
      const assignment = byId.get(clean(instance.instanceId));
      if (!assignment) return instance;
      found.add(clean(instance.instanceId));
      assertPublicRefInvariant(instance.publicRef, assignment.publicRef, "instance", { allowAssignment: true });
      return instance.publicRef ? instance : { ...instance, publicRef: assignment.publicRef, publicRefAssignedAt: assignment.publicRefAssignedAt };
    }),
  };
  if (found.size !== byId.size) throw Object.assign(new Error("broker_instance_public_ref_assignment_stale"), { statusCode: 409 });
  await writeRegistry(next, env, { previousRegistry: registry, allowAssignment: true });
  return readRegistry(env);
}

export async function rollbackBrokerInstancePublicRefAssignments(assignments = [], env = process.env) {
  return withCanonicalPublicReferenceLock(() => rollbackBrokerInstancePublicRefAssignmentsLocked(assignments, env), env);
}

async function rollbackBrokerInstancePublicRefAssignmentsLocked(assignments = [], env = process.env) {
  const expected = new Map(assignments.map((item) => [clean(item.instanceId), item]));
  const registry = await readRegistry(env);
  const next = {
    ...registry,
    instances: registry.instances.map((instance) => {
      const assignment = expected.get(clean(instance.instanceId));
      if (!assignment || instance.publicRef !== assignment.publicRef || instance.publicRefAssignedAt !== assignment.publicRefAssignedAt) return instance;
      const reverted = { ...instance };
      delete reverted.publicRef;
      delete reverted.publicRefAssignedAt;
      return reverted;
    }),
  };
  await writeRegistry(next, env, { previousRegistry: registry, rollbackAssignments: true });
  return readRegistry(env);
}

function normalizedEndpointBaseUrl(value = "") {
  const raw = clean(value).replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function brokerRecordSortTime(record = {}) {
  for (const value of [record.lastHeartbeatAt, record.lastSeenAt, record.updatedAt, record.createdAt]) {
    const parsed = Date.parse(clean(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function usableBrokerInstanceRecord(record = {}) {
  if (!record?.instanceId || !record?.channelId || !record?.encryptionPublicKey) return false;
  if (record.disabledAt || ["disabled", "deleted", "revoked"].includes(clean(record.status).toLowerCase())) return false;
  return !expired(record);
}

export async function resolveBrokerConnectInstance(instanceId, env = process.env) {
  const record = await brokerInstance(instanceId, env);
  if (!record) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
  if (record.disabledAt || ["disabled", "deleted", "revoked"].includes(clean(record.status).toLowerCase())) {
    throw Object.assign(new Error("broker_instance_disabled"), { statusCode: 410 });
  }
  if (expired(record)) {
    throw Object.assign(new Error("broker_instance_expired"), { statusCode: 410 });
  }
  if (truthy(env.ORKESTR_BROKER_CONNECT_REQUIRE_HEARTBEAT) && heartbeatExpired(record)) {
    throw Object.assign(new Error("broker_instance_unhealthy"), { statusCode: 503 });
  }
  return { ok: true, instance: publicConnectRecord(record) };
}

export function encryptBrokerChannelPayload(payload, { clientPrivateKey, brokerPublicKey, channelId }) {
  const sharedSecret = deriveSharedSecret(clientPrivateKey, brokerPublicKey);
  const channelKey = deriveChannelKey(sharedSecret, channelId);
  return encryptJson(payload, channelKey);
}

export function decryptBrokerChannelPayload(envelope, { brokerPrivateKey, instancePublicKey, channelId }) {
  const sharedSecret = deriveSharedSecret(brokerPrivateKey, instancePublicKey);
  const channelKey = deriveChannelKey(sharedSecret, channelId);
  return decryptJson(envelope, channelKey);
}

export async function heartbeatBrokerInstance(instanceId, { body = {}, request = {}, env = process.env } = {}) {
  return withCanonicalPublicReferenceLock(
    () => heartbeatBrokerInstanceLocked(instanceId, { body, request, env }),
    env,
  );
}

async function heartbeatBrokerInstanceLocked(instanceId, { body = {}, request = {}, env = process.env } = {}) {
  const registry = await readRegistry(env);
  const record = registry.instances.find((instance) => instance.instanceId === clean(instanceId));
  if (!record) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
  if (clean(body.channelId) !== record.channelId) {
    throw Object.assign(new Error("broker_channel_denied"), { statusCode: 401 });
  }
  const brokerChannel = await ensureBrokerChannel(env);
  const payload = decryptBrokerChannelPayload(body.envelope || body, {
    brokerPrivateKey: brokerChannel.privateKey,
    instancePublicKey: record.encryptionPublicKey,
    channelId: record.channelId,
  });
  const now = nowIso();
  record.status = "online";
  record.lastSeenAt = now;
  record.lastHeartbeatAt = now;
  record.version = clean(payload.version || record.version).slice(0, 80);
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.map((value) => clean(value)).filter(Boolean).slice(0, 30)
    : [];
  if (capabilities.length) record.capabilities = capabilities;
  const displayName = clean(payload.displayName || payload.name).slice(0, 120);
  if (displayName) record.displayName = displayName;
  const endpointBaseUrl = clean(payload.endpointBaseUrl || payload.baseUrl || payload.apiBaseUrl).slice(0, 500);
  if (Object.prototype.hasOwnProperty.call(payload, "endpointBaseUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "baseUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "apiBaseUrl")) {
    record.endpointBaseUrl = endpointBaseUrl;
  }
  const connectBaseUrl = clean(payload.connectBaseUrl || payload.publicBaseUrl || payload.publicUrl).slice(0, 500);
  if (Object.prototype.hasOwnProperty.call(payload, "connectBaseUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "publicBaseUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "publicUrl")) {
    record.connectBaseUrl = connectBaseUrl;
  }
  const setupUrl = clean(payload.setupUrl || payload.publicSetupUrl).slice(0, 800);
  if (Object.prototype.hasOwnProperty.call(payload, "setupUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "publicSetupUrl")) {
    record.setupUrl = setupUrl;
  }
  const relayAccountId = clean(payload.relayAccountId || payload.whatsappRelayAccountId).slice(0, 120);
  if (Object.prototype.hasOwnProperty.call(payload, "relayAccountId") ||
    Object.prototype.hasOwnProperty.call(payload, "whatsappRelayAccountId")) {
    record.relayAccountId = relayAccountId;
  }
  record.lastHeartbeatIp = requestIp(request);
  await writeRegistry(registry, env);
  return {
    ok: true,
    instanceId: record.instanceId,
    channelId: record.channelId,
    acceptedAt: now,
    brokerTime: now,
  };
}

export function brokerClientHeartbeatConfigured(env = process.env) {
  if (falsey(env.ORKESTR_BROKER_CLIENT_HEARTBEAT)) return false;
  return Boolean(clean(env.ORKESTR_BROKER_BASE_URL || env.ORKESTR_DEMO_BROKER_BASE_URL));
}

export function brokerClientHeartbeatIntervalMs(env = process.env) {
  return numberEnv(env.ORKESTR_BROKER_CLIENT_HEARTBEAT_INTERVAL_MS, 60_000, 5_000, 3_600_000);
}

export function brokerClientHeartbeatStartupDelayMs(env = process.env) {
  return numberEnv(env.ORKESTR_BROKER_CLIENT_HEARTBEAT_STARTUP_DELAY_MS, 2_000, 0, 300_000);
}

function brokerClientCapabilities(env = process.env) {
  const explicit = clean(
    env.ORKESTR_BROKER_CLIENT_CAPABILITIES ||
      env.ORKESTR_INSTANCE_CAPABILITIES ||
      env.ORKESTR_TENANT_VM_CAPABILITIES,
  );
  if (explicit) {
    return [...new Set(explicit.split(/[,\s]+/).map((value) => clean(value)).filter(Boolean))].slice(0, 30);
  }
  if (clean(env.ORKESTR_TENANT_VM_ID || env.ORKESTR_TENANT_SLICE_ID || env.ORKESTR_TENANT_BOUNDARY)) {
    return ["tenant-vm", "pairing-challenge", "whatsapp", "codex", "gmail", "desks"];
  }
  return ["demo-onboarding", "pairing-challenge"];
}

function brokerClientVersion(env = process.env) {
  return clean(
    env.ORKESTR_RELEASE_ID ||
      env.ORKESTR_BUILD_ID ||
      env.ORKESTR_VERSION ||
      env.npm_package_version,
  ).slice(0, 80);
}

function brokerClientRelayAccountId(env = process.env) {
  return clean(
    env.ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID ||
      env.ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID ||
      env.WHATSAPP_SENDER_ACCOUNT_ID,
  ).slice(0, 120);
}

function brokerClientHeartbeatPayload(env = process.env) {
  return {
    displayName: clean(env.ORKESTR_DEMO_INSTANCE_NAME || env.ORKESTR_INSTANCE_NAME || env.ORKESTR_SERVICE_NAME || os.hostname()).slice(0, 120),
    version: brokerClientVersion(env),
    capabilities: brokerClientCapabilities(env),
    endpointBaseUrl: clean(env.ORKESTR_DEMO_INTERNAL_BASE_URL || env.ORKESTR_API_BASE).slice(0, 500),
    connectBaseUrl: clean(env.ORKESTR_CONNECT_PUBLIC_BASE_URL || env.ORKESTR_DEMO_PUBLIC_BASE_URL).slice(0, 500),
    setupUrl: clean(env.ORKESTR_CONNECT_PUBLIC_SETUP_URL || env.ORKESTR_DEMO_PUBLIC_SETUP_URL).slice(0, 800),
    relayAccountId: brokerClientRelayAccountId(env),
    heartbeatAt: nowIso(),
  };
}

export async function sendBrokerClientHeartbeat(env = process.env, options = {}) {
  if (!brokerClientHeartbeatConfigured(env)) {
    return { ok: false, skipped: true, reason: "broker_base_url_missing" };
  }
  const registration = await ensureBrokerClientRegistration(env, options);
  if (!registration.ok) {
    return {
      ok: false,
      reason: registration.reason || "broker_registration_unavailable",
      registration,
      status: registration.status || 0,
    };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch_unavailable", registration };
  const payload = brokerClientHeartbeatPayload(env);
  const body = await encryptBrokerClientPayload(payload, registration, env);
  const url = new URL(`/api/broker/instances/${encodeURIComponent(registration.instanceId)}/heartbeat`, registration.brokerBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  if (!response.ok || responseBody?.ok === false) {
    return {
      ok: false,
      reason: responseBody?.error || responseBody?.message || `broker_heartbeat_http_${response.status || "failed"}`,
      status: response.status || 0,
      registration,
      response: responseBody,
    };
  }
  return {
    ok: true,
    registration,
    heartbeat: responseBody,
    payload,
  };
}

export async function ensureBrokerClientRegistration(env = process.env, options = {}) {
  if (!canonicalInstanceUrlsEnabled(env)) return ensureBrokerClientRegistrationLocked(env, options);
  return withCanonicalPublicReferenceLock(() => ensureBrokerClientRegistrationLocked(env, options), env);
}

async function ensureBrokerClientRegistrationLocked(env = process.env, options = {}) {
  const paths = await ensureDataDirs(env);
  const configuredBrokerBaseUrl = clean(env.ORKESTR_BROKER_BASE_URL || env.ORKESTR_DEMO_BROKER_BASE_URL || options.brokerBaseUrl);
  if (!configuredBrokerBaseUrl) return { ok: false, reason: "broker_base_url_missing" };
  const brokerBaseUrl = normalizeBrokerBaseUrl(configuredBrokerBaseUrl);
  const configuredInstanceId = clean(env.ORKESTR_BROKER_INSTANCE_ID || env.ORKESTR_INSTANCE_ID || options.instanceId);
  const whatsappNumber = clean(env.ORKESTR_DEMO_WHATSAPP_NUMBER || env.ORKESTR_DEMO_WA_NUMBER);
  const whatsappTargetHash = brokerWhatsAppChatHash({ whatsappNumber });
  const relayAccountId = brokerClientRelayAccountId(env);
  const clientTargetScopeHash = brokerRegistrationTargetScopeHash({ whatsappNumber, relayAccountId });
  const rawCached = await readJson(paths.brokerClientRegistration, null);
  const cached = rawCached?.brokerBaseUrl
    ? { ...rawCached, brokerBaseUrl: normalizeBrokerBaseUrl(rawCached.brokerBaseUrl) }
    : rawCached;
  const canonicalRefs = canonicalInstanceUrlsEnabled(env);
  const cacheIsComplete = Boolean(
    cached?.instanceId &&
      cached?.channelId &&
      cached?.brokerBaseUrl &&
      cached?.brokerPublicKey &&
      (!canonicalRefs || cached?.publicRef),
  );
  const persistedIdentity = canonicalRefs ? await readInstanceIdentity(env) : null;
  const recoveryInstanceId = !cacheIsComplete ? clean(persistedIdentity?.internalInstanceId) : "";
  if (configuredInstanceId && recoveryInstanceId && configuredInstanceId !== recoveryInstanceId) {
    throw Object.assign(new Error("broker_instance_identity_id_conflict"), { statusCode: 409 });
  }
  const desiredInstanceId = configuredInstanceId || recoveryInstanceId;
  const token = clean(
    env.ORKESTR_DEMO_BROKER_REGISTRATION_TOKEN ||
      env.ORKESTR_BROKER_REGISTRATION_TOKEN ||
      options.registrationToken ||
      "",
  );
  const clientAuthScopeHash = sha256(token ? `credential:${sha256(token)}` : "unauthenticated");
  const cacheMatchesTarget = cached?.registrationTargetScopeHash
    ? cached.registrationTargetScopeHash === clientTargetScopeHash
    : !whatsappTargetHash || cached?.whatsappTargetHash === whatsappTargetHash;
  const cacheMatchesInstance = !desiredInstanceId || cached?.instanceId === desiredInstanceId;
  const cacheMatchesAuth = !canonicalRefs || !cached?.registrationAuthScopeHash || cached.registrationAuthScopeHash === clientAuthScopeHash;
  if (canonicalRefs && cached?.registrationAuthScopeHash && !cacheMatchesAuth) {
    throw Object.assign(new Error("broker_registration_auth_scope_conflict"), { statusCode: 409 });
  }
  if (cached?.instanceId && cached?.channelId && cached?.brokerBaseUrl === brokerBaseUrl && cacheMatchesTarget && cacheMatchesInstance && cacheMatchesAuth && !truthy(env.ORKESTR_BROKER_FORCE_REREGISTER) && (!canonicalRefs || cached.publicRef)) {
    if (canonicalRefs) await syncBrokerAuthoritativeInstanceIdentity({ instanceId: cached.instanceId, publicRef: cached.publicRef }, env);
    const pendingIntent = canonicalRefs ? await readBrokerRegistrationIntent(env) : null;
    if (pendingIntent && pendingIntent.registrationIntentId === cached.registrationIntentId) {
      await clearBrokerRegistrationIntent(pendingIntent, env, { removeIntent: options.removeRegistrationIntent }).catch(() => false);
    }
    return publicBrokerClientRegistration(cached, { ok: true, reused: true });
  }
  if (
    canonicalRefs &&
    persistedIdentity?.publicRef &&
    !cacheIsComplete &&
    !cached?.registrationIntentId &&
    !(await readBrokerRegistrationIntent(env))
  ) {
    return { ok: false, reason: "broker_registration_recovery_intent_missing", status: 409 };
  }
  const client = await ensureClientIdentity(env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch_unavailable" };
  const url = new URL("/api/broker/instances/register", brokerBaseUrl);
  if (canonicalRefs && cached?.registrationTargetScopeHash && cached.registrationTargetScopeHash !== clientTargetScopeHash) {
    throw Object.assign(new Error("broker_registration_target_scope_conflict"), { statusCode: 409 });
  }
  let registrationIntent = null;
  if (canonicalRefs) {
    const cachedIntentCanReplay = Boolean(
      cached?.registrationIntentId &&
        cached?.brokerBaseUrl === brokerBaseUrl &&
        (cached?.registrationTargetScopeHash
          ? cached.registrationTargetScopeHash === clientTargetScopeHash
          : cached?.whatsappTargetHash === whatsappTargetHash) &&
        cached?.clientKeyId === client.keyId &&
        cached?.registrationAuthScopeHash === clientAuthScopeHash,
    );
    registrationIntent = cachedIntentCanReplay
      ? { registrationIntentId: parseBrokerRegistrationIntentId(cached.registrationIntentId) }
      : await ensureBrokerRegistrationIntent({
        clientKeyFingerprint: publicKeyFingerprint(client.publicKey),
        brokerBaseUrl,
        targetScopeHash: clientTargetScopeHash,
        authScopeHash: clientAuthScopeHash,
      }, env, { writeIntent: options.writeRegistrationIntent });
  }
  const legacyAdoptionProof = canonicalRefs && cached?.instanceId && !cached?.publicRef && registrationIntent
    ? {
      channelId: cached.channelId,
      envelope: encryptBrokerChannelPayload({
        kind: "broker_registration_legacy_adoption_v1",
        instanceId: cached.instanceId,
        registrationIntentId: registrationIntent.registrationIntentId,
        authorizationCredentialHash: token ? sha256(token) : "open",
        targetScopeHash: clientTargetScopeHash,
      }, {
        clientPrivateKey: client.privateKey,
        brokerPublicKey: cached.brokerPublicKey,
        channelId: cached.channelId,
      }),
    }
    : undefined;
  const registrationBody = {
    displayName: clean(env.ORKESTR_DEMO_INSTANCE_NAME || env.ORKESTR_SERVICE_NAME || os.hostname()),
    version: clean(env.ORKESTR_VERSION || env.npm_package_version),
    capabilities: brokerClientCapabilities(env),
    encryptionPublicKey: client.publicKey,
    registrationIntentId: registrationIntent?.registrationIntentId || undefined,
    legacyAdoptionProof,
    brokerInstanceId: desiredInstanceId || (canonicalRefs ? cached?.instanceId : undefined) || undefined,
    endpointBaseUrl: clean(env.ORKESTR_DEMO_INTERNAL_BASE_URL || env.ORKESTR_API_BASE || env.ORKESTR_PUBLIC_APP_URL) || undefined,
    connectBaseUrl: clean(env.ORKESTR_CONNECT_PUBLIC_BASE_URL || env.ORKESTR_DEMO_PUBLIC_BASE_URL) || undefined,
    setupUrl: clean(env.ORKESTR_CONNECT_PUBLIC_SETUP_URL || env.ORKESTR_DEMO_PUBLIC_SETUP_URL) || undefined,
    relayAccountId: relayAccountId || undefined,
    whatsappNumber: whatsappNumber || undefined,
  };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(registrationBody),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false || !payload?.instanceId || !payload?.channelId || !payload?.broker?.publicKey) {
    return {
      ok: false,
      reason: payload?.error || payload?.message || `broker_registration_http_${response.status || "failed"}`,
      status: response.status || 0,
    };
  }
  if (canonicalRefs && !payload?.publicRef) {
    return { ok: false, reason: "broker_instance_public_ref_missing", status: response.status || 0 };
  }
  if (canonicalRefs) {
    if (persistedIdentity?.publicRef && parseInstancePublicRef(payload.publicRef) !== persistedIdentity.publicRef) {
      throw Object.assign(new Error("broker_instance_public_ref_conflict"), { statusCode: 409 });
    }
    const syncRegistrationIdentity = options.syncRegistrationIdentity || syncBrokerAuthoritativeInstanceIdentity;
    await syncRegistrationIdentity({ instanceId: payload.instanceId, publicRef: payload.publicRef }, env);
  }
  const registration = {
    schemaVersion: 1,
    brokerBaseUrl,
    instanceId: payload.instanceId,
    ...(payload.publicRef ? { publicRef: parseInstancePublicRef(payload.publicRef) } : {}),
    channelId: payload.channelId,
    brokerKeyId: payload.broker.keyId || "",
    brokerPublicKey: payload.broker.publicKey,
    clientKeyId: client.keyId,
    ...(registrationIntent ? {
      registrationIntentId: registrationIntent.registrationIntentId,
      registrationAuthScopeHash: clientAuthScopeHash,
      registrationTargetScopeHash: clientTargetScopeHash,
    } : {}),
    whatsappTargetHash,
    registeredAt: payload.registeredAt || nowIso(),
    updatedAt: nowIso(),
  };
  const writeRegistrationCache = options.writeRegistrationCache || writeSecretJson;
  try {
    await writeRegistrationCache(paths.brokerClientRegistration, registration);
  } catch (cause) {
    throw Object.assign(new Error("broker_client_registration_cache_write_failed", { cause }), {
      statusCode: 500,
      recoverable: canonicalRefs,
      instanceId: registration.instanceId,
      publicRef: registration.publicRef || "",
    });
  }
  if (canonicalRefs && registrationIntent) {
    await clearBrokerRegistrationIntent(registrationIntent, env, { removeIntent: options.removeRegistrationIntent }).catch(() => false);
  }
  return publicBrokerClientRegistration(registration, { ok: true, reused: false });
}

export async function encryptBrokerClientPayload(payload = {}, registration = {}, env = process.env) {
  const paths = await ensureDataDirs(env);
  const client = await readJson(paths.brokerClientIdentity, null);
  const channelId = clean(registration.channelId);
  const brokerPublicKey = clean(registration.brokerPublicKey);
  if (!client?.privateKey || !channelId || !brokerPublicKey) {
    throw Object.assign(new Error("broker_client_registration_missing"), { statusCode: 409 });
  }
  return {
    channelId,
    envelope: encryptBrokerChannelPayload(payload, {
      clientPrivateKey: client.privateKey,
      brokerPublicKey,
      channelId,
    }),
  };
}

export async function encryptBrokerInstancePayload(instanceId, payload = {}, env = process.env) {
  const record = await brokerInstance(instanceId, env);
  if (!record) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
  if (record.disabledAt || ["disabled", "deleted", "revoked"].includes(clean(record.status).toLowerCase())) {
    throw Object.assign(new Error("broker_instance_disabled"), { statusCode: 410 });
  }
  const brokerChannel = await ensureBrokerChannel(env);
  return {
    record,
    body: {
      channelId: record.channelId,
      envelope: encryptBrokerChannelPayload(payload, {
        clientPrivateKey: brokerChannel.privateKey,
        brokerPublicKey: record.encryptionPublicKey,
        channelId: record.channelId,
      }),
    },
  };
}

export async function encryptBrokerInstanceProxyPayload(instanceId, payload = {}, env = process.env) {
  const registry = await readRegistry(env);
  const record = registry.instances.find((instance) => instance.instanceId === clean(instanceId));
  if (!record) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
  if (!usableBrokerInstanceRecord(record)) {
    throw Object.assign(new Error("broker_instance_disabled"), { statusCode: 410 });
  }
  const routeEndpoint = normalizedEndpointBaseUrl(record.endpointBaseUrl);
  const candidates = routeEndpoint
    ? registry.instances.filter((instance) => usableBrokerInstanceRecord(instance) && normalizedEndpointBaseUrl(instance.endpointBaseUrl) === routeEndpoint)
    : [record];
  const encryptionRecord = (candidates.length ? candidates : [record])
    .sort((left, right) => brokerRecordSortTime(right) - brokerRecordSortTime(left))[0] || record;
  const brokerChannel = await ensureBrokerChannel(env);
  return {
    record,
    encryptionRecord,
    body: {
      channelId: encryptionRecord.channelId,
      envelope: encryptBrokerChannelPayload(payload, {
        clientPrivateKey: brokerChannel.privateKey,
        brokerPublicKey: encryptionRecord.encryptionPublicKey,
        channelId: encryptionRecord.channelId,
      }),
    },
  };
}

export async function decryptBrokerClientPayload(body = {}, env = process.env, options = {}) {
  const paths = await ensureDataDirs(env);
  const registration = await readJson(paths.brokerClientRegistration, null);
  const client = await readJson(paths.brokerClientIdentity, null);
  const channelId = clean(body.channelId);
  if (!registration?.instanceId || !registration?.channelId || !registration?.brokerPublicKey || !client?.privateKey) {
    throw Object.assign(new Error("broker_client_registration_missing"), { statusCode: 409 });
  }
  if (!channelId || (!options.allowAnyChannelId && channelId !== clean(registration.channelId))) {
    throw Object.assign(new Error("broker_channel_denied"), { statusCode: 401 });
  }
  const payload = decryptBrokerChannelPayload(body.envelope || body, {
    brokerPrivateKey: client.privateKey,
    instancePublicKey: registration.brokerPublicKey,
    channelId,
  });
  return { registration, payload, channelId };
}

export async function decryptBrokerInstanceRequest(instanceId, body = {}, env = process.env) {
  const record = await brokerInstance(instanceId, env);
  if (!record) throw Object.assign(new Error("broker_instance_not_found"), { statusCode: 404 });
  if (record.disabledAt || ["disabled", "deleted", "revoked"].includes(clean(record.status).toLowerCase())) {
    throw Object.assign(new Error("broker_instance_disabled"), { statusCode: 410 });
  }
  if (clean(body.channelId) !== record.channelId) {
    throw Object.assign(new Error("broker_channel_denied"), { statusCode: 401 });
  }
  const brokerChannel = await ensureBrokerChannel(env);
  const payload = decryptBrokerChannelPayload(body.envelope || body, {
    brokerPrivateKey: brokerChannel.privateKey,
    instancePublicKey: record.encryptionPublicKey,
    channelId: record.channelId,
  });
  return { record, payload };
}

export const __brokerInstanceRegistryTestInternals = {
  createX25519Identity,
  decryptJson,
  deriveChannelKey,
  deriveSharedSecret,
};
