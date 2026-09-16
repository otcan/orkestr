import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as age from "age-encryption";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { incrementCounter, observeHistogram } from "./observability.js";
import { getThreadForPrincipal, assertThreadOperational } from "./threads.js";
import { resourceOwnerUserId } from "./policy.js";
import {
  inboundAttachmentKeyById,
  inboundAttachmentRecipientDescriptor,
  ensureInboundAttachmentKey,
  verifyInboundAttachmentRecipientDescriptor,
} from "./inbound-attachment-keys.js";
import { inboundAttachmentUploadPolicy, requireInboundAttachmentUploadReady } from "./inbound-attachment-config.js";
import { writeInboundAttachmentPayload } from "./inbound-attachment-payload.js";
import { recordWatcherAlert } from "./watcher-alerts.js";
import { scanInboundAttachment } from "./inbound-attachment-scanner.js";
import { inboundAttachmentUploadState, publicInboundAttachmentUploadSession } from "./inbound-attachment-session-projection.js";
import { runtimeProcessIdentity, runtimeProcessIdentityAlive } from "./runtime-lease-lock.js";
import { withInboundAttachmentMutationLock } from "./inbound-attachment-store-lock.js";
import {
  inboundAttachmentCiphertextPath,
  inboundAttachmentFileDigest,
  inboundAttachmentLeaseDirectory,
  inboundAttachmentQuarantineRoot,
  inboundAttachmentReleasePath,
  inboundAttachmentStagingPath,
  writeInboundAttachmentCiphertext,
} from "./inbound-attachment-files.js";

const storeVersion = 2;
const terminalStates = new Set(["ready", "rejected", "cancelled", "expired"]);
const processingStates = new Set(["validating", "scanning"]);
const publicErrorCodes = new Set([
  "cancelled_by_user",
  "inbound_upload_ciphertext_invalid",
  "inbound_upload_ciphertext_missing",
  "inbound_upload_ciphertext_tampered",
  "inbound_upload_descriptor_expired",
  "inbound_upload_descriptor_invalid",
  "inbound_upload_key_unavailable",
  "inbound_upload_permission_recheck_failed",
  "inbound_upload_processing_failed",
  "inbound_upload_session_expired",
  "inbound_upload_scanner_rejected",
  "inbound_upload_scanner_unavailable",
  "inbound_upload_superseded",
  "plaintext_lease_expired",
  "restart_reconciliation_required",
]);

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function safeSessionId(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(id) ? id : "";
}

function safeIdempotencyKey(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{8,160}$/.test(id) ? id : "";
}

function fail(code, statusCode = 409) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function defaults(raw = {}) {
  return {
    version: storeVersion,
    revision: Math.max(0, Number(raw?.revision || 0) || 0),
    sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
  };
}

async function readStore(env = process.env) {
  return defaults(await readJson(dataPaths(env).inboundAttachmentUploads, null));
}

async function writeStore(store, env = process.env) {
  const next = {
    ...defaults(store),
    version: storeVersion,
    revision: Math.max(0, Number(store.revision || 0) || 0) + 1,
    updatedAt: nowIso(),
  };
  await writeJson(dataPaths(env).inboundAttachmentUploads, next);
  await fsp.chmod(dataPaths(env).inboundAttachmentUploads, 0o600);
  return next;
}

async function mutateStore(env, operation) {
  return withInboundAttachmentMutationLock(env, async () => {
    const store = await readStore(env);
    const result = await operation(store);
    if (result?.changed) await writeStore(store, env);
    return result?.value;
  });
}

function recordMetric(state, outcome, durationMs = null) {
  const labels = {
    state: inboundAttachmentUploadState(state),
    outcome: ["accepted", "ready", "rejected", "retryable", "expired", "cancelled", "failed"].includes(clean(outcome)) ? clean(outcome) : "failed",
  };
  incrementCounter("orkestr_inbound_attachment_upload_transitions_total", labels);
  if (durationMs !== null) observeHistogram("orkestr_inbound_attachment_scan_duration_seconds", Math.max(0, Number(durationMs) || 0) / 1000, labels);
}

async function requireThread(threadId, principal, env = process.env) {
  const thread = await getThreadForPrincipal(clean(threadId), principal, env);
  if (!thread) throw fail("thread_not_found", 404);
  assertThreadOperational(thread);
  return thread;
}

async function assertSessionAuthority(session, principal, env = process.env) {
  const thread = await requireThread(session.threadId, principal, env);
  if (clean(thread.id) !== clean(session.threadId) || clean(resourceOwnerUserId(thread, env)) !== clean(session.ownerUserId)) {
    throw fail("inbound_upload_permission_recheck_failed", 403);
  }
  return thread;
}

async function authorizedSession(sessionId, principal, env = process.env) {
  const id = safeSessionId(sessionId);
  if (!id) throw fail("inbound_upload_session_invalid", 400);
  const session = (await readStore(env)).sessions.find((item) => clean(item.id) === id);
  if (!session) throw fail("inbound_upload_session_not_found", 404);
  const thread = await assertSessionAuthority(session, principal, env);
  return { session, thread };
}

function isReceivingExpired(session, now = Date.now()) {
  const expiry = Date.parse(clean(session.expiresAt));
  return session.state === "receiving" && Number.isFinite(expiry) && expiry <= now;
}

function isReleaseExpired(session, now = Date.now()) {
  if (session.state !== "ready") return false;
  const expiry = Date.parse(clean(session.release?.expiresAt));
  return !Number.isFinite(expiry) || expiry <= now;
}

function isProcessingLeaseExpired(session, now = Date.now()) {
  const expiry = Date.parse(clean(session.processingLease?.expiresAt));
  return !Number.isFinite(expiry) || expiry <= now;
}

function stableError(value, fallback = "inbound_upload_processing_failed") {
  const code = clean(value);
  return publicErrorCodes.has(code) ? code : fallback;
}

function failureState(error) {
  const code = clean(error?.message || error);
  if (["inbound_upload_scanner_unavailable", "inbound_upload_superseded", "restart_reconciliation_required"].includes(code)) {
    return { state: "retryable", error: stableError(code, "inbound_upload_scanner_unavailable") };
  }
  if (["thread_not_found", "thread_access_forbidden", "inbound_upload_tenant_mismatch", "inbound_upload_permission_recheck_failed"].includes(code)) {
    return { state: "cancelled", error: "inbound_upload_permission_recheck_failed" };
  }
  if (["inbound_upload_descriptor_invalid", "inbound_upload_descriptor_expired"].includes(code)) {
    return { state: "rejected", error: stableError(code) };
  }
  if (code.includes("ciphertext") || code.includes("decrypt") || code.includes("age")) {
    return { state: "rejected", error: "inbound_upload_ciphertext_invalid" };
  }
  if (code === "inbound_upload_key_unavailable") return { state: "rejected", error: code };
  return { state: "rejected", error: "inbound_upload_processing_failed" };
}

function activeForQuota(session) {
  return !terminalStates.has(clean(session.state));
}

function reservedCiphertextBytes(session) {
  return Math.max(0, Number(session.ciphertext?.size ?? session.ciphertextReservation ?? 0) || 0);
}

function quotaUsage(sessions, ownerUserId = "") {
  return sessions.filter(activeForQuota)
    .filter((session) => !ownerUserId || clean(session.ownerUserId) === clean(ownerUserId))
    .reduce((total, session) => total + reservedCiphertextBytes(session), 0);
}

function activeSessionCount(sessions, ownerUserId = "") {
  return sessions.filter(activeForQuota).filter((session) => !ownerUserId || clean(session.ownerUserId) === clean(ownerUserId)).length;
}

function processingCount(sessions, ownerUserId = "") {
  return sessions.filter((session) => processingStates.has(clean(session.state)))
    .filter((session) => !ownerUserId || clean(session.ownerUserId) === clean(ownerUserId)).length;
}

function sessionCiphertextLimit(plaintextSize, policy) {
  return Math.min(policy.maxCiphertextBytes, plaintextSize + policy.ciphertextOverheadBytes);
}

function leaseArtifactPaths(session, token, env) {
  if (!safeSessionId(session?.id) || !clean(token)) return [];
  return [
    inboundAttachmentLeaseDirectory(session, token, env),
    inboundAttachmentStagingPath(session, token, env),
    inboundAttachmentReleasePath(session, token, env),
  ];
}

function pathInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved.startsWith(`${base}${path.sep}`);
}

async function removeOwnedArtifact(target, root) {
  if (!target || !pathInside(root, target)) return false;
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function removeArtifacts(paths, env) {
  const quarantine = inboundAttachmentQuarantineRoot(env);
  const uploads = path.join(dataPaths(env).home, "uploads");
  let removed = 0;
  for (const target of paths) {
    if (await removeOwnedArtifact(target, quarantine) || await removeOwnedArtifact(target, uploads)) removed += 1;
  }
  return removed;
}

async function transitionExpiredSession(sessionId, env = process.env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !isReceivingExpired(session)) return { changed: false, value: session || null };
    session.state = "expired";
    session.error = "inbound_upload_session_expired";
    session.updatedAt = nowIso();
    recordMetric("expired", "expired");
    return { changed: true, value: session };
  });
}

async function expireReadySession(sessionId, env = process.env) {
  const expired = await mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !isReleaseExpired(session)) return { changed: false, value: null };
    const releasePath = clean(session.release?.path);
    session.state = "expired";
    session.error = "plaintext_lease_expired";
    session.updatedAt = nowIso();
    return { changed: true, value: { session, releasePath } };
  });
  if (expired?.releasePath) await removeArtifacts([expired.releasePath], env);
  return expired?.session || null;
}

export async function inboundAttachmentUploadStatus({ threadId, principal, env = process.env } = {}) {
  const thread = await requireThread(threadId, principal, env);
  const policy = inboundAttachmentUploadPolicy(env);
  return {
    threadId: thread.id,
    enabled: policy.enabled,
    required: policy.required,
    ready: policy.ready,
    reason: policy.reason,
    limits: { maxFileBytes: policy.maxFileBytes, maxFiles: policy.maxFiles, sessionTtlMs: policy.sessionTtlMs },
  };
}

export async function createInboundAttachmentUploadSessions({ threadId, files = [], principal, env = process.env } = {}) {
  const policy = requireInboundAttachmentUploadReady(env);
  const thread = await requireThread(threadId, principal, env);
  if (!Array.isArray(files) || !files.length || files.length > policy.maxFiles) throw fail("inbound_upload_files_invalid", 400);
  const ownerUserId = clean(resourceOwnerUserId(thread, env));
  const key = await ensureInboundAttachmentKey(ownerUserId, env);
  const sessions = await mutateStore(env, async (store) => {
    const result = [];
    let changed = false;
    let ownerReserved = quotaUsage(store.sessions, ownerUserId);
    let globalReserved = quotaUsage(store.sessions);
    let ownerCount = activeSessionCount(store.sessions, ownerUserId);
    let globalCount = activeSessionCount(store.sessions);
    for (const input of files) {
      const idempotencyKey = safeIdempotencyKey(input?.idempotencyKey || input?.id);
      const plaintextSize = Number(input?.plaintextSize ?? input?.size);
      if (!idempotencyKey || !Number.isSafeInteger(plaintextSize) || plaintextSize < 1 || plaintextSize > policy.maxFileBytes) {
        throw fail("inbound_upload_descriptor_invalid", 400);
      }
      const existing = store.sessions.find((session) =>
        clean(session.ownerUserId) === ownerUserId && clean(session.threadId) === thread.id && clean(session.idempotencyKey) === idempotencyKey);
      if (existing) {
        if (Number(existing.plaintextSize) !== plaintextSize) throw fail("inbound_upload_idempotency_conflict", 409);
        result.push(existing);
        continue;
      }
      const ciphertextReservation = sessionCiphertextLimit(plaintextSize, policy);
      if (ownerCount >= policy.maxSessionsPerOwner || globalCount >= policy.maxSessionsGlobal
        || ownerReserved + ciphertextReservation > policy.maxOwnerQuarantineBytes
        || globalReserved + ciphertextReservation > policy.maxQuarantineBytes) {
        throw fail("inbound_upload_quota_exceeded", 413);
      }
      const createdAt = nowIso();
      const session = {
        id: `inbound-${randomUUID()}`,
        ownerUserId,
        threadId: thread.id,
        idempotencyKey,
        keyId: key.id,
        keyVersion: key.version,
        plaintextSize,
        ciphertextReservation,
        maxCiphertextBytes: ciphertextReservation,
        state: "receiving",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(Date.now() + policy.sessionTtlMs).toISOString(),
        error: "",
      };
      store.sessions.push(session);
      ownerReserved += ciphertextReservation;
      globalReserved += ciphertextReservation;
      ownerCount += 1;
      globalCount += 1;
      result.push(session);
      changed = true;
      recordMetric("receiving", "accepted");
    }
    return { changed, value: result };
  });
  await Promise.all(sessions.map((session) => appendEvent({
    type: "inbound_attachment_session_created",
    threadId: session.threadId,
    ownerUserId: session.ownerUserId,
    keyVersion: session.keyVersion,
    state: session.state,
  }, env).catch(() => {})));
  const descriptors = new Map(await Promise.all(sessions.map(async (session) => {
    const sessionKey = await inboundAttachmentKeyById(ownerUserId, session.keyId, env);
    return [session.id, await inboundAttachmentRecipientDescriptor(session, sessionKey, policy, env)];
  })));
  return {
    threadId: thread.id,
    sessions: sessions.map((session) => ({
      ...publicInboundAttachmentUploadSession(session),
      recipient: clean(descriptors.get(session.id)?.recipient),
      descriptor: descriptors.get(session.id) || null,
      purpose: "inbound_attachment_upload",
    })),
  };
}

export async function ingestInboundAttachmentCiphertext({ sessionId, principal, input, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (isReceivingExpired(session)) {
    await transitionExpiredSession(session.id, env);
    throw fail("inbound_upload_session_expired", 410);
  }
  if (session.state !== "receiving" && !(session.state === "quarantined" && session.ciphertext)) {
    throw fail("inbound_upload_session_not_receiving", 409);
  }
  if (!input || typeof input[Symbol.asyncIterator] !== "function") throw fail("inbound_upload_ciphertext_required", 400);
  const finalPath = inboundAttachmentCiphertextPath(session, env);
  const ciphertext = await writeInboundAttachmentCiphertext(input, finalPath, Number(session.maxCiphertextBytes || 0));
  let stored;
  try {
    stored = await mutateStore(env, async (store) => {
      const current = store.sessions.find((item) => clean(item.id) === session.id);
      if (!current) throw fail("inbound_upload_session_not_found", 404);
      if (isReceivingExpired(current)) {
        current.state = "expired";
        current.error = "inbound_upload_session_expired";
        current.updatedAt = nowIso();
        return { changed: true, value: { expired: true, session: current } };
      }
      if (current.ciphertext) {
        if (Number(current.ciphertext.size) !== ciphertext.size || clean(current.ciphertext.checksum) !== ciphertext.checksum) {
          throw fail("inbound_upload_idempotency_conflict", 409);
        }
        return { changed: false, value: { session: current, duplicate: true } };
      }
      if (current.state !== "receiving") throw fail("inbound_upload_session_not_receiving", 409);
      const remaining = store.sessions.filter((item) => clean(item.id) !== clean(current.id));
      const policy = inboundAttachmentUploadPolicy(env);
      if (quotaUsage(remaining, current.ownerUserId) + ciphertext.size > policy.maxOwnerQuarantineBytes
        || quotaUsage(remaining) + ciphertext.size > policy.maxQuarantineBytes) {
        throw fail("inbound_upload_quota_exceeded", 413);
      }
      await fsp.rename(ciphertext.temporaryPath, finalPath);
      current.ciphertext = { size: ciphertext.size, checksum: ciphertext.checksum, storedAt: nowIso() };
      current.state = "quarantined";
      current.error = "";
      current.updatedAt = nowIso();
      recordMetric("quarantined", "accepted");
      return { changed: true, value: { session: current, duplicate: false } };
    });
  } catch (error) {
    await fsp.rm(ciphertext.temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  await fsp.rm(ciphertext.temporaryPath, { force: true }).catch(() => {});
  if (stored.expired) throw fail("inbound_upload_session_expired", 410);
  await appendEvent({
    type: "inbound_attachment_ciphertext_quarantined",
    threadId: stored.session.threadId,
    ownerUserId: stored.session.ownerUserId,
    ciphertextSize: stored.session.ciphertext?.size || 0,
    state: stored.session.state,
  }, env).catch(() => {});
  return publicInboundAttachmentUploadSession(stored.session);
}

async function staleProcessingLease(session) {
  if (!isProcessingLeaseExpired(session)) return false;
  return (await runtimeProcessIdentityAlive(session.processingLease)) === false;
}

async function claimProcessing(sessionId, principal, policy, env) {
  await authorizedSession(sessionId, principal, env);
  const identity = await runtimeProcessIdentity();
  const token = randomUUID();
  const claimed = await mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session) throw fail("inbound_upload_session_not_found", 404);
    if (session.state === "ready") return { changed: false, value: { session, owned: false, artifacts: [] } };
    const artifacts = [];
    if (processingStates.has(session.state)) {
      if (!await staleProcessingLease(session)) return { changed: false, value: { session, owned: false, artifacts } };
      artifacts.push(...leaseArtifactPaths(session, session.processingToken, env));
      session.state = "retryable";
      session.error = "restart_reconciliation_required";
      delete session.processingToken;
      delete session.processingLease;
    }
    if (session.state !== "quarantined" && session.state !== "retryable") throw fail("inbound_upload_session_not_quarantined", 409);
    if (!session.ciphertext) throw fail("inbound_upload_ciphertext_missing", 409);
    if (processingCount(store.sessions, session.ownerUserId) >= policy.maxConcurrentProcessingPerOwner
      || processingCount(store.sessions) >= policy.maxConcurrentProcessingGlobal) {
      throw fail("inbound_upload_processing_capacity_exceeded", 429);
    }
    session.state = "validating";
    session.error = "";
    session.processingToken = token;
    session.processingLease = {
      token,
      pid: process.pid,
      processStartIdentity: identity,
      claimedAt: nowIso(),
      heartbeatAt: nowIso(),
      expiresAt: new Date(Date.now() + policy.processingLeaseMs).toISOString(),
    };
    session.updatedAt = nowIso();
    return { changed: true, value: { session: { ...session }, owned: true, artifacts } };
  });
  await removeArtifacts(claimed.artifacts, env);
  return claimed;
}

async function renewProcessingLease(sessionId, token, policy, env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !processingStates.has(session.state) || clean(session.processingToken) !== clean(token)
      || clean(session.processingLease?.token) !== clean(token)) throw fail("inbound_upload_superseded", 409);
    session.processingLease.heartbeatAt = nowIso();
    session.processingLease.expiresAt = new Date(Date.now() + policy.processingLeaseMs).toISOString();
    session.updatedAt = nowIso();
    return { changed: true, value: session };
  });
}

async function setScanning(sessionId, token, policy, env) {
  await renewProcessingLease(sessionId, token, policy, env);
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || session.state !== "validating" || clean(session.processingToken) !== clean(token)) throw fail("inbound_upload_superseded", 409);
    session.state = "scanning";
    session.updatedAt = nowIso();
    return { changed: true, value: session };
  });
}

async function completeProcessing(sessionId, token, patch, env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !processingStates.has(session.state) || clean(session.processingToken) !== clean(token)) throw fail("inbound_upload_superseded", 409);
    Object.assign(session, patch, { error: stableError(patch.error, ""), updatedAt: nowIso() });
    delete session.processingToken;
    delete session.processingLease;
    return { changed: true, value: session };
  });
}

async function publishStagedAttachment({ session, token, decoded, principal, policy, stagePath, destination, env }) {
  await assertSessionAuthority(session, principal, env);
  return withInboundAttachmentMutationLock(env, async () => {
    const store = await readStore(env);
    const current = store.sessions.find((item) => clean(item.id) === clean(session.id));
    if (!current || current.state !== "scanning" || clean(current.processingToken) !== clean(token)) throw fail("inbound_upload_superseded", 409);
    const key = await inboundAttachmentKeyById(current.ownerUserId, current.keyId, env);
    if (!key || key.status === "revoked" || !clean(key.identity)) throw fail("inbound_upload_key_unavailable", 409);
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.rename(stagePath, destination);
    await fsp.chmod(destination, 0o600);
    current.state = "ready";
    current.error = "";
    current.release = {
      attachmentId: `inbound-attachment-${randomUUID()}`,
      path: destination,
      filename: decoded.filename,
      mimetype: decoded.mimetype,
      size: decoded.size,
      checksum: decoded.checksum,
      scannedAt: nowIso(),
      expiresAt: new Date(Date.now() + policy.plaintextLeaseMs).toISOString(),
    };
    delete current.processingToken;
    delete current.processingLease;
    current.updatedAt = nowIso();
    try {
      await writeStore(store, env);
    } catch (error) {
      await removeOwnedArtifact(destination, path.join(dataPaths(env).home, "uploads"));
      throw error;
    }
    return current;
  });
}

function startLeaseHeartbeat(sessionId, token, policy, env) {
  const intervalMs = Math.max(1_000, Math.floor(policy.processingLeaseMs / 3));
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    renewProcessingLease(sessionId, token, policy, env).catch(() => {}).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

export async function processInboundAttachmentUpload({ sessionId, principal, env = process.env, scanner } = {}) {
  const policy = inboundAttachmentUploadPolicy(env);
  if (!policy.ready || (typeof scanner === "function" && !policy.testIsolation)) throw fail(policy.reason || "inbound_upload_not_ready", 503);
  const claim = await claimProcessing(sessionId, principal, policy, env);
  if (!claim.owned) return publicInboundAttachmentUploadSession(claim.session);
  const session = claim.session;
  const token = session.processingToken;
  const startedAt = Date.now();
  const leaseDir = inboundAttachmentLeaseDirectory(session, token, env);
  const plaintextPath = path.join(leaseDir, "payload");
  const stagePath = inboundAttachmentStagingPath(session, token, env);
  const destination = inboundAttachmentReleasePath(session, token, env);
  const stopHeartbeat = startLeaseHeartbeat(session.id, token, policy, env);
  let published = false;
  try {
    const key = await inboundAttachmentKeyById(session.ownerUserId, session.keyId, env);
    if (!key || key.status === "revoked" || !clean(key.identity)) throw fail("inbound_upload_key_unavailable", 409);
    const cipherPath = inboundAttachmentCiphertextPath(session, env);
    const stat = await fsp.stat(cipherPath).catch(() => null);
    if (!stat?.isFile() || stat.size !== Number(session.ciphertext?.size || 0)) throw fail("inbound_upload_ciphertext_missing", 409);
    const digest = await inboundAttachmentFileDigest(cipherPath);
    if (clean(digest.checksum) !== clean(session.ciphertext?.checksum)) throw fail("inbound_upload_ciphertext_tampered", 409);
    await fsp.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(leaseDir, 0o700);
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(key.identity);
    const plaintext = await decrypter.decrypt(Readable.toWeb(createReadStream(cipherPath)));
    const decoded = await writeInboundAttachmentPayload(plaintext, {
      destinationPath: plaintextPath,
      sessionId: session.id,
      keyId: session.keyId,
      plaintextSize: session.plaintextSize,
      maxPlaintextBytes: policy.maxFileBytes,
    });
    await verifyInboundAttachmentRecipientDescriptor(decoded.descriptor, session, key, policy, env);
    await assertSessionAuthority(session, principal, env);
    await setScanning(session.id, token, policy, env);
    const verdict = await scanInboundAttachment(plaintextPath, policy, scanner);
    if (!verdict.approved) {
      const state = verdict.retryable ? "retryable" : "rejected";
      const error = verdict.retryable ? "inbound_upload_scanner_unavailable" : "inbound_upload_scanner_rejected";
      const completed = await completeProcessing(session.id, token, { state, error }, env);
      recordMetric(state, state, Date.now() - startedAt);
      if (state === "retryable") {
        await recordWatcherAlert({
          source: "inbound_attachment_upload",
          code: "scanner_unavailable",
          severity: "warning",
          message: "Inbound encrypted attachment remains quarantined because its approved scanner did not return a clean verdict.",
          details: { state },
        }, env).catch(() => {});
      }
      return publicInboundAttachmentUploadSession(completed);
    }
    await renewProcessingLease(session.id, token, policy, env);
    await fsp.mkdir(path.dirname(stagePath), { recursive: true, mode: 0o700 });
    await fsp.rename(plaintextPath, stagePath);
    await fsp.chmod(stagePath, 0o600);
    const completed = await publishStagedAttachment({ session, token, decoded, principal, policy, stagePath, destination, env });
    published = true;
    await fsp.rm(cipherPath, { force: true }).catch(() => {});
    recordMetric("ready", "ready", Date.now() - startedAt);
    await appendEvent({
      type: "inbound_attachment_scan_approved",
      threadId: completed.threadId,
      ownerUserId: completed.ownerUserId,
      state: completed.state,
      plaintextSize: completed.release.size,
      keyVersion: completed.keyVersion,
    }, env).catch(() => {});
    return publicInboundAttachmentUploadSession(completed);
  } catch (error) {
    const next = failureState(error);
    const completed = await completeProcessing(session.id, token, { state: next.state, error: next.error }, env).catch(() => null);
    recordMetric(next.state, next.state, Date.now() - startedAt);
    if (next.state === "retryable") {
      await recordWatcherAlert({
        source: "inbound_attachment_upload",
        code: "inbound_attachment_processing_retryable",
        severity: "warning",
        message: "Inbound encrypted attachment remains quarantined pending a retryable processing failure.",
        details: { state: next.state },
      }, env).catch(() => {});
    }
    if (completed) return publicInboundAttachmentUploadSession(completed);
    // A competing fenced worker may have terminally changed this session.
    // Never relay the original decoder/scanner error through that race.
    throw fail("inbound_upload_superseded", 409);
  } finally {
    stopHeartbeat();
    await removeArtifacts([leaseDir, stagePath, ...(published ? [] : [destination])], env);
  }
}

export async function inboundAttachmentUploadSession({ sessionId, principal, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (isReceivingExpired(session)) return publicInboundAttachmentUploadSession(await transitionExpiredSession(session.id, env));
  if (isReleaseExpired(session)) return publicInboundAttachmentUploadSession(await expireReadySession(session.id, env));
  return publicInboundAttachmentUploadSession(session);
}

export async function cancelInboundAttachmentUpload({ sessionId, principal, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (terminalStates.has(session.state) || processingStates.has(session.state)) return publicInboundAttachmentUploadSession(session);
  const cancelled = await mutateStore(env, async (store) => {
    const current = store.sessions.find((item) => clean(item.id) === session.id);
    if (!current || terminalStates.has(current.state) || processingStates.has(current.state)) return { changed: false, value: current || session };
    current.state = "cancelled";
    current.error = "cancelled_by_user";
    current.updatedAt = nowIso();
    return { changed: true, value: current };
  });
  await fsp.rm(inboundAttachmentCiphertextPath(cancelled, env), { force: true }).catch(() => {});
  recordMetric("cancelled", "cancelled");
  return publicInboundAttachmentUploadSession(cancelled);
}

async function removeStaleTemporaryCiphertext(env, policy) {
  const root = path.join(inboundAttachmentQuarantineRoot(env), "ciphertext");
  const cutoff = Date.now() - policy.partialUploadTtlMs;
  let removed = 0;
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".tmp")) {
        const stat = await fsp.stat(target).catch(() => null);
        if (stat && stat.mtimeMs <= cutoff && await removeOwnedArtifact(target, root)) removed += 1;
      }
    }
  }
  await visit(root);
  return removed;
}

async function runInboundAttachmentSweep(env = process.env, startup = false) {
  const policy = inboundAttachmentUploadPolicy(env);
  const now = Date.now();
  const sweep = await mutateStore(env, async (store) => {
    let changed = false;
    const artifacts = [];
    const ciphertext = [];
    const retainedAt = now - policy.terminalRetentionMs;
    for (const session of store.sessions) {
      if (isReceivingExpired(session, now)) {
        session.state = "expired";
        session.error = "inbound_upload_session_expired";
        session.updatedAt = nowIso(now);
        changed = true;
      }
      if (processingStates.has(session.state) && isProcessingLeaseExpired(session, now) && await staleProcessingLease(session)) {
        artifacts.push(...leaseArtifactPaths(session, session.processingToken, env));
        session.state = "retryable";
        session.error = "restart_reconciliation_required";
        delete session.processingToken;
        delete session.processingLease;
        session.updatedAt = nowIso(now);
        changed = true;
      }
      if (isReleaseExpired(session, now)) {
        artifacts.push(clean(session.release?.path));
        session.state = "expired";
        session.error = "plaintext_lease_expired";
        session.updatedAt = nowIso(now);
        changed = true;
      }
      const updatedAt = Date.parse(clean(session.updatedAt || session.createdAt));
      if (["rejected", "cancelled", "expired"].includes(session.state) && Number.isFinite(updatedAt) && updatedAt <= retainedAt) {
        ciphertext.push(inboundAttachmentCiphertextPath(session, env));
      }
    }
    return { changed, value: { sessions: store.sessions, artifacts, ciphertext } };
  });
  const removedPlaintext = await removeArtifacts(sweep.artifacts, env);
  for (const target of sweep.ciphertext) await removeOwnedArtifact(target, path.join(inboundAttachmentQuarantineRoot(env), "ciphertext"));
  const removedTemporaryCiphertext = await removeStaleTemporaryCiphertext(env, policy);
  return {
    retryable: sweep.sessions.filter((session) => session.state === "retryable").length,
    expired: sweep.sessions.filter((session) => session.state === "expired").length,
    removedPlaintext,
    removedTemporaryCiphertext,
    startup,
  };
}

// Both paths recover only a lease proven expired and dead. The explicit names
// prevent a periodic sweep from deleting active scan plaintext.
export function recoverInboundAttachmentStartupOrphans(env = process.env) {
  return runInboundAttachmentSweep(env, true);
}

export function sweepInboundAttachmentQuarantine(env = process.env) {
  return runInboundAttachmentSweep(env, false);
}

// Compatibility for the first implementation. It is now safe and only used by
// legacy direct callers; server startup and periodic execution are explicit.
export function reconcileInboundAttachmentQuarantine(env = process.env) {
  return recoverInboundAttachmentStartupOrphans(env);
}
