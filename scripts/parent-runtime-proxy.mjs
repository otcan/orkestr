#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const env = process.env;
const listenHost = String(env.ORKESTR_PARENT_RUNTIME_PROXY_LISTEN_HOST || "127.0.0.1").trim() || "127.0.0.1";
const listenPort = Number(env.ORKESTR_PARENT_RUNTIME_PROXY_PORT || 18914) || 18914;
const upstreamBaseUrl = String(env.ORKESTR_PARENT_RUNTIME_PROXY_UPSTREAM || "http://127.0.0.1:18912").trim().replace(/\/+$/, "");
const maxBodyBytes = Number(env.ORKESTR_PARENT_RUNTIME_PROXY_MAX_BODY_BYTES || 10 * 1024 * 1024) || 10 * 1024 * 1024;

function splitTokens(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function incomingTokens() {
  return [
    ...splitTokens(env.ORKESTR_PARENT_RUNTIME_PROXY_TOKEN),
    ...splitTokens(env.ORKESTR_REMOTE_THREAD_BACKEND_TOKEN),
    ...splitTokens(env.ORKESTR_REMOTE_RUNTIME_BACKEND_TOKEN),
  ];
}

function authorized(request) {
  const token = bearerToken(request.headers.authorization || "");
  const allowed = incomingTokens();
  return Boolean(token && allowed.length && allowed.some((candidate) => timingSafeEqual(token, candidate)));
}

function cliAuthFilePath() {
  const explicit = String(env.ORKESTR_PARENT_RUNTIME_PROXY_CLI_AUTH_FILE || "").trim();
  if (explicit) return explicit;
  const home = String(env.ORKESTR_PARENT_RUNTIME_PROXY_ORKESTR_HOME || env.ORKESTR_HOME || "").trim();
  return home ? path.join(home, "secrets", "cli-auth.json") : "";
}

async function upstreamToken() {
  const explicit = String(env.ORKESTR_PARENT_RUNTIME_PROXY_UPSTREAM_TOKEN || env.ORKESTR_CLI_AUTH_TOKEN || env.ORKESTR_API_TOKEN || "").trim();
  if (explicit) return explicit;
  const filePath = cliAuthFilePath();
  if (!filePath) return "";
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const expiresAt = Date.parse(String(parsed.expiresAt || ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return "";
    return String(parsed.token || "").trim();
  } catch {
    return "";
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("request_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function upstreamUrl(endpointPath, search = "") {
  const endpoint = String(endpointPath || "").replace(/^\/+/, "");
  return new URL(`${upstreamBaseUrl}/${endpoint}${search || ""}`);
}

async function forward(request, response, endpointPath) {
  const body = ["GET", "HEAD"].includes(request.method || "GET") ? null : await readBody(request);
  const token = await upstreamToken();
  const headers = {
    ...(body ? { "content-type": request.headers["content-type"] || "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const upstream = await fetch(upstreamUrl(endpointPath), {
    method: request.method,
    headers,
    body,
    signal: AbortSignal.timeout(Number(env.ORKESTR_PARENT_RUNTIME_PROXY_UPSTREAM_TIMEOUT_MS || 30_000) || 30_000),
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function threadPath(urlPath, suffix) {
  const match = urlPath.match(/^\/threads\/([^/]+)\/([^/]+)$/);
  if (!match || match[2] !== suffix) return "";
  return decodeURIComponent(match[1]);
}

async function handle(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse(response, 200, {
      ok: true,
      service: "orkestr-parent-runtime-proxy",
      upstream: upstreamBaseUrl,
      tokenRequired: incomingTokens().length > 0,
    });
  }
  if (!authorized(request)) return jsonResponse(response, 401, { ok: false, error: "parent_runtime_proxy_auth_required" });

  const inputThreadId = threadPath(url.pathname, "input");
  if (request.method === "POST" && inputThreadId) {
    return forward(request, response, `/api/threads/${encodeURIComponent(inputThreadId)}/input`);
  }
  const messagesThreadId = threadPath(url.pathname, "messages");
  if (request.method === "GET" && messagesThreadId) {
    return forward(request, response, `/api/threads/${encodeURIComponent(messagesThreadId)}/messages${url.search}`);
  }
  const historyThreadId = threadPath(url.pathname, "history");
  if (request.method === "GET" && historyThreadId) {
    return forward(request, response, `/api/threads/${encodeURIComponent(historyThreadId)}/history${url.search}`);
  }
  const statusThreadId = threadPath(url.pathname, "status");
  if (request.method === "GET" && statusThreadId) {
    return forward(request, response, `/api/threads/${encodeURIComponent(statusThreadId)}/runtime-lite`);
  }
  const interruptThreadId = threadPath(url.pathname, "interrupt");
  if (request.method === "POST" && interruptThreadId) {
    return forward(request, response, `/api/threads/${encodeURIComponent(interruptThreadId)}/interrupt`);
  }

  return jsonResponse(response, 404, { ok: false, error: "parent_runtime_proxy_route_not_found" });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    jsonResponse(response, error.statusCode || 502, { ok: false, error: error.message || String(error) });
  });
});

server.listen(listenPort, listenHost, () => {
  console.log(`orkestr parent runtime proxy listening on ${listenHost}:${listenPort}`);
});

