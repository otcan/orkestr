import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import * as age from "age-encryption";
import { writeInboundAttachmentPayload } from "./inbound-attachment-payload.js";
import { inboundAttachmentFileDigest } from "./inbound-attachment-files.js";
import {
  ensureInboundAttachmentWorkerKey,
  inboundAttachmentWorkerKeyById,
  revokeInboundAttachmentWorkerKey,
  rotateInboundAttachmentWorkerKey,
} from "./inbound-attachment-worker-keys.js";
import { inboundAttachmentWorkerProtocolVersion, signInboundAttachmentWorkerVerdict } from "./inbound-attachment-worker-contract.js";

const execFileAsync = promisify(execFile);

function clean(value = "") {
  return String(value || "").trim();
}

function enabled(value = "") {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function safeSessionId(value = "") {
  const id = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(id) ? id : "";
}

function safeToken(value = "") {
  const token = clean(value);
  return /^[a-zA-Z0-9_-]{16,160}$/.test(token) ? token : "";
}

function ownerBucket(ownerUserId = "") {
  return createHash("sha256").update(clean(ownerUserId)).digest("hex").slice(0, 24);
}

function parseScannerArgs(raw = "") {
  try {
    const parsed = JSON.parse(clean(raw));
    if (!Array.isArray(parsed) || parsed.length > 32) return null;
    const args = parsed.map((value) => clean(value));
    return args.every((value) => value.length <= 512 && !value.includes("\0")) ? args : null;
  } catch {
    return null;
  }
}

function fail(code, statusCode = 503) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function pathInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved.startsWith(base + path.sep);
}

export function inboundAttachmentWorkerRuntimeConfig(env = process.env) {
  const testMode = enabled(env.ORKESTR_INBOUND_UPLOAD_WORKER_TEST_MODE) && env.ORKESTR_TEST_STORAGE_BOOTSTRAPPED === "1";
  const scannerRoot = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ROOT);
  const scannerCommand = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND);
  const scannerArgs = parseScannerArgs(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS);
  const bwrapPath = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP || "/usr/bin/bwrap");
  const workerUid = Number(env.ORKESTR_INBOUND_UPLOAD_WORKER_UID);
  const config = {
    socketPath: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET),
    token: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN),
    keyRegistry: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY),
    signingKeyFile: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE),
    ciphertextRoot: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT),
    handoffRoot: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT),
    scratchRoot: clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT),
    scannerRoot,
    scannerCommand,
    scannerArgs,
    bwrapPath,
    workerUid,
    scannerApproved: enabled(env.ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED),
    scannerTimeoutMs: bounded(env.ORKESTR_INBOUND_UPLOAD_SCANNER_TIMEOUT_MS, 120_000, 1_000, 10 * 60 * 1000),
    verdictTtlMs: bounded(env.ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_TTL_MS, 60_000, 1_000, 5 * 60 * 1000),
    testMode,
  };
  config.ready = Boolean(
    config.socketPath && path.isAbsolute(config.socketPath) &&
    config.token.length >= 32 &&
    config.keyRegistry && path.isAbsolute(config.keyRegistry) &&
    config.signingKeyFile && path.isAbsolute(config.signingKeyFile) &&
    config.ciphertextRoot && path.isAbsolute(config.ciphertextRoot) &&
    config.handoffRoot && path.isAbsolute(config.handoffRoot) &&
    config.scratchRoot && path.isAbsolute(config.scratchRoot) &&
    config.scannerApproved && config.scannerArgs && config.scannerArgs.includes("{file}") &&
    (config.testMode || (
      Number.isInteger(config.workerUid) && config.workerUid > 0 &&
      config.scannerRoot && path.isAbsolute(config.scannerRoot) &&
      config.scannerCommand.startsWith("/scanner/") &&
      path.isAbsolute(config.bwrapPath)
    ))
  );
  return config;
}

async function requirePrivateFile(filePath, expectedUid, testMode) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || (stat.mode & 0o077) !== 0 || (!testMode && stat.uid !== expectedUid)) throw fail("inbound_upload_worker_private_file_invalid");
}

async function assertWorkerRuntime(config) {
  if (!config.ready) throw fail("inbound_upload_worker_not_configured");
  if (!config.testMode) {
    const [bwrap, scannerRoot] = await Promise.all([
      fs.stat(config.bwrapPath).catch(() => null),
      fs.stat(config.scannerRoot).catch(() => null),
    ]);
    if (!bwrap?.isFile() || !scannerRoot?.isDirectory()) throw fail("inbound_upload_worker_sandbox_unavailable");
    if (process.getuid?.() === 0 || process.getuid?.() !== config.workerUid) throw fail("inbound_upload_worker_identity_invalid");
  }
  await requirePrivateFile(config.signingKeyFile, config.workerUid, config.testMode);
  const [ciphertextRoot, handoffRoot, scratchRoot] = await Promise.all([
    fs.stat(config.ciphertextRoot).catch(() => null),
    fs.stat(config.handoffRoot).catch(() => null),
    fs.stat(config.scratchRoot).catch(() => null),
  ]);
  if (!ciphertextRoot?.isDirectory() || !handoffRoot?.isDirectory() || !scratchRoot?.isDirectory() || ciphertextRoot.dev !== handoffRoot.dev) {
    throw fail("inbound_upload_worker_storage_invalid");
  }
}

async function runScanner(plaintextPath, config) {
  if (config.testMode) {
    const args = config.scannerArgs.map((argument) => argument.replaceAll("{file}", plaintextPath));
    try {
      await execFileAsync(config.scannerCommand, args, { timeout: config.scannerTimeoutMs, maxBuffer: 64 * 1024, env: {} });
      return { approved: true };
    } catch (error) {
      return { approved: false, retryable: Number(error?.code) !== 10, reason: Number(error?.code) === 10 ? "scanner_rejected" : "scanner_unavailable" };
    }
  }
  const args = [
    "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", config.scannerRoot, "/scanner",
    "--ro-bind", plaintextPath, "/input/payload",
    "--chdir", "/tmp", "--",
    config.scannerCommand,
    ...config.scannerArgs.map((argument) => argument.replaceAll("{file}", "/input/payload")),
  ];
  try {
    await execFileAsync(config.bwrapPath, args, { timeout: config.scannerTimeoutMs, maxBuffer: 64 * 1024, env: {} });
    return { approved: true };
  } catch (error) {
    return { approved: false, retryable: Number(error?.code) !== 10, reason: Number(error?.code) === 10 ? "scanner_rejected" : "scanner_unavailable" };
  }
}

export async function inboundAttachmentWorkerHealth(config) {
  try {
    await assertWorkerRuntime(config);
    return {
      ready: true,
      protocol: inboundAttachmentWorkerProtocolVersion,
      scannerApproved: config.scannerApproved,
      isolationProfile: config.testMode ? "test-harness-v1" : "bwrap-v1",
    };
  } catch (error) {
    return { ready: false, protocol: inboundAttachmentWorkerProtocolVersion, scannerApproved: false, isolationProfile: "unavailable", reason: clean(error?.message) };
  }
}

export async function inboundAttachmentWorkerKeyAction(action, payload = {}, config) {
  await assertWorkerRuntime(config);
  const ownerUserId = clean(payload.ownerUserId);
  if (!ownerUserId) throw fail("inbound_upload_worker_key_owner_invalid", 400);
  if (action === "ensure") return ensureInboundAttachmentWorkerKey(config.keyRegistry, ownerUserId);
  if (action === "rotate") return rotateInboundAttachmentWorkerKey(config.keyRegistry, ownerUserId);
  if (action === "revoke") return revokeInboundAttachmentWorkerKey(config.keyRegistry, ownerUserId, payload.keyId);
  throw fail("inbound_upload_worker_key_action_invalid", 400);
}

export async function runInboundAttachmentWorkerScan(payload = {}, config) {
  await assertWorkerRuntime(config);
  const sessionId = safeSessionId(payload.sessionId);
  const processingToken = safeToken(payload.processingToken);
  const ownerUserId = clean(payload.ownerUserId);
  const keyId = clean(payload.keyId);
  if (!sessionId || !processingToken || !ownerUserId || !keyId || !clean(payload.threadId)) throw fail("inbound_upload_worker_request_invalid", 400);
  const ciphertextPath = path.join(config.ciphertextRoot, ownerBucket(ownerUserId), sessionId + ".age");
  if (!pathInside(config.ciphertextRoot, ciphertextPath)) throw fail("inbound_upload_worker_ciphertext_invalid", 400);
  const expectedCiphertext = await inboundAttachmentFileDigest(ciphertextPath).catch(() => null);
  if (!expectedCiphertext || expectedCiphertext.size !== Number(payload.ciphertextSize || 0) || expectedCiphertext.checksum !== clean(payload.ciphertextChecksum)) {
    throw fail("inbound_upload_worker_ciphertext_invalid", 409);
  }
  const key = await inboundAttachmentWorkerKeyById(config.keyRegistry, ownerUserId, keyId);
  if (!key || key.status === "revoked" || !clean(key.identity)) throw fail("inbound_upload_key_unavailable", 409);
  const scratch = path.join(config.scratchRoot, ownerBucket(ownerUserId), sessionId + "-" + processingToken);
  const plaintextPath = path.join(scratch, "payload");
  const handoffPath = path.join(config.handoffRoot, ownerBucket(ownerUserId), sessionId + "-" + processingToken);
  if (!pathInside(config.scratchRoot, scratch) || !pathInside(config.handoffRoot, handoffPath)) throw fail("inbound_upload_worker_path_invalid", 400);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  let moved = false;
  try {
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(key.identity);
    const plaintext = await decrypter.decrypt(Readable.toWeb(createReadStream(ciphertextPath)));
    const decoded = await writeInboundAttachmentPayload(plaintext, {
      destinationPath: plaintextPath,
      sessionId,
      keyId,
      plaintextSize: Number(payload.plaintextSize || 0),
      maxPlaintextBytes: Number(payload.maxPlaintextBytes || 0),
    });
    const verdict = await runScanner(plaintextPath, config);
    if (!verdict.approved) return verdict;
    const plaintextDigest = await inboundAttachmentFileDigest(plaintextPath);
    await fs.mkdir(path.dirname(handoffPath), { recursive: true, mode: 0o710 });
    await fs.rename(plaintextPath, handoffPath);
    await fs.chmod(handoffPath, 0o640);
    moved = true;
    const signingKey = await fs.readFile(config.signingKeyFile, "utf8");
    return signInboundAttachmentWorkerVerdict({
      kind: "inbound_attachment_clean_verdict",
      verdict: "clean",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.verdictTtlMs).toISOString(),
      sessionId,
      ownerUserId,
      threadId: clean(payload.threadId),
      keyId,
      keyVersion: Number(payload.keyVersion || 0),
      processingToken,
      ciphertextChecksum: expectedCiphertext.checksum,
      ciphertextSize: expectedCiphertext.size,
      plaintextChecksum: plaintextDigest.checksum,
      plaintextSize: plaintextDigest.size,
      descriptor: decoded.descriptor,
      filename: decoded.filename,
      mimetype: decoded.mimetype,
      handoffRef: ownerBucket(ownerUserId) + "/" + sessionId + "-" + processingToken,
    }, signingKey);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (!moved) await fs.rm(handoffPath, { force: true }).catch(() => {});
  }
}
