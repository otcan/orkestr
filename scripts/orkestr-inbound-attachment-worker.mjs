#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  inboundAttachmentWorkerHealth,
  inboundAttachmentWorkerKeyAction,
  inboundAttachmentWorkerRuntimeConfig,
  runInboundAttachmentWorkerScan,
} from "../packages/core/src/inbound-attachment-worker-runtime.js";
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

function nonceReplayCache() {
  const seen = new Map();
  return {
    accept(nonce, issuedAt) {
      const issued = Date.parse(issuedAt);
      const now = Date.now();
      if (!Number.isFinite(issued) || Math.abs(now - issued) > 30_000 || seen.has(nonce)) return false;
      seen.set(nonce, now);
      for (const [key, timestamp] of seen) {
        if (timestamp < now - 60_000 || seen.size > 2_000) seen.delete(key);
      }
      return true;
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
  await Promise.all(entries.map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
}

export async function startInboundAttachmentWorker(env = process.env) {
  const config = inboundAttachmentWorkerRuntimeConfig(env);
  if (!config.socketPath || !path.isAbsolute(config.socketPath)) throw new Error("inbound_upload_worker_not_configured");
  await fs.mkdir(path.dirname(config.socketPath), { recursive: true, mode: 0o750 });
  await prepareSocket(config.socketPath);
  await clearScratch(config.scratchRoot);
  const nonces = nonceReplayCache();
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !["/v1/health", "/v1/keys/ensure", "/v1/keys/rotate", "/v1/keys/revoke", "/v1/scan"].includes(clean(request.url))) {
      sendResponse(response, 404, { ok: false, error: "inbound_upload_worker_route_not_found" });
      return;
    }
    let signed = null;
    let authenticated = false;
    try {
      signed = await readBody(request);
      const pathname = clean(request.url);
      if (!verifyInboundAttachmentWorkerRequest(signed, config.token) || signed.method !== "POST" || signed.pathname !== pathname || !nonces.accept(signed.nonce, signed.issuedAt)) {
        sendResponse(response, 403, { ok: false, error: "inbound_upload_worker_auth_invalid" });
        return;
      }
      authenticated = true;
      let result;
      if (pathname === "/v1/health") result = await inboundAttachmentWorkerHealth(config);
      else if (pathname === "/v1/scan") result = await runInboundAttachmentWorkerScan(signed.payload, config);
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
  return server;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  startInboundAttachmentWorker(process.env).catch((error) => {
    console.error(publicError(error));
    process.exit(1);
  });
}
