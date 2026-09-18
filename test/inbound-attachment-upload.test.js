import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import * as age from "age-encryption";
import { startServer } from "../apps/server/src/server.js";
import { startInboundAttachmentWorker } from "../scripts/orkestr-inbound-attachment-worker.mjs";
import { dataPaths } from "../packages/storage/src/paths.js";
import { createInboundAttachmentPayloadStream } from "../packages/core/src/browser-inbound-attachment-payload.js";
import {
  cancelInboundAttachmentUpload,
  createInboundAttachmentUploadSessions,
  inboundAttachmentUploadSession,
  inboundAttachmentUploadStatus,
  ingestInboundAttachmentCiphertext,
  processInboundAttachmentUpload,
  reconcileInboundAttachmentQuarantine,
  sweepInboundAttachmentQuarantine,
} from "../packages/core/src/inbound-attachment-quarantine.js";
import { inboundAttachmentKeyStatus, revokeInboundAttachmentKey, rotateInboundAttachmentKey } from "../packages/core/src/inbound-attachment-keys.js";
import {
  inboundAttachmentCiphertextPath,
  inboundAttachmentFileDigest,
  inboundAttachmentLeaseDirectory,
  inboundAttachmentReleasePath,
  inboundAttachmentWorkerHandoffPath,
} from "../packages/core/src/inbound-attachment-files.js";
import { signInboundAttachmentWorkerRequest, verifyInboundAttachmentWorkerResponse } from "../packages/core/src/inbound-attachment-worker-contract.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";
import { createThread, updateThread } from "../packages/core/src/threads.js";

function runtimeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "tenant-a",
    ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED: "1",
    ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "1",
    ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND: process.execPath,
    ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS: JSON.stringify(["-e", "process.exit(0)", "{file}"]),
    ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION: "1",
    ORKESTR_TEST_STORAGE_BOOTSTRAPPED: "1",
    ...extra,
  };
}

function principal(userId) {
  return { kind: "user", role: "user", userId, source: "test", displayName: userId };
}

async function referenceWorkerEnv(home) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const root = path.join(home, "uploads", "inbound-quarantine");
  const workerHome = path.join(home, "isolated-worker");
  const signingKey = path.join(workerHome, "verdict-private.pem");
  const verdictPublicKey = path.join(home, "worker-verdict-public.pem");
  const env = runtimeEnv(home, {
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(workerHome, "run", "worker.sock"),
    ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN: "worker-test-token-abcdefghijklmnopqrstuvwxyz-0123456789",
    ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_PUBLIC_KEY_FILE: verdictPublicKey,
    ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT: path.join(root, "ciphertext"),
    ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT: path.join(root, "handoff"),
    ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY: path.join(workerHome, "keys.json"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE: signingKey,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT: path.join(workerHome, "scratch"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND: process.execPath,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS: JSON.stringify(["-e", "process.exit(0)", "{file}"]),
    ORKESTR_INBOUND_UPLOAD_WORKER_TEST_MODE: "1",
  });
  delete env.ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION;
  await Promise.all([
    fs.mkdir(env.ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT, { recursive: true, mode: 0o700 }),
    fs.mkdir(env.ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT, { recursive: true, mode: 0o710 }),
    fs.mkdir(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(env.ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET), { recursive: true, mode: 0o750 }),
  ]);
  await fs.writeFile(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await fs.writeFile(verdictPublicKey, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  return env;
}

function runInboundChild(source, env, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      env: { ...process.env, INBOUND_ATTACHMENT_TEST_ENV: JSON.stringify(env), NODE_TEST_CONTEXT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exit ${code}: ${stderr || stdout}`));
    });
  });
}

function rawWorkerRequest(socketPath, request) {
  const body = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const client = http.request({
      method: "POST",
      socketPath,
      path: request.pathname,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    client.once("error", reject);
    client.end(body);
  });
}

function binaryStream(bytes, chunkSize = 5) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function encryptedPayload(session, content, metadata = {}) {
  const bytes = Buffer.from(content);
  const file = {
    name: metadata.name || "private-report.pdf",
    type: metadata.type || "application/pdf",
    size: bytes.byteLength,
    stream: () => binaryStream(bytes),
  };
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(session.recipient);
  const encrypted = await encrypter.encrypt(createInboundAttachmentPayloadStream(file, {
    descriptor: metadata.descriptor || session.descriptor,
  }));
  return Buffer.from(await new Response(encrypted).arrayBuffer());
}

async function createSession(home, { owner = "tenant-a", threadId = "inbound-thread", idempotencyKey = "inbound-test-file-0001", size = 18 } = {}) {
  const env = runtimeEnv(home);
  await createThread({ id: threadId, name: threadId, ownerUserId: owner }, env);
  const result = await createInboundAttachmentUploadSessions({
    threadId,
    principal: principal(owner),
    files: [{ idempotencyKey, plaintextSize: size }],
    env,
  });
  return { env, threadId, session: result.sessions[0], actor: principal(owner) };
}

test("inbound encrypted upload quarantines ciphertext, scans a bounded lease, and releases only after approval", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-upload-"));
  const content = "tenant-confidential";
  const { env, session, actor } = await createSession(home, { size: Buffer.byteLength(content) });
  assert.equal(session.descriptor?.version, 1);
  assert.equal(session.descriptor?.purpose, "inbound_attachment_upload");
  assert.equal(JSON.stringify(session).includes("AGE-SECRET-KEY"), false);
  const ciphertext = await encryptedPayload(session, content, { name: "board-notes.pdf" });
  assert.equal(ciphertext.includes(Buffer.from("board-notes.pdf")), false);
  assert.equal(ciphertext.includes(Buffer.from(content)), false);

  const quarantined = await ingestInboundAttachmentCiphertext({
    sessionId: session.id,
    principal: actor,
    input: Readable.from([ciphertext]),
    env,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.attachment, null);
  const storedCiphertext = await fs.readFile(inboundAttachmentCiphertextPath({ ...session, ownerUserId: "tenant-a" }, env));
  assert.deepEqual(storedCiphertext, ciphertext);

  let scannerPath = "";
  const ready = await processInboundAttachmentUpload({
    sessionId: session.id,
    principal: actor,
    env,
    scanner: async ({ filePath }) => {
    scannerPath = filePath;
    assert.equal(await fs.readFile(filePath, "utf8"), content);
    assert.equal((await inboundAttachmentUploadSession({ sessionId: session.id, principal: actor, env })).state, "scanning");
    return { verdict: "clean" };
    },
  });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.attachment.filename, "board-notes.pdf");
  assert.equal(await fs.readFile(ready.attachment.path, "utf8"), content);
  assert.equal(Boolean(await fs.stat(scannerPath).catch(() => null)), false);
  assert.match(ready.attachment.path, /uploads[\\/]inbound-thread[\\/]inbound[\\/]/);
  assert.equal((await inboundAttachmentUploadSession({ sessionId: session.id, principal: actor, env })).state, "ready");
});

test("cancelling during a live scan fences late publication and removes plaintext", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-cancel-"));
  const content = "cancel during scan";
  const { env, session, actor } = await createSession(home, { size: Buffer.byteLength(content) });
  const ciphertext = await encryptedPayload(session, content);
  await ingestInboundAttachmentCiphertext({ sessionId: session.id, principal: actor, input: Readable.from([ciphertext]), env });
  let scannerPath;
  await assert.rejects(processInboundAttachmentUpload({ sessionId: session.id, principal: actor, env, scanner: async ({filePath}) => {
    scannerPath = filePath;
    assert.equal((await cancelInboundAttachmentUpload({sessionId:session.id, principal:actor, env})).state,"cancelled");
    return {verdict:"clean"};
  }}), /superseded/);
  assert.equal((await inboundAttachmentUploadSession({sessionId:session.id,principal:actor,env})).state,"cancelled");
  await assert.rejects(fs.stat(scannerPath),/ENOENT/);
});

test("inbound upload rejects tampering, keeps scanner outages quarantined, and exposes only bounded telemetry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-reject-"));
  resetObservabilityForTests();
  const content = "untrusted-content";
  const { env, session, actor } = await createSession(home, { size: Buffer.byteLength(content) });
  const ciphertext = await encryptedPayload(session, content);
  ciphertext[ciphertext.length - 1] ^= 0x01;
  await ingestInboundAttachmentCiphertext({ sessionId: session.id, principal: actor, input: Readable.from([ciphertext]), env });
  const rejected = await processInboundAttachmentUpload({ sessionId: session.id, principal: actor, env, scanner: async () => ({ verdict: "clean" }) });
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.attachment, null);

  const retry = await createSession(home, { threadId: "retry-thread", idempotencyKey: "inbound-test-file-0002", size: Buffer.byteLength(content) });
  await ingestInboundAttachmentCiphertext({ sessionId: retry.session.id, principal: retry.actor, input: Readable.from([await encryptedPayload(retry.session, content)]), env: retry.env });
  const retryable = await processInboundAttachmentUpload({
    sessionId: retry.session.id,
    principal: retry.actor,
    env: retry.env,
    scanner: async () => ({ retryable: true, reason: "scanner_offline" }),
  });
  assert.equal(retryable.state, "retryable", JSON.stringify(retryable));
  assert.equal(retryable.attachment, null);
  const scannerRejected = await processInboundAttachmentUpload({
    sessionId: retry.session.id,
    principal: retry.actor,
    env: { ...retry.env, ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS: JSON.stringify(["-e", "process.exit(10)", "{file}"]) },
  });
  assert.equal(scannerRejected.state, "rejected");
  const metrics = renderOpenMetrics();
  assert.match(metrics, /orkestr_inbound_attachment_upload_transitions_total\{state="rejected",outcome="rejected"\} 2/);
  assert.match(metrics, /orkestr_inbound_attachment_upload_transitions_total\{state="retryable",outcome="retryable"\} 1/);
  assert.equal(metrics.includes("board-notes.pdf"), false);
  assert.equal(metrics.includes("tenant-a"), false);
});

test("inbound recipient capabilities reject altered metadata before scanner access", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-descriptor-"));
  const content = "descriptor-bound-content";
  const { env, session, actor } = await createSession(home, { size: Buffer.byteLength(content) });
  const ciphertext = await encryptedPayload(session, content, {
    descriptor: { ...session.descriptor, purpose: "other_upload_purpose" },
  });
  await ingestInboundAttachmentCiphertext({ sessionId: session.id, principal: actor, input: Readable.from([ciphertext]), env });
  let scannerCalled = false;
  const rejected = await processInboundAttachmentUpload({
    sessionId: session.id,
    principal: actor,
    env,
    scanner: async () => { scannerCalled = true; return true; },
  });
  assert.equal(rejected.state, "rejected");
  assert.equal(scannerCalled, false);
});

test("inbound session idempotency, tenant isolation, key rotation, and restart reconciliation fail closed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-lifecycle-"));
  const content = "rotation-content";
  const first = await createSession(home, { size: Buffer.byteLength(content) });
  const duplicate = await createInboundAttachmentUploadSessions({
    threadId: first.threadId,
    principal: first.actor,
    files: [{ idempotencyKey: "inbound-test-file-0001", plaintextSize: Buffer.byteLength(content) }],
    env: first.env,
  });
  assert.equal(duplicate.sessions[0].id, first.session.id);
  await createThread({ id: "other-tenant-thread", name: "other", ownerUserId: "tenant-b" }, first.env);
  await assert.rejects(
    inboundAttachmentUploadSession({ sessionId: first.session.id, principal: principal("tenant-b"), env: first.env }),
    /thread_access_forbidden/,
  );

  const originalCiphertext = await encryptedPayload(first.session, content);
  const firstStored = await ingestInboundAttachmentCiphertext({ sessionId: first.session.id, principal: first.actor, input: Readable.from([originalCiphertext]), env: first.env });
  const replay = await ingestInboundAttachmentCiphertext({ sessionId: first.session.id, principal: first.actor, input: Readable.from([originalCiphertext]), env: first.env });
  assert.equal(replay.state, "quarantined");
  assert.equal(replay.id, firstStored.id);
  await assert.rejects(
    ingestInboundAttachmentCiphertext({ sessionId: first.session.id, principal: first.actor, input: Readable.from([Buffer.from("different")]), env: first.env }),
    /inbound_upload_idempotency_conflict/,
  );

  const rotated = await rotateInboundAttachmentKey("tenant-a", first.env);
  const later = await createSession(home, { threadId: "rotated-thread", idempotencyKey: "inbound-test-file-0003", size: Buffer.byteLength(content) });
  assert.notEqual(later.session.keyId, first.session.keyId);
  assert.equal(later.session.keyVersion, rotated.version);
  const released = await processInboundAttachmentUpload({ sessionId: first.session.id, principal: first.actor, env: first.env, scanner: async () => true });
  assert.equal(released.state, "ready");
  const publicKeys = await inboundAttachmentKeyStatus("tenant-a", first.env);
  assert.equal(publicKeys.some((key) => Object.hasOwn(key, "identity")), false);
  const laterCiphertext = await encryptedPayload(later.session, content);
  await ingestInboundAttachmentCiphertext({ sessionId: later.session.id, principal: later.actor, input: Readable.from([laterCiphertext]), env: first.env });
  await revokeInboundAttachmentKey("tenant-a", later.session.keyId, first.env);
  const revoked = await processInboundAttachmentUpload({ sessionId: later.session.id, principal: later.actor, env: first.env, scanner: async () => true });
  assert.equal(revoked.state, "rejected");

  const storePath = dataPaths(first.env).inboundAttachmentUploads;
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  const releasedRecord = store.sessions.find((item) => item.id === first.session.id);
  const releasedPath = releasedRecord.release.path;
  releasedRecord.release.expiresAt = new Date(0).toISOString();
  const stale = store.sessions.find((item) => item.id === later.session.id);
  stale.state = "validating";
  stale.processingToken = "stale-processing-token-000000000001";
  stale.processingLease = {
    token: stale.processingToken,
    pid: 999999,
    processStartIdentity: "linux:0",
    expiresAt: new Date(0).toISOString(),
  };
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  const leaseDir = inboundAttachmentLeaseDirectory(stale, stale.processingToken, first.env);
  const staleRelease = inboundAttachmentReleasePath(stale, stale.processingToken, first.env);
  const successorRelease = inboundAttachmentReleasePath(stale, "successor-processing-token-00000000001", first.env);
  await fs.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(leaseDir, "payload"), "stale", { mode: 0o600 });
  await fs.mkdir(path.dirname(staleRelease), { recursive: true, mode: 0o700 });
  await fs.writeFile(staleRelease, "stale", { mode: 0o600 });
  await fs.writeFile(successorRelease, "successor", { mode: 0o600 });
  const reconciled = await reconcileInboundAttachmentQuarantine(first.env);
  assert.equal(reconciled.retryable >= 1, true);
  assert.equal(reconciled.removedPlaintext >= 1, true);
  assert.equal(Boolean(await fs.stat(leaseDir).catch(() => null)), false);
  assert.equal(Boolean(await fs.stat(staleRelease).catch(() => null)), false);
  assert.equal(await fs.readFile(successorRelease, "utf8"), "successor");
  assert.equal(Boolean(await fs.stat(releasedPath).catch(() => null)), false);
  const recovered = await inboundAttachmentUploadSession({ sessionId: later.session.id, principal: later.actor, env: first.env });
  assert.equal(recovered.state, "retryable");
  await cancelInboundAttachmentUpload({ sessionId: later.session.id, principal: later.actor, env: first.env });
  await assert.rejects(
    ingestInboundAttachmentCiphertext({ sessionId: later.session.id, principal: later.actor, input: Readable.from([laterCiphertext]), env: first.env }),
    /inbound_upload_session_not_receiving/,
  );
});

test("periodic sweep preserves a slow live scanner beyond its lease expiry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-live-lease-"));
  const content = "slow-live-scan";
  const { env, session, actor } = await createSession(home, {
    size: Buffer.byteLength(content),
  });
  await ingestInboundAttachmentCiphertext({
    sessionId: session.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(session, content)]),
    env,
  });
  let entered;
  let continueScan;
  const scanning = new Promise((resolve) => { entered = resolve; });
  const releaseScanner = new Promise((resolve) => { continueScan = resolve; });
  const processing = processInboundAttachmentUpload({
    sessionId: session.id,
    principal: actor,
    env,
    scanner: async ({ filePath }) => {
      entered(filePath);
      await releaseScanner;
      return true;
    },
  });
  const scannerPath = await scanning;
  const storePath = dataPaths(env).inboundAttachmentUploads;
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  const record = store.sessions.find((item) => item.id === session.id);
  record.processingLease.expiresAt = new Date(0).toISOString();
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  const swept = await sweepInboundAttachmentQuarantine(env);
  assert.equal(swept.removedPlaintext, 0);
  assert.equal((await inboundAttachmentUploadSession({ sessionId: session.id, principal: actor, env })).state, "scanning");
  assert.equal(await fs.readFile(scannerPath, "utf8"), content);
  continueScan();
  assert.equal((await processing).state, "ready");
});

test("publication rechecks revocation and projects stable errors without leaving a release", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-revoke-publish-"));
  const content = "must-not-release";
  const { env, session, actor, threadId } = await createSession(home, {
    size: Buffer.byteLength(content),
  });
  await ingestInboundAttachmentCiphertext({
    sessionId: session.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(session, content)]),
    env,
  });
  const rejected = await processInboundAttachmentUpload({
    sessionId: session.id,
    principal: actor,
    env,
    scanner: async () => {
      await revokeInboundAttachmentKey("tenant-a", session.keyId, env);
      return { verdict: "clean" };
    },
  });
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.error, "inbound_upload_key_unavailable");
  const inbound = path.join(home, "uploads", threadId, "inbound");
  assert.deepEqual(await fs.readdir(inbound).catch(() => []), []);

  const retry = await createSession(home, {
    threadId: "stable-error-thread",
    idempotencyKey: "inbound-stable-error-0001",
    size: Buffer.byteLength(content),
  });
  await ingestInboundAttachmentCiphertext({
    sessionId: retry.session.id,
    principal: retry.actor,
    input: Readable.from([await encryptedPayload(retry.session, content)]),
    env: retry.env,
  });
  const stable = await processInboundAttachmentUpload({
    sessionId: retry.session.id,
    principal: retry.actor,
    env: retry.env,
    scanner: async () => { throw new Error("/private/host/path must never project"); },
  });
  assert.equal(stable.state, "rejected");
  assert.equal(stable.error, "inbound_upload_processing_failed");
  assert.equal(JSON.stringify(stable).includes("/private/host/path"), false);

  const ownership = await createSession(home, {
    threadId: "owner-recheck-thread",
    idempotencyKey: "inbound-owner-recheck-0001",
    size: Buffer.byteLength(content),
  });
  await ingestInboundAttachmentCiphertext({
    sessionId: ownership.session.id,
    principal: ownership.actor,
    input: Readable.from([await encryptedPayload(ownership.session, content)]),
    env: ownership.env,
  });
  const ownerChanged = await processInboundAttachmentUpload({
    sessionId: ownership.session.id,
    principal: ownership.actor,
    env: ownership.env,
    scanner: async () => {
      await updateThread(ownership.threadId, { ownerUserId: "tenant-b" }, ownership.env);
      return true;
    },
  });
  assert.equal(ownerChanged.state, "cancelled");
  assert.equal(ownerChanged.error, "inbound_upload_permission_recheck_failed");
  assert.deepEqual(await fs.readdir(path.join(home, "uploads", ownership.threadId, "inbound")).catch(() => []), []);
});

test("inbound quota, terminal retention, stale partial cleanup, and synchronous ready expiry are bounded", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-quota-"));
  const env = runtimeEnv(home, {
    ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_PER_OWNER: "1",
    ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_GLOBAL: "1",
  });
  const actor = principal("tenant-a");
  await createThread({ id: "quota-thread", name: "quota", ownerUserId: "tenant-a" }, env);
  await assert.rejects(createInboundAttachmentUploadSessions({
    threadId: "quota-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-zero-size-0001", plaintextSize: 0 }],
    env,
  }), /inbound_upload_descriptor_invalid/);
  const first = await createInboundAttachmentUploadSessions({
    threadId: "quota-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-quota-file-0001", plaintextSize: 4 }],
    env,
  });
  await assert.rejects(createInboundAttachmentUploadSessions({
    threadId: "quota-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-quota-file-0002", plaintextSize: 4 }],
    env,
  }), /inbound_upload_quota_exceeded/);
  const session = first.sessions[0];
  const ciphertextPath = inboundAttachmentCiphertextPath({ ...session, ownerUserId: "tenant-a" }, env);
  await fs.mkdir(path.dirname(ciphertextPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(ciphertextPath, "retained-ciphertext", { mode: 0o600 });
  const temporaryPath = `${ciphertextPath}.crashed.tmp`;
  await fs.writeFile(temporaryPath, "partial", { mode: 0o600 });
  await fs.utimes(temporaryPath, new Date(0), new Date(0));
  const storePath = dataPaths(env).inboundAttachmentUploads;
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  const record = store.sessions.find((item) => item.id === session.id);
  record.state = "rejected";
  record.updatedAt = new Date(0).toISOString();
  record.error = "inbound_upload_processing_failed";
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  const swept = await sweepInboundAttachmentQuarantine(env);
  assert.equal(swept.removedTemporaryCiphertext, 1);
  assert.equal(Boolean(await fs.stat(ciphertextPath).catch(() => null)), false);
  assert.equal(Boolean(await fs.stat(temporaryPath).catch(() => null)), false);

  const ready = await createSession(home, {
    threadId: "ready-expiry-thread",
    idempotencyKey: "inbound-ready-expiry-0001",
    size: 5,
  });
  await ingestInboundAttachmentCiphertext({
    sessionId: ready.session.id,
    principal: ready.actor,
    input: Readable.from([await encryptedPayload(ready.session, "ready")]),
    env: ready.env,
  });
  const published = await processInboundAttachmentUpload({
    sessionId: ready.session.id,
    principal: ready.actor,
    env: ready.env,
    scanner: async () => true,
  });
  const readyStore = JSON.parse(await fs.readFile(dataPaths(ready.env).inboundAttachmentUploads, "utf8"));
  readyStore.sessions.find((item) => item.id === ready.session.id).release.expiresAt = new Date(0).toISOString();
  await fs.writeFile(dataPaths(ready.env).inboundAttachmentUploads, `${JSON.stringify(readyStore)}\n`, { mode: 0o600 });
  const expired = await inboundAttachmentUploadSession({ sessionId: ready.session.id, principal: ready.actor, env: ready.env });
  assert.equal(expired.state, "expired");
  assert.equal(Boolean(await fs.stat(published.attachment.path).catch(() => null)), false);
});

test("production remains blocked without an isolation contract and intake pause preserves required mode", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-policy-"));
  const production = runtimeEnv(home);
  delete production.ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION;
  delete production.ORKESTR_TEST_STORAGE_BOOTSTRAPPED;
  const actor = principal("tenant-a");
  await createThread({ id: "policy-thread", name: "policy", ownerUserId: "tenant-a" }, production);
  const blocked = await inboundAttachmentUploadStatus({ threadId: "policy-thread", principal: actor, env: production });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, "inbound_upload_isolation_contract_required");
  await assert.rejects(createInboundAttachmentUploadSessions({
    threadId: "policy-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-blocked-0001", plaintextSize: 1 }],
    env: production,
  }), /inbound_upload_isolation_contract_required/);

  const paused = { ...runtimeEnv(home), ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1", ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED: "1" };
  const pausedStatus = await inboundAttachmentUploadStatus({ threadId: "policy-thread", principal: actor, env: paused });
  assert.equal(pausedStatus.ready, false);
  assert.equal(pausedStatus.required, true);
  assert.equal(pausedStatus.reason, "inbound_upload_intake_paused");
});

test("sessions and key rotations serialize across independent processes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-cross-process-"));
  const env = runtimeEnv(home);
  await createThread({ id: "cross-process-thread", name: "cross", ownerUserId: "tenant-a" }, env);
  const quarantineUrl = new URL("../packages/core/src/inbound-attachment-quarantine.js", import.meta.url).href;
  const keysUrl = new URL("../packages/core/src/inbound-attachment-keys.js", import.meta.url).href;
  const source = `
    import { createInboundAttachmentUploadSessions } from ${JSON.stringify(quarantineUrl)};
    import { rotateInboundAttachmentKey } from ${JSON.stringify(keysUrl)};
    const env = JSON.parse(process.env.INBOUND_ATTACHMENT_TEST_ENV);
    Object.assign(process.env, env);
    const principal = { kind: "user", role: "user", userId: "tenant-a", source: "test", displayName: "tenant-a" };
    if (process.argv[1] === "rotate") {
      await rotateInboundAttachmentKey("tenant-a", env);
    } else {
      await createInboundAttachmentUploadSessions({
        threadId: "cross-process-thread",
        principal,
        files: [{ idempotencyKey: process.argv[2], plaintextSize: 8 }],
        env,
      });
    }
  `;
  await Promise.all([
    runInboundChild(source, env, "create", "inbound-cross-process-0001"),
    runInboundChild(source, env, "create", "inbound-cross-process-0002"),
    runInboundChild(source, env, "create", "inbound-cross-process-0003"),
    runInboundChild(source, env, "rotate"),
  ]);
  const store = JSON.parse(await fs.readFile(dataPaths(env).inboundAttachmentUploads, "utf8"));
  assert.equal(store.sessions.length, 3);
  assert.equal(new Set(store.sessions.map((session) => session.idempotencyKey)).size, 3);
  const keys = await inboundAttachmentKeyStatus("tenant-a", env);
  assert.equal(keys.filter((key) => key.status === "active").length, 1);
  assert.equal(keys.length >= 1, true);
});

test("isolated worker owns private identities and only releases a signed exact handoff", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-"));
  const env = await referenceWorkerEnv(home);
  let worker = await startInboundAttachmentWorker(env);
  t.after(async () => { await new Promise((resolve) => worker.close(resolve)); });
  const content = "isolated-worker-content";
  const actor = principal("tenant-a");
  await createThread({ id: "isolated-worker-thread", name: "isolated worker", ownerUserId: "tenant-a" }, env);
  const status = await inboundAttachmentUploadStatus({ threadId: "isolated-worker-thread", principal: actor, env });
  assert.equal(status.ready, true);
  const created = await createInboundAttachmentUploadSessions({
    threadId: "isolated-worker-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-isolated-worker-0001", plaintextSize: Buffer.byteLength(content) }],
    env,
  });
  const session = created.sessions[0];
  const apiRegistry = await fs.readFile(dataPaths(env).inboundAttachmentKeys, "utf8");
  const workerRegistry = await fs.readFile(env.ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY, "utf8");
  assert.equal(apiRegistry.includes("AGE-SECRET-KEY"), false);
  assert.equal(workerRegistry.includes("AGE-SECRET-KEY"), true);
  await ingestInboundAttachmentCiphertext({
    sessionId: session.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(session, content)]),
    env,
  });
  const ready = await processInboundAttachmentUpload({ sessionId: session.id, principal: actor, env });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(await fs.readFile(ready.attachment.path, "utf8"), content);

  const staleScratch = path.join(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, "a".repeat(24), "inbound-stale-job-1234567890-abcdef0123456789", "payload");
  const sentinel = path.join(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, "operator-sentinel");
  await fs.mkdir(path.dirname(staleScratch), { recursive: true, mode: 0o700 });
  await fs.writeFile(staleScratch, "stale", { mode: 0o600 });
  await fs.writeFile(sentinel, "preserve", { mode: 0o600 });
  await new Promise((resolve) => worker.close(resolve));
  worker = await startInboundAttachmentWorker(env);
  assert.equal(Boolean(await fs.stat(staleScratch).catch(() => null)), false);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  const recovered = await inboundAttachmentUploadStatus({ threadId: "isolated-worker-thread", principal: actor, env });
  assert.equal(recovered.ready, true);

  const liveScratch = path.join(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, "b".repeat(24), "inbound-live-job-1234567890-abcdef0123456789", "payload");
  await fs.mkdir(path.dirname(liveScratch), { recursive: true, mode: 0o700 });
  await fs.writeFile(liveScratch, "live", { mode: 0o600 });
  const secondSocketEnv = {
    ...env,
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(home, "isolated-worker", "run", "second-worker.sock"),
  };
  const workerScriptUrl = new URL("../scripts/orkestr-inbound-attachment-worker.mjs", import.meta.url).href;
  const secondWorkerSource = `
    import { startInboundAttachmentWorker } from ${JSON.stringify(workerScriptUrl)};
    const env = JSON.parse(process.env.INBOUND_ATTACHMENT_TEST_ENV);
    await startInboundAttachmentWorker(env);
  `;
  await assert.rejects(runInboundChild(secondWorkerSource, secondSocketEnv), /runtime_lease_store_locked/);
  assert.equal(await fs.readFile(liveScratch, "utf8"), "live");

  const invalidSocket = path.join(home, "isolated-worker", "run", "invalid-worker.sock");
  const invalidConfigEnv = {
    ...env,
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: invalidSocket,
    ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE: path.join(home, "isolated-worker", "missing-private-key.pem"),
  };
  const invalidSentinel = path.join(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, "invalid-config-sentinel");
  await fs.writeFile(invalidSentinel, "preserve", { mode: 0o600 });
  await assert.rejects(startInboundAttachmentWorker(invalidConfigEnv), /inbound_upload_worker_private_file_invalid/);
  assert.equal(await fs.readFile(invalidSentinel, "utf8"), "preserve");
  assert.equal(Boolean(await fs.lstat(invalidSocket).catch(() => null)), false);

  await new Promise((resolve) => worker.close(resolve));
  const blockedSocketRoot = path.join(home, "isolated-worker", "blocked-socket-root");
  const retryEnv = { ...env, ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(blockedSocketRoot, "worker.sock") };
  await fs.writeFile(blockedSocketRoot, "not-a-directory", { mode: 0o600 });
  await assert.rejects(startInboundAttachmentWorker(retryEnv), /inbound_upload_worker_socket_root_invalid/);
  assert.equal(Boolean(await fs.stat(path.join(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT, ".worker-root.lock")).catch(() => null)), false);
  await fs.rm(blockedSocketRoot);
  await fs.mkdir(blockedSocketRoot, { mode: 0o750 });
  worker = await startInboundAttachmentWorker(retryEnv);
  await new Promise((resolve) => worker.close(resolve));

  const unavailable = await inboundAttachmentUploadStatus({ threadId: "isolated-worker-thread", principal: actor, env });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.reason, "inbound_upload_worker_unavailable");
  env.ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS = JSON.stringify(["-e", "setTimeout(() => process.exit(0), 200)", "{file}"]);
  worker = await startInboundAttachmentWorker(env);

  const duplicateCreated = await createInboundAttachmentUploadSessions({
    threadId: "isolated-worker-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-isolated-worker-duplicate-scan", plaintextSize: Buffer.byteLength(content) }],
    env,
  });
  const duplicateSession = duplicateCreated.sessions[0];
  await ingestInboundAttachmentCiphertext({
    sessionId: duplicateSession.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(duplicateSession, content)]),
    env,
  });
  const duplicateStoredSession = JSON.parse(await fs.readFile(dataPaths(env).inboundAttachmentUploads, "utf8")).sessions
    .find((candidate) => candidate.id === duplicateSession.id);
  assert.ok(duplicateStoredSession);
  const duplicateCiphertext = await inboundAttachmentFileDigest(inboundAttachmentCiphertextPath(duplicateStoredSession, env));
  const duplicateToken = "raw-duplicate-scan-token-1234567890";
  const duplicatePayload = {
    sessionId: duplicateStoredSession.id,
    ownerUserId: duplicateStoredSession.ownerUserId,
    threadId: duplicateStoredSession.threadId,
    keyId: duplicateStoredSession.keyId,
    keyVersion: duplicateStoredSession.keyVersion,
    processingToken: duplicateToken,
    ciphertextChecksum: duplicateCiphertext.checksum,
    ciphertextSize: duplicateCiphertext.size,
    plaintextSize: duplicateStoredSession.plaintextSize,
    maxPlaintextBytes: 1024 * 1024,
  };
  const duplicateRequests = ["raw-duplicate-scan-nonce-000001", "raw-duplicate-scan-nonce-000002"].map((nonce) => signInboundAttachmentWorkerRequest({
    pathname: "/v1/scan",
    issuedAt: new Date().toISOString(),
    nonce,
    payload: duplicatePayload,
  }, env.ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN));
  const duplicateResults = await Promise.all(duplicateRequests.map((request) => rawWorkerRequest(env.ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET, request)));
  assert.deepEqual(duplicateResults.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(duplicateResults.every((result) => verifyInboundAttachmentWorkerResponse(result.body, env.ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN)), true);
  assert.equal(duplicateResults.find((result) => result.statusCode === 409)?.body?.result?.error, "inbound_upload_worker_scan_in_flight");
  await fs.rm(inboundAttachmentWorkerHandoffPath(duplicateStoredSession, duplicateToken, env), { force: true });

  const revocationCreated = await createInboundAttachmentUploadSessions({
    threadId: "isolated-worker-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-isolated-worker-revocation", plaintextSize: Buffer.byteLength(content) }],
    env,
  });
  const revocationSession = revocationCreated.sessions[0];
  await ingestInboundAttachmentCiphertext({
    sessionId: revocationSession.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(revocationSession, content)]),
    env,
  });
  const processing = processInboundAttachmentUpload({ sessionId: revocationSession.id, principal: actor, env });
  let scanning = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    scanning = await inboundAttachmentUploadSession({ sessionId: revocationSession.id, principal: actor, env });
    if (scanning.state === "scanning") break;
  }
  assert.equal(scanning?.state, "scanning");
  await revokeInboundAttachmentKey("tenant-a", revocationSession.keyId, env);
  const revokedWhileScanning = await processing;
  assert.equal(revokedWhileScanning.state, "rejected", JSON.stringify(revokedWhileScanning));
  assert.equal(revokedWhileScanning.error, "inbound_upload_key_unavailable");
  assert.equal(revokedWhileScanning.attachment, null);

  const invalidSigner = generateKeyPairSync("ed25519");
  await fs.writeFile(env.ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_PUBLIC_KEY_FILE, invalidSigner.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  const rejectedCreated = await createInboundAttachmentUploadSessions({
    threadId: "isolated-worker-thread",
    principal: actor,
    files: [{ idempotencyKey: "inbound-isolated-worker-bad-verdict", plaintextSize: Buffer.byteLength(content) }],
    env,
  });
  const rejectedSession = rejectedCreated.sessions[0];
  await ingestInboundAttachmentCiphertext({
    sessionId: rejectedSession.id,
    principal: actor,
    input: Readable.from([await encryptedPayload(rejectedSession, content)]),
    env,
  });
  const rejected = await processInboundAttachmentUpload({ sessionId: rejectedSession.id, principal: actor, env });
  assert.equal(rejected.state, "rejected", JSON.stringify(rejected));
  assert.equal(rejected.error, "inbound_upload_worker_verdict_untrusted");
  assert.equal(Boolean(await fs.stat(inboundAttachmentReleasePath(rejectedSession, undefined, env)).catch(() => null)), false);
  const rejectedStore = JSON.parse(await fs.readFile(dataPaths(env).inboundAttachmentUploads, "utf8"));
  const persistedRejectedSession = rejectedStore.sessions.find((candidate) => candidate.id === rejectedSession.id);
  assert.equal(Boolean(await fs.stat(inboundAttachmentCiphertextPath(persistedRejectedSession, env)).catch(() => null)), true);
});

test("HTTP ingress accepts age ciphertext and rejects plaintext uploads when required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-api-"));
  const prior = Object.fromEntries([
    "ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART",
    "ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED", "ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED", "ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED",
    "ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND", "ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS", "ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION",
    "ORKESTR_TEST_STORAGE_BOOTSTRAPPED", "ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED", "ORKESTR_HOST_BOUNDARIES",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, runtimeEnv(home, {
    ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_HOST_BOUNDARIES: "0",
  }));
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const content = "http-bound-content";
    await createThread({ id: "http-inbound-thread", name: "HTTP inbound", ownerUserId: "tenant-a" }, process.env);
    const createdResponse = await fetch(`${baseUrl}/attachment-encryption/inbound/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "http-inbound-thread", files: [{ idempotencyKey: "inbound-http-file-0001", plaintextSize: Buffer.byteLength(content) }] }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const session = created.sessions[0];
    const keysResponse = await fetch(`${baseUrl}/attachment-encryption/inbound/keys`);
    assert.equal(keysResponse.status, 200);
    const keys = await keysResponse.json();
    assert.equal(keys.keys.some((key) => Object.hasOwn(key, "identity")), false);
    const rotateResponse = await fetch(`${baseUrl}/attachment-encryption/inbound/keys/rotate`, { method: "POST" });
    assert.equal(rotateResponse.status, 201);
    assert.notEqual((await rotateResponse.json()).key.id, session.keyId);
    const ciphertext = await encryptedPayload(session, content, { name: "api.pdf" });
    const upload = await fetch(`${baseUrl}/attachment-encryption/inbound/sessions/${encodeURIComponent(session.id)}/ciphertext`, {
      method: "PUT",
      headers: { "content-type": "application/age" },
      body: ciphertext,
    });
    assert.equal(upload.status, 201);
    const processed = await fetch(`${baseUrl}/attachment-encryption/inbound/sessions/${encodeURIComponent(session.id)}/process`, { method: "POST" });
    assert.equal(processed.status, 201);
    const complete = await processed.json();
    assert.equal(complete.session.state, "ready");
    process.env.ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED = "1";
    const pausedStatus = await fetch(`${baseUrl}/attachment-encryption/inbound/status?threadId=http-inbound-thread`);
    assert.equal((await pausedStatus.json()).reason, "inbound_upload_intake_paused");
    const pausedCreate = await fetch(`${baseUrl}/attachment-encryption/inbound/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "http-inbound-thread", files: [{ idempotencyKey: "inbound-http-paused-0001", plaintextSize: 1 }] }),
    });
    assert.equal(pausedCreate.status, 503);
    const plaintext = new FormData();
    plaintext.append("files", new Blob(["plain"], { type: "text/plain" }), "plain.txt");
    const rejected = await fetch(`${baseUrl}/threads/http-inbound-thread/uploads`, { method: "POST", body: plaintext });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await fs.readdir(path.join(home, "uploads", "http-inbound-thread")), ["inbound"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
