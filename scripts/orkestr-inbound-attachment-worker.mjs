#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  inboundAttachmentWorkerHealth,
  inboundAttachmentWorkerKeyAction,
  inboundAttachmentWorkerRuntimeConfig,
  assertInboundAttachmentWorkerRuntime,
  runInboundAttachmentWorkerScan,
} from "../packages/core/src/inbound-attachment-worker-runtime.js";
import { acquireRuntimeLeaseFileLock } from "../packages/core/src/runtime-lease-lock.js";
import { withStorageFileLock } from "../packages/storage/src/storage-lock.js";
import {
  signInboundAttachmentWorkerResponse,
  verifyInboundAttachmentWorkerRequest,
} from "../packages/core/src/inbound-attachment-worker-contract.js";

function clean(value = "") {
  return String(value || "").trim();
}

function publicError(error) {
  const code = clean(error?.message);
  return /^inbound_upload_[a-z0-9_]+$/.test(code) ? code : "inbound_upload_worker_failed";
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 128 * 1024) throw new Error("inbound_upload_worker_request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

export function inboundAttachmentWorkerNonceReplayCache(root) {
  const filePath = path.join(root, ".worker-nonces.json");
  return {
    accept(nonce, issuedAt) {
      return withStorageFileLock(filePath, async () => {
        const now = Date.now();
        const issued = Date.parse(issuedAt);
        let raw = "{}";
        try {
          raw = await fs.readFile(filePath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw Object.assign(new Error("inbound_upload_worker_nonce_ledger_unavailable"), { statusCode: 503 });
        }
        let seen;
        try {
          seen = JSON.parse(raw);
          if (!seen || typeof seen !== "object" || Array.isArray(seen)) throw new Error("invalid");
        } catch {
          throw Object.assign(new Error("inbound_upload_worker_nonce_ledger_unavailable"), { statusCode: 503 });
        }
        for (const [key, timestamp] of Object.entries(seen)) if (!Number.isFinite(Number(timestamp)) || Number(timestamp) < now - 60_000) delete seen[key];
        if (!Number.isFinite(issued) || Math.abs(now - issued) > 30_000 || Object.hasOwn(seen, nonce)) return false;
        if (Object.keys(seen).length >= 2_000) throw Object.assign(new Error("inbound_upload_worker_nonce_capacity"), { statusCode: 503 });
        seen[nonce] = now;
        const temporary = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(seen)}\n`, { mode: 0o600 });
        await fs.rename(temporary, filePath);
        return true;
      });
    },
  };
}

async function socketIsLive(socketPath) {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath });
    client.once("connect", () => { client.destroy(); resolve(true); });
    client.once("error", () => resolve(false));
  });
}

async function prepareSocket(socketPath) {
  const existing = await fs.lstat(socketPath).catch(() => null);
  if (!existing) return;
  if (!existing.isSocket()) throw new Error("inbound_upload_worker_socket_invalid");
  if (await socketIsLive(socketPath)) throw new Error("inbound_upload_worker_socket_in_use");
  await fs.unlink(socketPath);
}

async function clearScratch(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
    .map(async (entry) => {
      const ownerRoot = path.join(root, entry.name);
      const jobs = await fs.readdir(ownerRoot, { withFileTypes: true }).catch(() => []);
      await Promise.all(jobs
        .filter((job) => job.isDirectory() && /^[a-zA-Z0-9_-]{16,160}-[a-zA-Z0-9_-]{16,160}$/.test(job.name))
        .map((job) => fs.rm(path.join(ownerRoot, job.name), { recursive: true, force: true })));
    }));
}

function onceAsync(operation) {
  let result = null;
  return () => {
    if (!result) result = Promise.resolve().then(operation);
    return result;
  };
}

async function closeListeningServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startInboundAttachmentWorker(env = process.env) {
  const config = inboundAttachmentWorkerRuntimeConfig(env);
  let releaseRootLease = null;
  let server = null;
  try {
    await assertInboundAttachmentWorkerRuntime(config);
    if (!config.socketPath || !path.isAbsolute(config.socketPath)) throw new Error("inbound_upload_worker_not_configured");
    if (await socketIsLive(config.socketPath)) throw new Error("inbound_upload_worker_socket_in_use");
    const releaseLease = await acquireRuntimeLeaseFileLock(path.join(config.scratchRoot, ".worker-root"), { timeoutMs: 0, staleMs: 30_000, heartbeatMs: 10_000 });
    releaseRootLease = onceAsync(releaseLease);
    await fs.lstat(path.dirname(config.socketPath)).then((stat) => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("inbound_upload_worker_socket_root_invalid");
    });
    await prepareSocket(config.socketPath);
    await clearScratch(config.scratchRoot);
    const nonces = inboundAttachmentWorkerNonceReplayCache(config.scratchRoot);
    const scanClaims = new Set();
    server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || !["/v1/health", "/v1/keys/ensure", "/v1/keys/rotate", "/v1/keys/revoke", "/v1/scan"].includes(clean(request.url))) {
        sendResponse(response, 404, { ok: false, error: "inbound_upload_worker_route_not_found" });
        return;
      }
      let signed = null;
      let authenticated = false;
      try {
        signed = await readBody(request);
        const pathname = clean(request.url);
        if (!verifyInboundAttachmentWorkerRequest(signed, config.token) || signed.method !== "POST" || signed.pathname !== pathname) {
          sendResponse(response, 403, { ok: false, error: "inbound_upload_worker_auth_invalid" });
          return;
        }
        authenticated = true;
        if (!await nonces.accept(signed.nonce, signed.issuedAt)) {
          throw Object.assign(new Error("inbound_upload_worker_auth_replayed"), { statusCode: 403 });
        }
        let result;
        if (pathname === "/v1/health") result = await inboundAttachmentWorkerHealth(config);
        else if (pathname === "/v1/scan") {
          const scanClaim = `${clean(signed.payload?.sessionId)}:${clean(signed.payload?.processingToken)}`;
          if (!scanClaim || scanClaims.has(scanClaim)) throw Object.assign(new Error("inbound_upload_worker_scan_in_flight"), { statusCode: 409 });
          scanClaims.add(scanClaim);
          try {
            result = await runInboundAttachmentWorkerScan(signed.payload, config);
          } finally {
            scanClaims.delete(scanClaim);
          }
        }
        else result = await inboundAttachmentWorkerKeyAction(pathname.split("/").at(-1), signed.payload, config);
        sendResponse(response, 200, {
          ok: true,
          ...signInboundAttachmentWorkerResponse({ pathname, issuedAt: new Date().toISOString(), nonce: signed.nonce, result }, config.token),
        });
      } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        if (authenticated) {
          const pathname = clean(request.url);
          sendResponse(response, statusCode, {
            ok: false,
            ...signInboundAttachmentWorkerResponse({
              pathname,
              issuedAt: new Date().toISOString(),
              nonce: signed.nonce,
              result: { error: publicError(error) },
            }, config.token),
          });
          return;
        }
        sendResponse(response, statusCode, { ok: false, error: publicError(error) });
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socketPath, () => { server.off("error", reject); resolve(); });
    });
    await fs.chmod(config.socketPath, 0o660);
    const close = server.close.bind(server);
    const closeWorker = onceAsync(async () => {
      try {
        await new Promise((resolve, reject) => close((error) => error ? reject(error) : resolve()));
      } finally {
        await releaseRootLease?.();
      }
    });
    server.close = (callback) => {
      void closeWorker().then(() => callback?.(), (error) => callback?.(error));
      return server;
    };
    return server;
  } catch (error) {
    await closeListeningServer(server).catch(() => {});
    await releaseRootLease?.().catch(() => {});
    throw error;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  startInboundAttachmentWorker(process.env).catch((error) => {
    console.error(publicError(error));
    process.exit(1);
  });
}
