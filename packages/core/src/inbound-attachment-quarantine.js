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
import {
  inboundAttachmentCiphertextPath,
  inboundAttachmentFileDigest,
  inboundAttachmentQuarantineRoot,
  inboundAttachmentReleasePath,
  writeInboundAttachmentCiphertext,
} from "./inbound-attachment-files.js";

const storeVersion = 1;
const mutationQueues = new Map();
const terminalStates = new Set(["ready", "rejected", "cancelled", "expired"]);

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeSessionId(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(id) ? id : "";
}

function safeIdempotencyKey(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{8,160}$/.test(id) ? id : "";
}

function fail(message, statusCode = 409) {
  const error = new Error(message);
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

function enqueueMutation(env, operation) {
  const key = dataPaths(env).inboundAttachmentUploads;
  const previous = mutationQueues.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.catch(() => {});
  mutationQueues.set(key, settled);
  return next.finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
}

async function mutateStore(env, operation) {
  return enqueueMutation(env, async () => {
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
  if (durationMs !== null) {
    observeHistogram("orkestr_inbound_attachment_scan_duration_seconds", Math.max(0, Number(durationMs) || 0) / 1000, labels);
  }
}

async function requireThread(threadId, principal, env = process.env) {
  const thread = await getThreadForPrincipal(clean(threadId), principal, env);
  if (!thread) throw fail("thread_not_found", 404);
  assertThreadOperational(thread);
  return thread;
}

async function authorizedSession(sessionId, principal, env = process.env) {
  const id = safeSessionId(sessionId);
  if (!id) throw fail("inbound_upload_session_invalid", 400);
  const session = (await readStore(env)).sessions.find((item) => clean(item.id) === id);
  if (!session) throw fail("inbound_upload_session_not_found", 404);
  const thread = await requireThread(session.threadId, principal, env);
  if (clean(resourceOwnerUserId(thread, env)) !== clean(session.ownerUserId)) throw fail("inbound_upload_tenant_mismatch", 403);
  return { session, thread };
}

function sessionExpired(session) {
  return session.state === "receiving" && Number.isFinite(Date.parse(clean(session.expiresAt))) && Date.parse(clean(session.expiresAt)) <= Date.now();
}

async function transitionExpiredSession(sessionId, env = process.env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !sessionExpired(session)) return { changed: false, value: session || null };
    session.state = "expired";
    session.error = "upload_session_expired";
    session.updatedAt = nowIso();
    recordMetric("expired", "expired");
    return { changed: true, value: session };
  });
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
    let reservedBytes = store.sessions
      .filter((session) => clean(session.ownerUserId) === ownerUserId && !["cancelled", "expired", "rejected"].includes(clean(session.state)))
      .reduce((sum, session) => sum + Math.max(0, Number(session.plaintextSize || 0)), 0);
    for (const input of files) {
      const idempotencyKey = safeIdempotencyKey(input?.idempotencyKey || input?.id);
      const plaintextSize = Number(input?.plaintextSize ?? input?.size);
      if (!idempotencyKey || !Number.isSafeInteger(plaintextSize) || plaintextSize < 0 || plaintextSize > policy.maxFileBytes) {
        throw fail("inbound_upload_descriptor_invalid", 400);
      }
      const existing = store.sessions.find((session) =>
        clean(session.ownerUserId) === ownerUserId && clean(session.threadId) === thread.id && clean(session.idempotencyKey) === idempotencyKey);
      if (existing) {
        if (Number(existing.plaintextSize) !== plaintextSize) throw fail("inbound_upload_idempotency_conflict", 409);
        result.push(existing);
        continue;
      }
      if (reservedBytes + plaintextSize > policy.maxQuarantineBytes) throw fail("inbound_upload_quota_exceeded", 413);
      const createdAt = nowIso();
      const session = {
        id: `inbound-${randomUUID()}`,
        ownerUserId,
        threadId: thread.id,
        idempotencyKey,
        keyId: key.id,
        keyVersion: key.version,
        plaintextSize,
        maxCiphertextBytes: policy.maxFileBytes + 256 * 1024,
        state: "receiving",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(Date.now() + policy.sessionTtlMs).toISOString(),
        error: "",
      };
      store.sessions.push(session);
      reservedBytes += plaintextSize;
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
  if (sessionExpired(session)) {
    await transitionExpiredSession(session.id, env);
    throw fail("inbound_upload_session_expired", 410);
  }
  if (terminalStates.has(session.state) || session.state === "validating") throw fail("inbound_upload_session_not_receiving", 409);
  if (!input || typeof input[Symbol.asyncIterator] !== "function") throw fail("inbound_upload_ciphertext_required", 400);
  const finalPath = inboundAttachmentCiphertextPath(session, env);
  const ciphertext = await writeInboundAttachmentCiphertext(input, finalPath, Number(session.maxCiphertextBytes || 0));
  const stored = await enqueueMutation(env, async () => {
    const store = await readStore(env);
    const current = store.sessions.find((item) => clean(item.id) === session.id);
    if (!current) throw fail("inbound_upload_session_not_found", 404);
    if (sessionExpired(current)) {
      current.state = "expired";
      current.error = "upload_session_expired";
      current.updatedAt = nowIso();
      await writeStore(store, env);
      throw fail("inbound_upload_session_expired", 410);
    }
    if (terminalStates.has(current.state) || current.state === "validating" || current.state === "scanning") {
      throw fail("inbound_upload_session_not_receiving", 409);
    }
    if (current.ciphertext) {
      await fsp.rm(ciphertext.temporaryPath, { force: true }).catch(() => {});
      if (Number(current.ciphertext.size) !== ciphertext.size || clean(current.ciphertext.checksum) !== ciphertext.checksum) {
        throw fail("inbound_upload_idempotency_conflict", 409);
      }
      return current;
    }
    await fsp.rename(ciphertext.temporaryPath, finalPath);
    current.ciphertext = { size: ciphertext.size, checksum: ciphertext.checksum, storedAt: nowIso() };
    current.state = "quarantined";
    current.error = "";
    current.updatedAt = nowIso();
    await writeStore(store, env);
    recordMetric("quarantined", "accepted");
    return current;
  }).catch(async (error) => {
    await fsp.rm(ciphertext.temporaryPath, { force: true }).catch(() => {});
    throw error;
  });
  await appendEvent({
    type: "inbound_attachment_ciphertext_quarantined",
    threadId: stored.threadId,
    ownerUserId: stored.ownerUserId,
    ciphertextSize: stored.ciphertext?.size || 0,
    state: stored.state,
  }, env).catch(() => {});
  return publicInboundAttachmentUploadSession(stored);
}

async function setProcessingState(sessionId, principal, env) {
  await authorizedSession(sessionId, principal, env);
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session) throw fail("inbound_upload_session_not_found", 404);
    if (session.state === "ready") return { changed: false, value: { session, owned: false } };
    if (session.state === "validating" || session.state === "scanning") return { changed: false, value: { session, owned: false } };
    if (session.state !== "quarantined" && session.state !== "retryable") throw fail("inbound_upload_session_not_quarantined", 409);
    if (!session.ciphertext) throw fail("inbound_upload_ciphertext_missing", 409);
    session.state = "validating";
    session.error = "";
    session.processingToken = randomUUID();
    session.updatedAt = nowIso();
    return { changed: true, value: { session: { ...session }, owned: true } };
  });
}

async function setScanning(sessionId, token, env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || session.state !== "validating" || clean(session.processingToken) !== clean(token)) {
      throw fail("inbound_upload_processing_superseded", 409);
    }
    session.state = "scanning";
    session.updatedAt = nowIso();
    return { changed: true, value: session };
  });
}

async function completeProcessing(sessionId, token, patch, env) {
  return mutateStore(env, async (store) => {
    const session = store.sessions.find((item) => clean(item.id) === clean(sessionId));
    if (!session || !["validating", "scanning"].includes(session.state) || clean(session.processingToken) !== clean(token)) {
      throw fail("inbound_upload_processing_superseded", 409);
    }
    Object.assign(session, patch, { updatedAt: nowIso() });
    delete session.processingToken;
    return { changed: true, value: session };
  });
}

function failureState(error) {
  const reason = clean(error?.message || error);
  if (reason.includes("scanner") || reason.includes("restart")) return { state: "retryable", reason: reason || "scanner_unavailable" };
  if (reason.includes("forbidden") || reason.includes("thread_not_found") || reason.includes("tenant_mismatch")) return { state: "cancelled", reason: "permission_recheck_failed" };
  return { state: "rejected", reason: reason || "inbound_upload_rejected" };
}

export async function processInboundAttachmentUpload({ sessionId, principal, env = process.env, scanner } = {}) {
  const policy = inboundAttachmentUploadPolicy(env);
  if (!policy.ready && typeof scanner !== "function") throw fail(policy.reason || "inbound_upload_not_ready", 503);
  const claim = await setProcessingState(sessionId, principal, env);
  if (!claim.owned) return publicInboundAttachmentUploadSession(claim.session);
  const session = claim.session;
  const startedAt = Date.now();
  let leaseDir = "";
  try {
    const key = await inboundAttachmentKeyById(session.ownerUserId, session.keyId, env);
    if (!key || key.status === "revoked" || !clean(key.identity)) throw fail("inbound_upload_key_unavailable", 409);
    const cipherPath = inboundAttachmentCiphertextPath(session, env);
    const stat = await fsp.stat(cipherPath).catch(() => null);
    if (!stat?.isFile() || stat.size !== Number(session.ciphertext?.size || 0)) throw fail("inbound_upload_ciphertext_missing", 409);
    const ciphertextDigest = await inboundAttachmentFileDigest(cipherPath);
    if (clean(ciphertextDigest.checksum) !== clean(session.ciphertext?.checksum)) throw fail("inbound_upload_ciphertext_tampered", 409);
    const root = path.join(inboundAttachmentQuarantineRoot(env), "plaintext");
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    leaseDir = await fsp.mkdtemp(path.join(root, `${safeSessionId(session.id)}.`));
    await fsp.chmod(leaseDir, 0o700);
    const plaintextPath = path.join(leaseDir, "payload");
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(key.identity);
    const encrypted = Readable.toWeb(createReadStream(cipherPath));
    const plaintext = await decrypter.decrypt(encrypted);
    const decoded = await writeInboundAttachmentPayload(plaintext, {
      destinationPath: plaintextPath,
      sessionId: session.id,
      keyId: session.keyId,
      plaintextSize: session.plaintextSize,
      maxPlaintextBytes: policy.maxFileBytes,
    });
    await verifyInboundAttachmentRecipientDescriptor(decoded.descriptor, session, key, policy, env);
    // Permission and lifecycle are checked after decrypt and again after scan;
    // an authenticated session is not authority to hand data to an agent later.
    await requireThread(session.threadId, principal, env);
    await setScanning(session.id, session.processingToken, env);
    const verdict = await scanInboundAttachment(plaintextPath, policy, scanner);
    if (!verdict.approved) {
      const state = verdict.retryable ? "retryable" : "rejected";
      const completed = await completeProcessing(session.id, session.processingToken, { state, error: verdict.reason || "scanner_rejected" }, env);
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
    await requireThread(session.threadId, principal, env);
    const destination = inboundAttachmentReleasePath(session, env);
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.rename(plaintextPath, destination);
    await fsp.chmod(destination, 0o600);
    const completed = await completeProcessing(session.id, session.processingToken, {
      state: "ready",
      error: "",
      release: {
        attachmentId: `inbound-attachment-${randomUUID()}`,
        path: destination,
        filename: decoded.filename,
        mimetype: decoded.mimetype,
        size: decoded.size,
        checksum: decoded.checksum,
        scannedAt: nowIso(),
        expiresAt: new Date(Date.now() + policy.plaintextLeaseMs).toISOString(),
      },
    }, env);
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
    const completed = await completeProcessing(session.id, session.processingToken, { state: next.state, error: next.reason }, env).catch(() => null);
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
    throw error;
  } finally {
    if (leaseDir) await fsp.rm(leaseDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inboundAttachmentUploadSession({ sessionId, principal, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (sessionExpired(session)) return publicInboundAttachmentUploadSession(await transitionExpiredSession(session.id, env));
  return publicInboundAttachmentUploadSession(session);
}

export async function cancelInboundAttachmentUpload({ sessionId, principal, env = process.env } = {}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (terminalStates.has(session.state)) return publicInboundAttachmentUploadSession(session);
  if (["validating", "scanning"].includes(session.state)) return publicInboundAttachmentUploadSession(session);
  const cancelled = await mutateStore(env, async (store) => {
    const current = store.sessions.find((item) => clean(item.id) === session.id);
    if (!current || terminalStates.has(current.state)) return { changed: false, value: current || session };
    current.state = "cancelled";
    current.error = "cancelled_by_user";
    current.updatedAt = nowIso();
    return { changed: true, value: current };
  });
  await fsp.rm(inboundAttachmentCiphertextPath(cancelled, env), { force: true }).catch(() => {});
  recordMetric("cancelled", "cancelled");
  return publicInboundAttachmentUploadSession(cancelled);
}

export async function reconcileInboundAttachmentQuarantine(env = process.env) {
  const root = inboundAttachmentQuarantineRoot(env);
  await fsp.rm(path.join(root, "plaintext"), { recursive: true, force: true }).catch(() => {});
  const store = await mutateStore(env, async (current) => {
    let changed = false;
    const now = Date.now();
    const expiredReleases = [];
    for (const session of current.sessions) {
      if (session.state === "validating" || session.state === "scanning") {
        session.state = "retryable";
        session.error = "restart_reconciliation_required";
        session.updatedAt = nowIso();
        changed = true;
      }
      if (sessionExpired(session)) {
        session.state = "expired";
        session.error = "upload_session_expired";
        session.updatedAt = nowIso();
        changed = true;
      }
      const releaseExpiry = Date.parse(clean(session.release?.expiresAt));
      if (session.state === "ready" && (!Number.isFinite(releaseExpiry) || releaseExpiry <= now)) {
        expiredReleases.push(clean(session.release?.path));
        session.state = "expired";
        session.error = "plaintext_lease_expired";
        session.updatedAt = nowIso();
        changed = true;
      }
    }
    return { changed, value: { sessions: current.sessions, expiredReleases } };
  });
  for (const target of store.expiredReleases) {
    const expectedRoot = path.join(dataPaths(env).home, "uploads");
    if (target && path.resolve(target).startsWith(`${path.resolve(expectedRoot)}${path.sep}`)) {
      await fsp.rm(target, { force: true }).catch(() => {});
    }
  }
  return {
    retryable: store.sessions.filter((session) => session.state === "retryable").length,
    expired: store.sessions.filter((session) => session.state === "expired").length,
    removedPlaintext: store.expiredReleases.length,
  };
}
