import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { inboundAttachmentWorkerStaticConfig } from "./inbound-attachment-worker-config.js";
import {
  verifyInboundAttachmentWorkerResponse,
  verifyInboundAttachmentWorkerVerdict,
  signInboundAttachmentWorkerRequest,
} from "./inbound-attachment-worker-contract.js";

function clean(value = "") {
  return String(value || "").trim();
}

function fail(code, statusCode = 503) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function responseAgeValid(issuedAt, maximumAgeMs) {
  const time = Date.parse(clean(issuedAt));
  return Number.isFinite(time) && Math.abs(Date.now() - time) <= maximumAgeMs;
}

function requestWorker(pathname, payload, { timeoutMs = null } = {}, env = process.env) {
  const config = inboundAttachmentWorkerStaticConfig(env);
  if (!config.configured) return Promise.reject(fail("inbound_upload_isolation_contract_required"));
  const issuedAt = new Date().toISOString();
  const nonce = randomUUID().replaceAll("-", "");
  const request = signInboundAttachmentWorkerRequest({
    method: "POST",
    pathname,
    issuedAt,
    nonce,
    payload,
  }, config.token);
  const body = JSON.stringify(request);
  const deadlineMs = Number(timeoutMs || config.requestTimeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const req = http.request({
      method: "POST",
      socketPath: config.socketPath,
      path: pathname,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", () => finish(reject, fail("inbound_upload_worker_unavailable")));
      response.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish(reject, fail("inbound_upload_worker_invalid_response"));
          return;
        }
        if (!verifyInboundAttachmentWorkerResponse(parsed, config.token)
          || clean(parsed.nonce) !== nonce || clean(parsed.pathname) !== pathname || !responseAgeValid(parsed.issuedAt, config.verdictMaxAgeMs)) {
          finish(reject, fail("inbound_upload_worker_untrusted_response"));
          return;
        }
        if (response.statusCode !== 200 || parsed?.ok !== true) {
          finish(reject, fail(clean(parsed?.result?.error) || "inbound_upload_worker_failed", response.statusCode));
          return;
        }
        finish(resolve, parsed.result);
      });
    });
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, fail("inbound_upload_worker_timeout"));
    }, deadlineMs);
    timer.unref?.();
    req.once("error", () => finish(reject, fail("inbound_upload_worker_unavailable")));
    req.write(body);
    req.end();
  });
}

export async function inboundAttachmentWorkerHealth(env = process.env) {
  const config = inboundAttachmentWorkerStaticConfig(env);
  if (!config.configured) return { ready: false, reason: "inbound_upload_isolation_contract_required" };
  try {
    const health = await requestWorker("/v1/health", {}, { timeoutMs: config.healthTimeoutMs }, env);
    const profile = config.testMode ? "test-harness-v1" : "bwrap-v1";
    if (health?.ready !== true || health?.protocol !== 1 || health?.scannerApproved !== true || health?.isolationProfile !== profile) {
      return { ready: false, reason: "inbound_upload_worker_not_ready" };
    }
    return { ready: true, reason: "", health };
  } catch (error) {
    return { ready: false, reason: clean(error?.message) || "inbound_upload_worker_unavailable" };
  }
}

export async function requireInboundAttachmentWorkerReady(env = process.env) {
  const result = await inboundAttachmentWorkerHealth(env);
  if (!result.ready) throw fail(result.reason);
  return result.health;
}

export function inboundAttachmentWorkerKeyAction(action, payload = {}, env = process.env) {
  const allowed = new Set(["ensure", "rotate", "revoke"]);
  if (!allowed.has(clean(action))) return Promise.reject(fail("inbound_upload_worker_key_action_invalid", 400));
  return requestWorker("/v1/keys/" + clean(action), payload, {}, env);
}

export function requestInboundAttachmentWorkerScan(payload = {}, env = process.env) {
  return requestWorker("/v1/scan", payload, {}, env);
}

export async function verifyInboundAttachmentWorkerCleanVerdict(verdict, expected = {}, env = process.env) {
  const config = inboundAttachmentWorkerStaticConfig(env);
  if (!config.configured) throw fail("inbound_upload_isolation_contract_required");
  const publicKey = await fs.readFile(config.verdictPublicKeyFile, "utf8").catch(() => "");
  if (!publicKey || !verifyInboundAttachmentWorkerVerdict(verdict, publicKey)) throw fail("inbound_upload_worker_verdict_untrusted");
  const expiresAt = Date.parse(clean(verdict?.expiresAt));
  const issuedAt = Date.parse(clean(verdict?.issuedAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || Date.now() - issuedAt > config.verdictMaxAgeMs) {
    throw fail("inbound_upload_worker_verdict_stale");
  }
  const fields = ["sessionId", "ownerUserId", "threadId", "keyId", "keyVersion", "processingToken", "ciphertextChecksum", "ciphertextSize"];
  for (const field of fields) {
    if (String(verdict?.[field] ?? "") !== String(expected?.[field] ?? "")) throw fail("inbound_upload_worker_verdict_binding_invalid");
  }
  if (clean(verdict?.verdict) !== "clean" || !/^[a-f0-9]{64}$/i.test(clean(verdict?.plaintextChecksum))
    || !Number.isSafeInteger(Number(verdict?.plaintextSize)) || Number(verdict.plaintextSize) < 1) {
    throw fail("inbound_upload_worker_verdict_invalid");
  }
  return verdict;
}
