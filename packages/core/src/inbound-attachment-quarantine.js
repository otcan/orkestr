import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
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
import { inboundAttachmentWorkerHealth } from "./inbound-attachment-worker-client.js";
import {
  createInboundAttachmentUploadSessionsWorkflow,
  cancelInboundAttachmentUploadWorkflow,
  ingestInboundAttachmentCiphertextWorkflow,
  processInboundAttachmentUploadWorkflow,
} from "./inbound-attachment-workflows.js";
import { runInboundAttachmentMaintenance } from "./inbound-attachment-maintenance.js";
import { removeInboundAttachmentArtifacts, removeOwnedInboundAttachmentArtifact } from "./inbound-attachment-artifacts.js";
import { inboundAttachmentUploadReadiness } from "./inbound-attachment-readiness.js";
import { inboundAttachmentProcessingLeaseIsStale } from "./inbound-attachment-stale-lease.js";
import { inboundAttachmentUploadState, publicInboundAttachmentUploadSession } from "./inbound-attachment-session-projection.js";
import { runtimeProcessIdentity, runtimeProcessIdentityAlive } from "./runtime-lease-lock.js";
import { withInboundAttachmentMutationLock } from "./inbound-attachment-store-lock.js";
import {
  inboundAttachmentCiphertextPath,
  inboundAttachmentLeaseDirectory,
  inboundAttachmentReleasePath,
  inboundAttachmentStagingPath,
  inboundAttachmentWorkerHandoffPath,
} from "./inbound-attachment-files.js";

const storeVersion = 2;
const terminalStates = new Set(["ready", "claiming", "claimed", "rejected", "cancelled", "expired"]);
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
  "inbound_upload_worker_verdict_binding_invalid",
  "inbound_upload_worker_verdict_invalid",
  "inbound_upload_worker_verdict_stale",
  "inbound_upload_worker_verdict_untrusted",
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
  if ([
    "inbound_upload_scanner_unavailable",
    "inbound_upload_superseded",
    "restart_reconciliation_required",
    "inbound_upload_worker_unavailable",
    "inbound_upload_worker_timeout",
    "inbound_upload_worker_not_ready",
    "inbound_upload_worker_storage_invalid",
    "inbound_upload_worker_sandbox_unavailable",
  ].includes(code)) {
    return { state: "retryable", error: stableError(code, "inbound_upload_scanner_unavailable") };
  }
  if (["thread_not_found", "thread_access_forbidden", "inbound_upload_tenant_mismatch", "inbound_upload_permission_recheck_failed"].includes(code)) {
    return { state: "cancelled", error: "inbound_upload_permission_recheck_failed" };
  }
  if (["inbound_upload_descriptor_invalid", "inbound_upload_descriptor_expired"].includes(code)) {
    return { state: "rejected", error: stableError(code) };
  }
  if ([
    "inbound_upload_worker_verdict_binding_invalid",
    "inbound_upload_worker_verdict_invalid",
    "inbound_upload_worker_verdict_stale",
    "inbound_upload_worker_verdict_untrusted",
  ].includes(code)) {
    return { state: "rejected", error: stableError(code) };
  }
  if (code.includes("ciphertext") || code.includes("decrypt") || code.includes("age")) {
    return { state: "rejected", error: "inbound_upload_ciphertext_invalid" };
  }
  if (code === "inbound_upload_key_unavailable") return { state: "rejected", error: code };
  return { state: "rejected", error: "inbound_upload_processing_failed" };
}

function activeForQuota(session) {
  return ["ready", "claiming"].includes(session.state) || !terminalStates.has(clean(session.state));
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
    inboundAttachmentWorkerHandoffPath(session, token, env),
    inboundAttachmentReleasePath(session, token, env),
  ];
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
  if (expired?.releasePath) await removeInboundAttachmentArtifacts([expired.releasePath], env);
  return expired?.session || null;
}

export async function inboundAttachmentUploadStatus({ threadId, principal, env = process.env } = {}) {
  return inboundAttachmentUploadReadiness({ threadId, principal, env }, { requireThread, policyFor: inboundAttachmentUploadPolicy, workerHealth: inboundAttachmentWorkerHealth });
}

export async function createInboundAttachmentUploadSessions({ threadId, files = [], principal, env = process.env } = {}) {
  return createInboundAttachmentUploadSessionsWorkflow({ threadId, files, principal, env }, {
    requireUploadReady: requireInboundAttachmentUploadReady,
    requireThread,
    resourceOwnerUserId,
    ensureKey: ensureInboundAttachmentKey,
    keyById: inboundAttachmentKeyById,
    recipientDescriptor: inboundAttachmentRecipientDescriptor,
    mutateStore,
    quotaUsage,
    activeSessionCount,
    sessionCiphertextLimit,
    safeIdempotencyKey,
    fail,
    nowIso,
    recordMetric,
    publicSession: publicInboundAttachmentUploadSession,
  });
}

export async function ingestInboundAttachmentCiphertext({ sessionId, principal, input, env = process.env } = {}) {
  return ingestInboundAttachmentCiphertextWorkflow({ sessionId, principal, input, env }, {
    authorizedSession,
    isReceivingExpired,
    transitionExpiredSession,
    fail,
    mutateStore,
    quotaUsage,
    policyFor: inboundAttachmentUploadPolicy,
    nowIso,
    recordMetric,
    publicSession: publicInboundAttachmentUploadSession,
  });
}

async function claimProcessing(sessionId, principal, policy, env) {
  await authorizedSession(sessionId, principal, env);
  const identity = await runtimeProcessIdentity();
  const token = randomUUID();
  const claimed = await mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session) throw fail("inbound_upload_session_not_found", 404);
    if (["ready", "claimed"].includes(session.state)) return { changed: false, value: { session, owned: false, artifacts: [] } };
    const artifacts = [];
    if (processingStates.has(session.state)) {
      if (!await inboundAttachmentProcessingLeaseIsStale(session, { isProcessingLeaseExpired, runtimeProcessIdentityAlive })) return { changed: false, value: { session, owned: false, artifacts } };
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
  await removeInboundAttachmentArtifacts(claimed.artifacts, env);
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
    // Both API-decrypted transport and isolated-worker uploads share the
    // same atomic key-revocation and ownership fence before publication.
    if (!key || !["active", "retired"].includes(key.status)) throw fail("inbound_upload_key_unavailable", 409);
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
      scannedAt: policy.transportOnly ? null : nowIso(),
      expiresAt: new Date(Date.now() + policy.plaintextLeaseMs).toISOString(),
    };
    delete current.processingToken;
    delete current.processingLease;
    current.updatedAt = nowIso();
    try {
      await writeStore(store, env);
    } catch (error) {
      await removeOwnedInboundAttachmentArtifact(destination, path.join(dataPaths(env).home, "uploads"));
      throw error;
    }
    return current;
  });
}

export async function processInboundAttachmentUpload({ sessionId, principal, env = process.env, scanner } = {}) {
  return processInboundAttachmentUploadWorkflow({ sessionId, principal, env, scanner }, {
    policyFor: inboundAttachmentUploadPolicy,
    fail,
    claimProcessing,
    keyById: inboundAttachmentKeyById,
    verifyDescriptor: verifyInboundAttachmentRecipientDescriptor,
    assertSessionAuthority,
    setScanning,
    renewProcessingLease,
    completeProcessing,
    publishStagedAttachment,
    failureState,
    removeArtifacts: removeInboundAttachmentArtifacts,
    recordMetric,
    publicSession: publicInboundAttachmentUploadSession,
  });
}

export async function inboundAttachmentUploadSession({ sessionId, principal, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (isReceivingExpired(session)) return publicInboundAttachmentUploadSession(await transitionExpiredSession(session.id, env));
  if (isReleaseExpired(session)) {
    const expired = await expireReadySession(session.id, env);
    return publicInboundAttachmentUploadSession(expired || (await authorizedSession(sessionId, principal, env)).session);
  }
  return publicInboundAttachmentUploadSession(session);
}

export async function cancelInboundAttachmentUpload({ sessionId, principal, env = process.env } = {}) {
  return cancelInboundAttachmentUploadWorkflow({ sessionId, principal, env }, {
    authorizedSession, mutateStore, publicSession: publicInboundAttachmentUploadSession,
    nowIso, removeArtifacts: removeInboundAttachmentArtifacts, recordMetric,
  });
}

export { authorizedSession as resolveInboundAttachmentSession };

async function runInboundAttachmentSweep(env = process.env, startup = false) {
  return runInboundAttachmentMaintenance({ env, startup }, {
    policyFor: inboundAttachmentUploadPolicy,
    mutateStore,
    isReceivingExpired,
    processingStates,
    isProcessingLeaseExpired,
    staleProcessingLease: (session) => inboundAttachmentProcessingLeaseIsStale(session, { isProcessingLeaseExpired, runtimeProcessIdentityAlive }),
    leaseArtifactPaths,
    isReleaseExpired,
    clean,
    nowIso,
    removeArtifacts: removeInboundAttachmentArtifacts,
    removeOwnedArtifact: removeOwnedInboundAttachmentArtifact,
  });
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
