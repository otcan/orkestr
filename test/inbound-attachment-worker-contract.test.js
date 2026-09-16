import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  signInboundAttachmentWorkerRequest,
  signInboundAttachmentWorkerResponse,
  signInboundAttachmentWorkerVerdict,
  verifyInboundAttachmentWorkerRequest,
  verifyInboundAttachmentWorkerResponse,
} from "../packages/core/src/inbound-attachment-worker-contract.js";
import { verifyInboundAttachmentWorkerCleanVerdict } from "../packages/core/src/inbound-attachment-worker-client.js";
import { inboundAttachmentWorkerHealth, inboundAttachmentWorkerRuntimeConfig } from "../packages/core/src/inbound-attachment-worker-runtime.js";

const token = "worker-contract-test-token-abcdefghijklmnopqrstuvwxyz-0123456789";

function expectedVerdictFields() {
  return {
    sessionId: "inbound-1234567890abcdef",
    ownerUserId: "tenant-a",
    threadId: "thread-a",
    keyId: "inbound-key-1234567890abcdef",
    keyVersion: 1,
    processingToken: "processing-token-1234567890",
    ciphertextChecksum: "a".repeat(64),
    ciphertextSize: 321,
  };
}

async function workerEnv(home, publicKeyFile) {
  const root = path.join(home, "uploads", "inbound-quarantine");
  return {
    ORKESTR_HOME: home,
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(home, "run", "inbound-worker.sock"),
    ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN: token,
    ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_PUBLIC_KEY_FILE: publicKeyFile,
    ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT: path.join(root, "ciphertext"),
    ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT: path.join(root, "handoff"),
  };
}

test("worker protocol rejects altered signed local request and response fields", () => {
  const request = signInboundAttachmentWorkerRequest({
    pathname: "/v1/scan",
    issuedAt: new Date().toISOString(),
    nonce: "workerrequestnonce1234567890",
    payload: { sessionId: "inbound-1234567890abcdef" },
  }, token);
  assert.equal(verifyInboundAttachmentWorkerRequest(request, token), true);
  assert.equal(verifyInboundAttachmentWorkerRequest({ ...request, pathname: "/v1/keys/rotate" }, token), false);

  const response = signInboundAttachmentWorkerResponse({
    pathname: "/v1/scan",
    issuedAt: new Date().toISOString(),
    nonce: request.nonce,
    result: { verdict: "clean" },
  }, token);
  assert.equal(verifyInboundAttachmentWorkerResponse(response, token), true);
  assert.equal(verifyInboundAttachmentWorkerResponse({ ...response, result: { verdict: "clean", plaintextSize: 1 } }, token), false);
});

test("worker verdict verification rejects stale and misbound signed clean verdicts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-contract-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyFile = path.join(home, "worker-verdict-public.pem");
  await fs.writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  const env = await workerEnv(home, publicKeyFile);
  const fields = expectedVerdictFields();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const valid = signInboundAttachmentWorkerVerdict({
    ...fields,
    verdict: "clean",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    plaintextChecksum: "b".repeat(64),
    plaintextSize: 123,
    descriptor: { version: 1 },
  }, privateKeyPem);
  await assert.doesNotReject(verifyInboundAttachmentWorkerCleanVerdict(valid, fields, env));

  const misbound = signInboundAttachmentWorkerVerdict({ ...valid, threadId: "other-thread" }, privateKeyPem);
  await assert.rejects(verifyInboundAttachmentWorkerCleanVerdict(misbound, fields, env), /inbound_upload_worker_verdict_binding_invalid/);

  const stale = signInboundAttachmentWorkerVerdict({
    ...valid,
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }, privateKeyPem);
  await assert.rejects(verifyInboundAttachmentWorkerCleanVerdict(stale, fields, env), /inbound_upload_worker_verdict_stale/);
});

test("production worker health fails closed when the kernel sandbox executor is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-sandbox-"));
  const root = path.join(home, "uploads", "inbound-quarantine");
  const scannerRoot = path.join(home, "scanner-root");
  const signingKey = path.join(home, "worker-private.pem");
  await Promise.all([
    fs.mkdir(path.join(root, "ciphertext"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(root, "handoff"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, "scratch"), { recursive: true, mode: 0o700 }),
    fs.mkdir(scannerRoot, { recursive: true, mode: 0o700 }),
  ]);
  const { privateKey } = generateKeyPairSync("ed25519");
  await fs.writeFile(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const config = inboundAttachmentWorkerRuntimeConfig({
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(home, "worker.sock"),
    ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN: token,
    ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY: path.join(home, "keys.json"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE: signingKey,
    ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT: path.join(root, "ciphertext"),
    ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT: path.join(root, "handoff"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT: path.join(home, "scratch"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ROOT: scannerRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND: "/scanner/scan",
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS: JSON.stringify(["{file}"]),
    ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP: path.join(home, "missing-bwrap"),
    ORKESTR_INBOUND_UPLOAD_WORKER_UID: String(process.getuid?.() || 1),
    ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "1",
  });
  assert.equal(config.ready, true);
  const health = await inboundAttachmentWorkerHealth(config);
  assert.deepEqual(health, {
    ready: false,
    protocol: 1,
    scannerApproved: false,
    isolationProfile: "unavailable",
    reason: "inbound_upload_worker_sandbox_unavailable",
  });
});
