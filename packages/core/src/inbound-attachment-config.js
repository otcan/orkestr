import path from "node:path";

const defaultMaxFileBytes = 25 * 1024 * 1024;
const defaultMaxFiles = 20;
const defaultQuarantineBytes = 500 * 1024 * 1024;
const defaultSessionTtlMs = 15 * 60 * 1000;
const defaultPlaintextLeaseMs = 30 * 60 * 1000;
const defaultScannerTimeoutMs = 2 * 60 * 1000;
const defaultScannerRejectExitCode = 10;
const defaultCleanupIntervalMs = 5 * 60 * 1000;

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
  const command = clean(env.ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND);
  const args = scannerArguments(env);
  const scannerApproved = enabled(env.ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED);
  const scannerConfigured = Boolean(
    scannerApproved &&
    command &&
    path.isAbsolute(command) &&
    Array.isArray(args) &&
    args.includes("{file}"),
  );
  const reason = !featureEnabled
    ? "inbound_upload_encryption_disabled"
    : !scannerApproved
      ? "inbound_upload_scanner_not_approved"
      : !command || !path.isAbsolute(command)
        ? "inbound_upload_scanner_command_invalid"
        : !Array.isArray(args) || !args.includes("{file}")
          ? "inbound_upload_scanner_args_invalid"
          : "";
  return {
    enabled: featureEnabled,
    required,
    ready: featureEnabled && scannerConfigured,
    reason,
    scanner: scannerConfigured ? { command, args } : null,
    maxFileBytes: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_FILE_BYTES, defaultMaxFileBytes, 1024, 100 * 1024 * 1024),
    maxFiles: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_FILES, defaultMaxFiles, 1, 100),
    maxQuarantineBytes: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_MAX_QUARANTINE_BYTES, defaultQuarantineBytes, defaultMaxFileBytes, 10 * 1024 * 1024 * 1024),
    sessionTtlMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SESSION_TTL_MS, defaultSessionTtlMs, 60_000, 24 * 60 * 60 * 1000),
    plaintextLeaseMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_PLAINTEXT_LEASE_MS, defaultPlaintextLeaseMs, 60_000, 24 * 60 * 60 * 1000),
    scannerTimeoutMs: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SCANNER_TIMEOUT_MS, defaultScannerTimeoutMs, 1000, 10 * 60 * 1000),
    scannerRejectExitCode: boundedInteger(env.ORKESTR_INBOUND_UPLOAD_SCANNER_REJECT_EXIT_CODE, defaultScannerRejectExitCode, 1, 255),
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
