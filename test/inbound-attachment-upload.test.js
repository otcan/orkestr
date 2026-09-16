import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import * as age from "age-encryption";
import { startServer } from "../apps/server/src/server.js";
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
} from "../packages/core/src/inbound-attachment-quarantine.js";
import { inboundAttachmentKeyStatus, revokeInboundAttachmentKey, rotateInboundAttachmentKey } from "../packages/core/src/inbound-attachment-keys.js";
import { inboundAttachmentCiphertextPath } from "../packages/core/src/inbound-attachment-files.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";
import { createThread } from "../packages/core/src/threads.js";

function runtimeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "tenant-a",
    ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED: "1",
    ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "1",
    ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND: process.execPath,
    ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS: JSON.stringify(["-e", "process.exit(0)", "{file}"]),
    ...extra,
  };
}

function principal(userId) {
  return { kind: "user", role: "user", userId, source: "test", displayName: userId };
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
    assert.equal((await cancelInboundAttachmentUpload({ sessionId: session.id, principal: actor, env })).state, "scanning");
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
  stale.processingToken = "interrupted";
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  const orphan = path.join(dataPaths(first.env).home, "uploads", "inbound-quarantine", "plaintext", "orphan", "payload");
  await fs.mkdir(path.dirname(orphan), { recursive: true, mode: 0o700 });
  await fs.writeFile(orphan, "must disappear", { mode: 0o600 });
  const reconciled = await reconcileInboundAttachmentQuarantine(first.env);
  assert.equal(reconciled.retryable >= 1, true);
  assert.equal(reconciled.removedPlaintext >= 1, true);
  assert.equal(Boolean(await fs.stat(orphan).catch(() => null)), false);
  assert.equal(Boolean(await fs.stat(releasedPath).catch(() => null)), false);
  const recovered = await inboundAttachmentUploadSession({ sessionId: later.session.id, principal: later.actor, env: first.env });
  assert.equal(recovered.state, "retryable");
  await cancelInboundAttachmentUpload({ sessionId: later.session.id, principal: later.actor, env: first.env });
  await assert.rejects(
    ingestInboundAttachmentCiphertext({ sessionId: later.session.id, principal: later.actor, input: Readable.from([laterCiphertext]), env: first.env }),
    /inbound_upload_session_not_receiving/,
  );
});

test("HTTP ingress accepts age ciphertext and rejects plaintext uploads when required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-api-"));
  const prior = Object.fromEntries([
    "ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART",
    "ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED", "ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED", "ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED",
    "ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND", "ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS", "ORKESTR_HOST_BOUNDARIES",
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
