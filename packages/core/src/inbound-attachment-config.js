import path from "node:path";
import { inboundAttachmentWorkerStaticConfig } from "./inbound-attachment-worker-config.js";

const defaultMaxFileBytes = 25 * 1024 * 1024;
const defaultMaxFiles = 20;
const defaultQuarantineBytes = 500 * 1024 * 1024;
const defaultSessionTtlMs = 15 * 60 * 1000;
const defaultPlaintextLeaseMs = 30 * 60 * 1000;
const defaultScannerTimeoutMs = 2 * 60 * 1000;
const defaultScannerRejectExitCode = 10;
const defaultCleanupIntervalMs = 5 * 60 * 1000;
const ciphertextOverheadBytes = 256 * 1024;

function clean(value = "") {
  return String(value || "").trim();
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function scannerArguments(env = process.env) {
  const raw = clean(env.ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 32) return null;
    const args = parsed.map((value) => clean(value));
    return args.every((value) => value.length <= 512 && !value.includes("\u0000")) ? args : null;
  } catch {
    return null;
  }
}

export function inboundAttachmentUploadPolicy(env = process.env) {
  const required = enabled(env.ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED);
  const featureEnabled = required || enabled(env.ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED);
  const intakePaused = enabled(env.ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED);
  const command = clean(env.ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND);
  const args = scannerArguments(env);
  const scannerApproved = enabled(env.ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED);
  const testIsolation = enabled(env.ORKESTR_INBOUND_UPLOAD_TEST_ISOLATION)
    && env.ORKESTR_TEST_STORAGE_BOOTSTRAPPED === "1";
  const worker = inboundAttachmentWorkerStaticConfig(env);
  const testScannerConfigured = Boolean(
    scannerApproved &&
    command &&
    path.isAbsolute(command) &&
    Array.isArray(args) &&
    args.includes("{file}"),
  );
  // Production plaintext handling is exclusively delegated to the worker. The
  // legacy command is intentionally usable only by the storage-bootstrap test
  // harness, never as a production fallback.
  const scannerConfigured = testIsolation ? testScannerConfigured : scannerApproved && worker.configured;
  const isolationReady = testIsolation || worker.configured;
  const reason = !featureEnabled
    ? "inbound_upload_encryption_disabled"
    : !scannerApproved
      ? "inbound_upload_scanner_not_approved"
    : testIsolation && (!command || !path.isAbsolute(command))
      ? "inbound_upload_scanner_command_invalid"
        : testIsolation && (!Array.isArray(args) || !args.includes("{file}"))
          ? "inbound_upload_scanner_args_invalid"
          : intakePaused
            ? "inbound_upload_intake_paused"
            : !isolationReady
              ? "inbound_upload_isolation_contract_required"
              : "";
  return {
    enabled: featureEnabled,
    required,
    ready: featureEnabled && scannerConfigured && !intakePaused && isolationReady,
    reason,
    scanner: testIsolation && testScannerConfigured ? { command, args } : null,
    intakePaused,
    testIsolation,
    worker,
    maxFileBytes: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_FILE_BYTES, defaultMaxFileBytes, 1024, 100 * 1024 * 1024),
    maxFiles: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_FILES, defaultMaxFiles, 1, 100),
    maxQuarantineBytes: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_QUARANTINE_BYTES, defaultQuarantineBytes, defaultMaxFileBytes, 10 * 1024 * 1024 * 1024),
    sessionTtlMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SESSION_TTL_MS, defaultSessionTtlMs, 60_000, 24 * 60 * 60 * 1000),
    plaintextLeaseMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_PLAINTEXT_LEASE_MS, defaultPlaintextLeaseMs, 60_000, 24 * 60 * 60 * 1000),
    scannerTimeoutMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SCANNER_TIMEOUT_MS, defaultScannerTimeoutMs, 1000, 10 * 60 * 1000),
    scannerRejectExitCode: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SCANNER_REJECT_EXIT_CODE, defaultScannerRejectExitCode, 1, 255),
    ciphertextOverheadBytes,
    maxCiphertextBytes: boundedInteger(
      env.ORKESTR_INBOUND_UPLOAD_MAX_CIPHERTEXT_BYTES,
      defaultMaxFileBytes + ciphertextOverheadBytes,
      1024 + ciphertextOverheadBytes,
      101 * 1024 * 1024,
    ),
    maxOwnerQuarantineBytes: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_OWNER_QUARANTINE_BYTES, defaultQuarantineBytes, defaultMaxFileBytes, 10 * 1024 * 1024 * 1024),
    maxSessionsPerOwner: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_PER_OWNER, 100, 1, 10_000),
    maxSessionsGlobal: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_GLOBAL, 10_000, 1, 100_000),
    maxConcurrentProcessingPerOwner: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_CONCURRENT_PROCESSING_PER_OWNER, 2, 1, 100),
    maxConcurrentProcessingGlobal: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_CONCURRENT_PROCESSING_GLOBAL, 20, 1, 1_000),
    processingLeaseMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_PROCESSING_LEASE_MS, defaultScannerTimeoutMs + 60_000, 30_000, 30 * 60 * 1000),
    terminalRetentionMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_TERMINAL_RETENTION_MS, 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
    partialUploadTtlMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_PARTIAL_UPLOAD_TTL_MS, 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
  };
}

export function requireInboundAttachmentUploadReady(env = process.env) {
  const policy = inboundAttachmentUploadPolicy(env);
  if (!policy.enabled) {
    const error = new Error("inbound_upload_encryption_disabled");
    error.statusCode = 409;
    throw error;
  }
  if (!policy.ready) {
    const error = new Error(policy.reason || "inbound_upload_not_ready");
    error.statusCode = 503;
    throw error;
  }
  return policy;
}

export function inboundAttachmentCleanupIntervalMs(env = process.env) {
  return boundedInteger(env.ORKESTR_INBOUND_UPLOAD_CLEANUP_INTERVAL_MS, defaultCleanupIntervalMs, 60_000, 24 * 60 * 60 * 1000);
}
