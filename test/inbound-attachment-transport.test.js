import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import * as age from "age-encryption";
import { createThread } from "../packages/core/src/threads.js";
import { inboundAttachmentUploadPolicy } from "../packages/core/src/inbound-attachment-config.js";
import { createInboundAttachmentPayloadStream } from "../packages/core/src/browser-inbound-attachment-payload.js";
import { createInboundAttachmentUploadSessions, ingestInboundAttachmentCiphertext, processInboundAttachmentUpload, inboundAttachmentUploadStatus } from "../packages/core/src/inbound-attachment-quarantine.js";
import { inboundAttachmentKeyStatus, revokeInboundAttachmentKey } from "../packages/core/src/inbound-attachment-keys.js";
import { startServer } from "../apps/server/src/server.js";

const actor = { kind: "user", role: "user", userId: "transport-owner", source: "test" };
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-transport-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: actor.userId,
    ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1", ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE: "transport" };
  await createThread({id: "transport-thread", name: "Transport test", ownerUserId: actor.userId}, env);
  return {env, home};
}
async function sessionFor(env, size, key = "transport-request-0001") {
  return (await createInboundAttachmentUploadSessions({threadId: "transport-thread", files: [{idempotencyKey: key, plaintextSize: size}], principal: actor, env})).sessions[0];
}
async function encrypt(session, content) {
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(session.recipient);
  const file = { name: "private-name.txt", type: "text/plain", size: content.length,
    stream: () => new Blob([content]).stream() };
  const stream = await encrypter.encrypt(createInboundAttachmentPayloadStream(file, {descriptor: session.descriptor}));
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return {chunks, bytes: Buffer.concat(chunks)};
}

test("transport mode is explicit, production-capable without test flags, and defaults stay isolated", () => {
  const policy = inboundAttachmentUploadPolicy({ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1", ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE: "transport"});
  assert.equal(policy.ready, true);
  assert.equal(policy.testIsolation, false);
  assert.equal(policy.localDecryption, true);
  assert.equal(inboundAttachmentUploadPolicy({ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1"}).ready, false);
  assert.equal(inboundAttachmentUploadPolicy({ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1", ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE: "typo"}).reason, "inbound_upload_processing_mode_invalid");
});

test("browser-encrypted multi-chunk upload releases exact plaintext without claiming a malware scan", async () => {
  const {env} = await fixture();
  const content = Buffer.from("SYNTHETIC-PRIVATE-CONTENT-".repeat(12000));
  const session = await sessionFor(env, content.length);
  const {chunks, bytes} = await encrypt(session, content);
  assert.ok(chunks.length > 3);
  assert.equal(bytes.includes(Buffer.from("SYNTHETIC-PRIVATE-CONTENT")), false);
  assert.equal(bytes.includes(Buffer.from("private-name.txt")), false);
  assert.equal((await inboundAttachmentUploadStatus({threadId: "transport-thread", principal: actor, env})).ready, true);
  await ingestInboundAttachmentCiphertext({sessionId: session.id, principal: actor, input: Readable.from(chunks), env});
  const ready = await processInboundAttachmentUpload({sessionId: session.id, principal: actor, env});
  assert.equal(ready.state, "ready");
  assert.deepEqual(await fs.readFile(ready.attachment.path), content);
  assert.equal(ready.attachment.inboundUpload.scannedAt, "");
  assert.equal(JSON.stringify(await inboundAttachmentKeyStatus(actor.userId, env)).includes("AGE-SECRET-KEY"), false);
  const repeated = await processInboundAttachmentUpload({sessionId: session.id, principal: actor, env});
  assert.equal(repeated.attachment.path, ready.attachment.path);
});

for (const kind of ["tampered", "truncated", "plaintext", "wrong-session", "revoked"]) {
  test(`transport rejects ${kind} without releasing an attachment`, async () => {
    const {env} = await fixture();
    const content = Buffer.from("private-content-".repeat(12000));
    const session = await sessionFor(env, content.length);
    let {bytes} = await encrypt(session, content);
    if (kind === "tampered") bytes[bytes.length - 8] ^= 1;
    if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 25);
    if (kind === "plaintext") bytes = content;
    const target = kind === "wrong-session" ? await sessionFor(env, content.length, "transport-other-session") : session;
    await ingestInboundAttachmentCiphertext({sessionId: target.id, principal: actor, input: Readable.from([bytes]), env});
    if (kind === "revoked") await revokeInboundAttachmentKey(actor.userId, session.keyId, env);
    const result = await processInboundAttachmentUpload({sessionId: target.id, principal: actor, env});
    assert.equal(result.state, "rejected");
    assert.equal(result.attachment, null);
  });
}

test("transport preserves owner authorization and refuses injected scanners outside the test harness", async () => {
  const {env} = await fixture();
  const session = await sessionFor(env, 10);
  await assert.rejects(ingestInboundAttachmentCiphertext({sessionId: session.id, principal: {...actor, userId: "other-owner"}, input: Readable.from([Buffer.alloc(10)]), env}), /forbidden|not_found/);
  await assert.rejects(processInboundAttachmentUpload({sessionId: session.id, principal: actor, env, scanner: async () => true}), /not_ready/);
});

test("production transport HTTP path accepts ciphertext only, blocks legacy upload and fails closed when paused", async () => {
  const {env} = await fixture();
  const overrides = {...env, ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION: "0", ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "0",
    ORKESTR_HOST_BOUNDARIES: "0", ORKESTR_RECOVER_RUNNING_ON_START: "0", ORKESTR_WHATSAPP_AUTOSTART: "0", WHATSAPP_LOCAL_AUTOSTART: "0"};
  const prior = Object.fromEntries([...Object.keys(overrides), "ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED"].map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const server = await startServer({port: 0, host: "127.0.0.1"});
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const content = Buffer.from("HTTP encrypted transport ".repeat(10000));
    const created = await fetch(base + "/attachment-encryption/inbound/sessions", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({threadId: "transport-thread", files: [{idempotencyKey: "http-transport-0001", plaintextSize: content.length}]})});
    assert.equal(created.status, 201);
    const session = (await created.json()).sessions[0];
    const route = base + "/attachment-encryption/inbound/sessions/" + session.id;
    const wrongType = await fetch(route + "/ciphertext", {method: "PUT", headers: {"content-type": "text/plain"}, body: "plaintext"});
    assert.equal(wrongType.status, 415);
    const {bytes} = await encrypt(session, content);
    const upload = await fetch(route + "/ciphertext", {method: "PUT", headers: {"content-type": "application/age"}, body: new Blob([bytes])});
    assert.equal(upload.status, 201);
    const processed = await fetch(route + "/process", {method: "POST"});
    assert.equal(processed.status, 201);
    const ready = (await processed.json()).session;
    assert.equal(ready.state, "ready");
    assert.deepEqual(await fs.readFile(ready.attachment.path), content);
    const form = new FormData();
    form.append("files", new Blob(["plaintext"]), "plain.txt");
    assert.equal((await fetch(base + "/threads/transport-thread/uploads", {method: "POST", body: form})).status, 409);
    process.env.ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED = "1";
    const status = await fetch(base + "/attachment-encryption/inbound/status?threadId=transport-thread");
    assert.equal((await status.json()).ready, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
