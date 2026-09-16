import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";

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

export function inboundAttachmentWorkerStaticConfig(env = process.env) {
  const socketPath = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET);
  const token = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN);
  const verdictPublicKeyFile = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_PUBLIC_KEY_FILE);
  const ciphertextRoot = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT);
  const handoffRoot = clean(env.ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT);
  const quarantineRoot = path.join(dataPaths(env).home, "uploads", "inbound-quarantine");
  const expectedCiphertextRoot = path.join(quarantineRoot, "ciphertext");
  const expectedHandoffRoot = path.join(quarantineRoot, "handoff");
  const configured = Boolean(
    socketPath && path.isAbsolute(socketPath) &&
    token.length >= 32 &&
    verdictPublicKeyFile && path.isAbsolute(verdictPublicKeyFile) &&
    ciphertextRoot && path.resolve(ciphertextRoot) === path.resolve(expectedCiphertextRoot) &&
    handoffRoot && path.resolve(handoffRoot) === path.resolve(expectedHandoffRoot),
  );
  return {
    socketPath,
    token,
    verdictPublicKeyFile,
    ciphertextRoot,
    handoffRoot,
    expectedCiphertextRoot,
    expectedHandoffRoot,
    requestTimeoutMs: bounded(env.ORKESTR_INBOUND_UPLOAD_WORKER_TIMEOUT_MS, 120_000, 1_000, 10 * 60 * 1000),
    healthTimeoutMs: bounded(env.ORKESTR_INBOUND_UPLOAD_WORKER_HEALTH_TIMEOUT_MS, 5_000, 250, 30_000),
    verdictMaxAgeMs: bounded(env.ORKESTR_INBOUND_UPLOAD_WORKER_VERDICT_MAX_AGE_MS, 60_000, 1_000, 5 * 60 * 1000),
    configured,
    testMode: enabled(env.ORKESTR_INBOUND_UPLOAD_WORKER_TEST_MODE) && env.ORKESTR_TEST_STORAGE_BOOTSTRAPPED === "1",
  };
}
