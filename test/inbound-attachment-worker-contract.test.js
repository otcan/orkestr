import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  signInboundAttachmentWorkerRequest,
  signInboundAttachmentWorkerResponse,
  signInboundAttachmentWorkerVerdict,
  verifyInboundAttachmentWorkerRequest,
  verifyInboundAttachmentWorkerResponse,
} from "../packages/core/src/inbound-attachment-worker-contract.js";
import { verifyInboundAttachmentWorkerCleanVerdict } from "../packages/core/src/inbound-attachment-worker-client.js";
import {
  assertInboundAttachmentWorkerRuntime,
  inboundAttachmentWorkerHealth,
  inboundAttachmentWorkerRuntimeConfig,
} from "../packages/core/src/inbound-attachment-worker-runtime.js";
import { inboundAttachmentWorkerNonceReplayCache } from "../scripts/orkestr-inbound-attachment-worker.mjs";

const token = "worker-contract-test-token-abcdefghijklmnopqrstuvwxyz-0123456789";
const execFile = promisify(execFileCallback);

function runNodeAs(source, { uid, gid, env = {} } = {}) {
  return execFile(process.execPath, ["--input-type=module", "-e", source], {
    uid,
    gid,
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

async function ownedDirectory(directory, { uid, gid, mode }) {
  await fs.mkdir(directory, { recursive: true, mode });
  await fs.chown(directory, uid, gid);
  await fs.chmod(directory, mode);
}

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
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_PROBE_ARGS: JSON.stringify(["--probe"]),
    ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP: path.join(home, "missing-bwrap"),
    ORKESTR_INBOUND_UPLOAD_WORKER_UID: String(process.getuid?.() || 1),
    ORKESTR_INBOUND_UPLOAD_WORKER_TRANSFER_GID: String(process.getgid?.() || 1),
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

test("worker nonce replay ledger survives restart and fails closed at capacity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-nonces-"));
  const nonce = "worker-nonce-replay-1234567890";
  const issuedAt = new Date().toISOString();
  assert.equal(await inboundAttachmentWorkerNonceReplayCache(root).accept(nonce, issuedAt), true);
  assert.equal(await inboundAttachmentWorkerNonceReplayCache(root).accept(nonce, issuedAt), false);
  const full = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`worker-capacity-${String(index).padStart(8, "0")}`, Date.now()]));
  await fs.writeFile(path.join(root, ".worker-nonces.json"), `${JSON.stringify(full)}\n`, { mode: 0o600 });
  await assert.rejects(inboundAttachmentWorkerNonceReplayCache(root).accept("worker-capacity-next-123456", issuedAt), /inbound_upload_worker_nonce_capacity/);
  const ledger = path.join(root, ".worker-nonces.json");
  await fs.rm(ledger, { force: true });
  await fs.mkdir(ledger, { mode: 0o700 });
  await assert.rejects(inboundAttachmentWorkerNonceReplayCache(root).accept("worker-unreadable-ledger-123456", issuedAt), /inbound_upload_worker_nonce_ledger_unavailable/);
});

test("production worker runtime probes bubblewrap and transfer roots under distinct API and worker UIDs", async (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux user namespaces");
  if (process.getuid?.() !== 0) return t.skip("requires root to create distinct temporary API and worker UIDs");
  const bwrap = "/usr/bin/bwrap";
  const busybox = "/bin/busybox";
  if (!await fs.stat(bwrap).then((stat) => stat.isFile(), () => false)) return t.skip("bubblewrap is not installed");
  if (!await fs.stat(busybox).then((stat) => stat.isFile(), () => false)) return t.skip("a static scanner fixture is unavailable");

  const workerUid = 65_534;
  const apiUid = 1;
  const transferGid = 65_534;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-production-"));
  const scannerRoot = path.join(home, "scanner-root");
  const ciphertextRoot = path.join(home, "ciphertext");
  const handoffRoot = path.join(home, "handoff");
  const scratchRoot = path.join(home, "scratch");
  const signingKey = path.join(home, "worker-private.pem");
  await fs.chmod(home, 0o755);
  await ownedDirectory(ciphertextRoot, { uid: workerUid, gid: transferGid, mode: 0o2770 });
  await ownedDirectory(handoffRoot, { uid: workerUid, gid: transferGid, mode: 0o2770 });
  await ownedDirectory(scratchRoot, { uid: workerUid, gid: transferGid, mode: 0o700 });
  await fs.mkdir(scannerRoot, { mode: 0o755 });
  await fs.copyFile(busybox, path.join(scannerRoot, "busybox"));
  await fs.chmod(path.join(scannerRoot, "busybox"), 0o755);
  await fs.writeFile(signingKey, "worker-private-key-fixture\n", { mode: 0o600 });
  await fs.chown(signingKey, workerUid, transferGid);

  const configEnv = {
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(home, "worker.sock"),
    ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN: token,
    ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY: path.join(home, "keys.json"),
    ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE: signingKey,
    ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT: ciphertextRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT: handoffRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT: scratchRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ROOT: scannerRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND: "/scanner/busybox",
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS: JSON.stringify(["cat", "{file}"]),
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_PROBE_ARGS: JSON.stringify(["sh", "-c", "test -z \"$SHOULD_NOT_LEAK\""]),
    ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP: bwrap,
    ORKESTR_INBOUND_UPLOAD_WORKER_UID: String(workerUid),
    ORKESTR_INBOUND_UPLOAD_WORKER_TRANSFER_GID: String(transferGid),
    ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "1",
  };
  const probeArgs = [
    "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", scannerRoot, "/scanner", "--chdir", "/tmp", "--",
    "/scanner/busybox", "sh", "-c", "test -z \"$SHOULD_NOT_LEAK\"",
  ];
  try {
    await execFile(bwrap, probeArgs, { uid: workerUid, gid: transferGid, env: { SHOULD_NOT_LEAK: "1" } });
  } catch (error) {
    if (/Creating new namespace failed: Operation not permitted|unshare(?:\([^)]*\))?: Operation not permitted/i.test(String(error?.stderr || error?.message))) {
      return t.skip("kernel namespace policy does not permit production bubblewrap");
    }
    throw error;
  }

  const runtimeUrl = new URL("../packages/core/src/inbound-attachment-worker-runtime.js", import.meta.url).href;
  const runtimeSource = `
    import { assertInboundAttachmentWorkerRuntime, inboundAttachmentWorkerRuntimeConfig } from ${JSON.stringify(runtimeUrl)};
    process.setgroups?.([Number(process.env.WORKER_GID)]);
    process.setgid(Number(process.env.WORKER_GID));
    process.setuid(Number(process.env.WORKER_UID));
    const config = inboundAttachmentWorkerRuntimeConfig(JSON.parse(process.env.WORKER_CONFIG));
    if (config.testMode) throw new Error("production_runtime_must_not_use_test_mode");
    await assertInboundAttachmentWorkerRuntime(config);
    process.stdout.write("production-runtime-ready\\n");
  `;
  const runtime = await runNodeAs(runtimeSource, {
    env: {
      WORKER_CONFIG: JSON.stringify(configEnv),
      WORKER_UID: String(workerUid),
      WORKER_GID: String(transferGid),
      SHOULD_NOT_LEAK: "1",
      ORKESTR_INBOUND_UPLOAD_WORKER_TEST_MODE: "",
    },
  });
  assert.equal(runtime.stdout, "production-runtime-ready\n");

  const ciphertextOwner = path.join(ciphertextRoot, "owner");
  const ciphertext = path.join(ciphertextOwner, "payload.age");
  const handoffOwner = path.join(handoffRoot, "owner");
  const handoff = path.join(handoffOwner, "payload");
  const staging = path.join(home, "api-staging", "payload");
  const filesUrl = new URL("../packages/core/src/inbound-attachment-files.js", import.meta.url).href;
  const apiWriteCiphertext = `
    import fs from "node:fs/promises";
    import { writeInboundAttachmentCiphertext } from ${JSON.stringify(filesUrl)};
    process.setgroups?.([Number(process.env.TRANSFER_GID)]);
    process.setgid(Number(process.env.TRANSFER_GID));
    process.setuid(Number(process.env.API_UID));
    async function* ciphertext() { yield Buffer.from("ciphertext"); }
    const result = await writeInboundAttachmentCiphertext(ciphertext(), process.env.CIPHERTEXT, 1024);
    await fs.rename(result.temporaryPath, process.env.CIPHERTEXT);
  `;
  await runNodeAs(apiWriteCiphertext, {
    env: { CIPHERTEXT_OWNER: ciphertextOwner, CIPHERTEXT: ciphertext, API_UID: String(apiUid), TRANSFER_GID: String(transferGid) },
  });
  await runNodeAs(`import fs from "node:fs/promises"; if (await fs.readFile(process.env.FILE, "utf8") !== "ciphertext") process.exit(1);`, {
    uid: workerUid,
    gid: transferGid,
    env: { FILE: ciphertext },
  });
  const workerWriteHandoff = `
    import fs from "node:fs/promises";
    await fs.mkdir(process.env.HANDOFF_OWNER, { recursive: true, mode: 0o730 });
    await fs.chmod(process.env.HANDOFF_OWNER, 0o730);
    await fs.writeFile(process.env.HANDOFF, "plaintext", { mode: 0o640 });
  `;
  await runNodeAs(workerWriteHandoff, { uid: workerUid, gid: transferGid, env: { HANDOFF_OWNER: handoffOwner, HANDOFF: handoff } });
  await fs.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  await fs.chown(path.dirname(staging), apiUid, transferGid);
  await fs.chmod(path.dirname(staging), 0o700);
  await runNodeAs(`import fs from "node:fs/promises"; await fs.rename(process.env.HANDOFF, process.env.STAGING); if (await fs.readFile(process.env.STAGING, "utf8") !== "plaintext") process.exit(1);`, {
    uid: apiUid,
    gid: transferGid,
    env: { HANDOFF: handoff, STAGING: staging },
  });
});

test("production bubblewrap probe has an empty environment when kernel namespaces are available", async (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux user namespaces");
  const bwrap = "/usr/bin/bwrap";
  if (!await fs.stat(bwrap).then((stat) => stat.isFile(), () => false)) return t.skip("bubblewrap is not installed");
  try {
    const result = await execFile(bwrap, [
      "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64", "--", "/usr/bin/env",
    ], { env: { SHOULD_NOT_LEAK: "1" }, timeout: 10_000 });
    assert.equal(result.stdout.includes("SHOULD_NOT_LEAK"), false);
  } catch (error) {
    if (/Creating new namespace failed: Operation not permitted|unshare(?:\([^)]*\))?: Operation not permitted/i.test(String(error?.stderr || error?.message))) {
      return t.skip("kernel namespace policy does not permit bubblewrap");
    }
    throw error;
  }
});
