import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as age from "age-encryption";
import { appendEvent } from "../../storage/src/store.js";
import { writeInboundAttachmentPayload } from "./inbound-attachment-payload.js";
import { recordWatcherAlert } from "./watcher-alerts.js";
import { scanInboundAttachment } from "./inbound-attachment-scanner.js";
import {
  requestInboundAttachmentWorkerScan,
  requireInboundAttachmentWorkerReady,
  verifyInboundAttachmentWorkerCleanVerdict,
} from "./inbound-attachment-worker-client.js";
import {
  inboundAttachmentCiphertextPath,
  inboundAttachmentFileDigest,
  inboundAttachmentLeaseDirectory,
  inboundAttachmentReleasePath,
  inboundAttachmentStagingPath,
  inboundAttachmentWorkerHandoffPath,
  writeInboundAttachmentCiphertext,
} from "./inbound-attachment-files.js";

function clean(value = "") {
  return String(value || "").trim();
}

function startLeaseHeartbeat(sessionId, token, policy, renewProcessingLease, env) {
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

async function completeScannerOutcome({ session, token, verdict, startedAt, env, completeProcessing, recordMetric, publicSession }) {
  const state = verdict?.retryable ? "retryable" : "rejected";
  const error = verdict?.retryable ? "inbound_upload_scanner_unavailable" : "inbound_upload_scanner_rejected";
  const completed = await completeProcessing(session.id, token, { state, error }, env);
  recordMetric(state, state, Date.now() - startedAt);
  if (state === "retryable") {
    await recordWatcherAlert({
      source: "inbound_attachment_upload",
      code: "scanner_unavailable",
      severity: "warning",
      message: "Inbound encrypted attachment remains quarantined because its isolated scanner did not return a clean verdict.",
      details: { state },
    }, env).catch(() => {});
  }
  return publicSession(completed);
}

async function processIsolatedWorkerClaim({
  session, token, principal, policy, startedAt, env, fail, keyById,
  verifyDescriptor, assertSessionAuthority, setScanning, renewProcessingLease,
  publishStagedAttachment, completeProcessing, recordMetric, publicSession,
}) {
  const key = await keyById(session.ownerUserId, session.keyId, env);
  if (!key || !["active", "retired"].includes(key.status)) throw fail("inbound_upload_key_unavailable", 409);
  const cipherPath = inboundAttachmentCiphertextPath(session, env);
  const stat = await fsp.stat(cipherPath).catch(() => null);
  if (!stat?.isFile() || stat.size !== Number(session.ciphertext?.size || 0)) throw fail("inbound_upload_ciphertext_missing", 409);
  const ciphertext = await inboundAttachmentFileDigest(cipherPath);
  if (clean(ciphertext.checksum) !== clean(session.ciphertext?.checksum)) throw fail("inbound_upload_ciphertext_tampered", 409);
  await assertSessionAuthority(session, principal, env);
  await setScanning(session.id, token, policy, env);
  const workerResult = await requestInboundAttachmentWorkerScan({
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    threadId: session.threadId,
    keyId: session.keyId,
    keyVersion: session.keyVersion,
    processingToken: token,
    ciphertextChecksum: ciphertext.checksum,
    ciphertextSize: ciphertext.size,
    plaintextSize: session.plaintextSize,
    maxPlaintextBytes: policy.maxFileBytes,
  }, env);
  if (workerResult?.verdict !== "clean") {
    return completeScannerOutcome({ session, token, verdict: workerResult, startedAt, env, completeProcessing, recordMetric, publicSession });
  }
  const verdict = await verifyInboundAttachmentWorkerCleanVerdict(workerResult, {
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    threadId: session.threadId,
    keyId: session.keyId,
    keyVersion: session.keyVersion,
    processingToken: token,
    ciphertextChecksum: ciphertext.checksum,
    ciphertextSize: ciphertext.size,
  }, env);
  const currentKey = await keyById(session.ownerUserId, session.keyId, env);
  if (!currentKey || !["active", "retired"].includes(currentKey.status)) throw fail("inbound_upload_key_unavailable", 409);
  await verifyDescriptor(verdict.descriptor, session, currentKey, policy, env);
  await assertSessionAuthority(session, principal, env);
  await renewProcessingLease(session.id, token, policy, env);
  const handoffPath = inboundAttachmentWorkerHandoffPath(session, token, env);
  const handoff = await inboundAttachmentFileDigest(handoffPath).catch(() => null);
  if (!handoff || handoff.size !== Number(verdict.plaintextSize) || clean(handoff.checksum) !== clean(verdict.plaintextChecksum)) {
    throw fail("inbound_upload_worker_verdict_binding_invalid", 409);
  }
  const stagePath = inboundAttachmentStagingPath(session, token, env);
  await fsp.mkdir(path.dirname(stagePath), { recursive: true, mode: 0o700 });
  await fsp.rename(handoffPath, stagePath);
  await fsp.chmod(stagePath, 0o600);
  const destination = inboundAttachmentReleasePath(session, token, env);
  const completed = await publishStagedAttachment({
    session,
    token,
    decoded: { filename: verdict.filename, mimetype: verdict.mimetype, size: verdict.plaintextSize, checksum: verdict.plaintextChecksum },
    principal,
    policy,
    stagePath,
    destination,
    env,
  });
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
  return publicSession(completed);
}

export async function createInboundAttachmentUploadSessionsWorkflow({ threadId, files = [], principal, env }, {
  requireUploadReady, requireThread, resourceOwnerUserId, ensureKey, keyById,
  recipientDescriptor, mutateStore, quotaUsage, activeSessionCount,
  sessionCiphertextLimit, safeIdempotencyKey, fail, nowIso, recordMetric,
  publicSession,
}) {
  const policy = requireUploadReady(env);
  if (!policy.testIsolation) await requireInboundAttachmentWorkerReady(env);
  const thread = await requireThread(threadId, principal, env);
  if (!Array.isArray(files) || !files.length || files.length > policy.maxFiles) throw fail("inbound_upload_files_invalid", 400);
  const ownerUserId = clean(resourceOwnerUserId(thread, env));
  const key = await ensureKey(ownerUserId, env);
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
      if (!idempotencyKey || !Number.isSafeInteger(plaintextSize) || plaintextSize < 1 || plaintextSize > policy.maxFileBytes) throw fail("inbound_upload_descriptor_invalid", 400);
      const existing = store.sessions.find((session) => clean(session.ownerUserId) === ownerUserId && clean(session.threadId) === thread.id && clean(session.idempotencyKey) === idempotencyKey);
      if (existing) {
        if (Number(existing.plaintextSize) !== plaintextSize) throw fail("inbound_upload_idempotency_conflict", 409);
        result.push(existing);
        continue;
      }
      const ciphertextReservation = sessionCiphertextLimit(plaintextSize, policy);
      if (ownerCount >= policy.maxSessionsPerOwner || globalCount >= policy.maxSessionsGlobal || ownerReserved + ciphertextReservation > policy.maxOwnerQuarantineBytes || globalReserved + ciphertextReservation > policy.maxQuarantineBytes) {
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
  await Promise.all(sessions.map((session) => appendEvent({ type: "inbound_attachment_session_created", threadId: session.threadId, ownerUserId: session.ownerUserId, keyVersion: session.keyVersion, state: session.state }, env).catch(() => {})));
  const descriptors = new Map(await Promise.all(sessions.map(async (session) => {
    const sessionKey = await keyById(ownerUserId, session.keyId, env);
    return [session.id, await recipientDescriptor(session, sessionKey, policy, env)];
  })));
  return {
    threadId: thread.id,
    sessions: sessions.map((session) => ({ ...publicSession(session), recipient: clean(descriptors.get(session.id)?.recipient), descriptor: descriptors.get(session.id) || null, purpose: "inbound_attachment_upload" })),
  };
}

export async function ingestInboundAttachmentCiphertextWorkflow({ sessionId, principal, input, env }, {
  authorizedSession, isReceivingExpired, transitionExpiredSession, fail,
  mutateStore, quotaUsage, policyFor, nowIso, recordMetric, publicSession,
}) {
  const { session } = await authorizedSession(sessionId, principal, env);
  if (isReceivingExpired(session)) {
    await transitionExpiredSession(session.id, env);
    throw fail("inbound_upload_session_expired", 410);
  }
  if (session.state !== "receiving" && !(session.state === "quarantined" && session.ciphertext)) throw fail("inbound_upload_session_not_receiving", 409);
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
        if (Number(current.ciphertext.size) !== ciphertext.size || clean(current.ciphertext.checksum) !== ciphertext.checksum) throw fail("inbound_upload_idempotency_conflict", 409);
        return { changed: false, value: { session: current, duplicate: true } };
      }
      if (current.state !== "receiving") throw fail("inbound_upload_session_not_receiving", 409);
      const remaining = store.sessions.filter((item) => clean(item.id) !== clean(current.id));
      const policy = policyFor(env);
      if (quotaUsage(remaining, current.ownerUserId) + ciphertext.size > policy.maxOwnerQuarantineBytes || quotaUsage(remaining) + ciphertext.size > policy.maxQuarantineBytes) throw fail("inbound_upload_quota_exceeded", 413);
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
  await appendEvent({ type: "inbound_attachment_ciphertext_quarantined", threadId: stored.session.threadId, ownerUserId: stored.session.ownerUserId, ciphertextSize: stored.session.ciphertext?.size || 0, state: stored.session.state }, env).catch(() => {});
  return publicSession(stored.session);
}

export async function processInboundAttachmentUploadWorkflow({ sessionId, principal, env, scanner }, {
  policyFor, fail, claimProcessing, keyById, verifyDescriptor, assertSessionAuthority,
  setScanning, renewProcessingLease, completeProcessing, publishStagedAttachment,
  failureState, removeArtifacts, recordMetric, publicSession,
}) {
  const policy = policyFor(env);
  if (!policy.ready || (typeof scanner === "function" && !policy.testIsolation)) throw fail(policy.reason || "inbound_upload_not_ready", 503);
  if (!policy.testIsolation) await requireInboundAttachmentWorkerReady(env);
  const claim = await claimProcessing(sessionId, principal, policy, env);
  if (!claim.owned) return publicSession(claim.session);
  const session = claim.session;
  const token = session.processingToken;
  const startedAt = Date.now();
  const leaseDir = inboundAttachmentLeaseDirectory(session, token, env);
  const plaintextPath = path.join(leaseDir, "payload");
  const stagePath = inboundAttachmentStagingPath(session, token, env);
  const destination = inboundAttachmentReleasePath(session, token, env);
  const stopHeartbeat = startLeaseHeartbeat(session.id, token, policy, renewProcessingLease, env);
  let published = false;
  try {
    if (!policy.testIsolation) {
      const completed = await processIsolatedWorkerClaim({ session, token, principal, policy, startedAt, env, fail, keyById, verifyDescriptor, assertSessionAuthority, setScanning, renewProcessingLease, completeProcessing, publishStagedAttachment, recordMetric, publicSession });
      published = completed.state === "ready";
      return completed;
    }
    const key = await keyById(session.ownerUserId, session.keyId, env);
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
    const decoded = await writeInboundAttachmentPayload(plaintext, { destinationPath: plaintextPath, sessionId: session.id, keyId: session.keyId, plaintextSize: session.plaintextSize, maxPlaintextBytes: policy.maxFileBytes });
    await verifyDescriptor(decoded.descriptor, session, key, policy, env);
    await assertSessionAuthority(session, principal, env);
    await setScanning(session.id, token, policy, env);
    const verdict = await scanInboundAttachment(plaintextPath, policy, scanner);
    if (!verdict.approved) return completeScannerOutcome({ session, token, verdict, startedAt, env, completeProcessing, recordMetric, publicSession });
    await renewProcessingLease(session.id, token, policy, env);
    await fsp.mkdir(path.dirname(stagePath), { recursive: true, mode: 0o700 });
    await fsp.rename(plaintextPath, stagePath);
    await fsp.chmod(stagePath, 0o600);
    const completed = await publishStagedAttachment({ session, token, decoded, principal, policy, stagePath, destination, env });
    published = true;
    await fsp.rm(cipherPath, { force: true }).catch(() => {});
    recordMetric("ready", "ready", Date.now() - startedAt);
    await appendEvent({ type: "inbound_attachment_scan_approved", threadId: completed.threadId, ownerUserId: completed.ownerUserId, state: completed.state, plaintextSize: completed.release.size, keyVersion: completed.keyVersion }, env).catch(() => {});
    return publicSession(completed);
  } catch (error) {
    const next = failureState(error);
    const completed = await completeProcessing(session.id, token, { state: next.state, error: next.error }, env).catch(() => null);
    recordMetric(next.state, next.state, Date.now() - startedAt);
    if (next.state === "retryable") {
      await recordWatcherAlert({ source: "inbound_attachment_upload", code: "inbound_attachment_processing_retryable", severity: "warning", message: "Inbound encrypted attachment remains quarantined pending a retryable processing failure.", details: { state: next.state } }, env).catch(() => {});
    }
    if (completed) return publicSession(completed);
    throw fail("inbound_upload_superseded", 409);
  } finally {
    stopHeartbeat();
    await removeArtifacts([leaseDir, stagePath, inboundAttachmentWorkerHandoffPath(session, token, env), ...(published ? [] : [destination])], env);
  }
}
