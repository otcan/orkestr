#!/usr/bin/env node
import crypto from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorizeConnectorMcpRequest, authorizeConnectorMcpToken } from "../packages/connectors/src/connectors-mcp-auth.js";
import { createConnectorsMcpServer } from "../packages/connectors/src/connectors-mcp-server.js";
import { listConnectorInboxEvents } from "../packages/connectors/src/connector-inbox.js";
import { retryConnectorInbox, routeWhatsAppInboundFromWorker } from "../packages/connectors/src/connectors-mcp-router.js";
import { requestWhatsAppWorker, whatsappWorkerHealth } from "../packages/connectors/src/whatsapp-worker-client.js";
import { requireWaServicePolicy } from "./orkestr-wa-policy.mjs";

function clean(value = "") {
  return String(value || "").trim();
}

function list(value = "") {
  return clean(value).split(/[\s,]+/g).map((item) => item.trim()).filter(Boolean);
}

function listenHost(env = process.env) {
  return clean(env.ORKESTR_CONNECTORS_MCP_HOST || "127.0.0.1");
}

function listenPort(env = process.env) {
  return Math.max(1, Number(env.ORKESTR_CONNECTORS_MCP_PORT || 18914) || 18914);
}

function secretEqual(left = "", right = "") {
  if (!left || !right) return false;
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  return clean(req.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

function isLoopbackRequest(req) {
  const address = clean(req.socket?.remoteAddress).replace(/^::ffff:/, "");
  return !address || address === "127.0.0.1" || address === "::1";
}

function allowedOrigins(env = process.env) {
  return new Set(list(env.ORKESTR_CONNECTORS_MCP_ALLOWED_ORIGINS));
}

function originAllowed(req, env = process.env) {
  const origin = clean(req.headers.origin);
  if (!origin) return true;
  return allowedOrigins(env).has(origin);
}

function jsonError(res, status, code) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message: code }, id: null });
}

function legacyTokenAllowed(req, env = process.env) {
  const token = clean(env.ORKESTR_WA_SERVICE_TOKEN || env.WHATSAPP_BRIDGE_TOKEN || env.WA_HTTP_TOKEN);
  return Boolean(token && secretEqual(bearer(req), token));
}

function workerEventTokenAllowed(req, env = process.env) {
  const token = clean(env.ORKESTR_WA_WORKER_EVENT_TOKEN);
  return Boolean(token && secretEqual(bearer(req), token));
}

function legacyCompatibilityEnabled(env = process.env) {
  return !["0", "false", "no", "off"].includes(clean(env.ORKESTR_CONNECTORS_MCP_LEGACY_REST).toLowerCase());
}

function legacyPolicyChecks(req, url, body = {}) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/send-text" || url.pathname === "/send-media") {
    return { accounts: [body.accountId], recipients: [body.to || body.chatId], recipientScope: "send" };
  }
  if (url.pathname === "/chats" && req.method === "POST") {
    return { accounts: [body.senderAccountId || body.accountId, body.responderAccountId].filter(Boolean), recipients: body.participantIds || [], recipientScope: "createChat" };
  }
  const accountIndex = parts.indexOf("accounts");
  const accountId = accountIndex >= 0 ? decodeURIComponent(parts[accountIndex + 1] || "") : clean(url.searchParams.get("accountId"));
  const chatIndex = parts.indexOf("chats");
  const chatId = chatIndex >= 0 ? decodeURIComponent(parts[chatIndex + 1] || "") : "";
  const leaf = parts.at(-1) || "";
  return {
    accounts: accountId ? [accountId] : [],
    recipients: chatId ? [chatId] : [],
    ...(chatId ? { recipientScope: leaf === "history" || leaf === "participants" || leaf === "recover" ? "history" : "send" } : {}),
    pairing: ["start", "start-phone", "pairing-session", "reconnect"].includes(leaf),
    manageAccounts: ["logout", "disconnect"].includes(leaf),
  };
}

export function createConnectorsMcpGateway({ env = process.env, fetchImpl = fetch } = {}) {
  const host = listenHost(env);
  const allowedHosts = list(env.ORKESTR_CONNECTORS_MCP_ALLOWED_HOSTS || `${host},localhost,127.0.0.1`);
  const app = createMcpExpressApp({ host, allowedHosts });

  app.post("/mcp", async (req, res) => {
    if (!originAllowed(req, env)) return jsonError(res, 403, "connector_mcp_origin_denied");
    let auth;
    try {
      auth = await authorizeConnectorMcpRequest(req, env);
    } catch (error) {
      return jsonError(res, Number(error?.statusCode || 401), clean(error?.message) || "connector_mcp_unauthorized");
    }
    const server = createConnectorsMcpServer({ auth, request: req, env });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.once("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
    } catch (error) {
      if (!res.headersSent) jsonError(res, 500, clean(error?.message) || "connector_mcp_internal_error");
    }
  });
  app.get("/mcp", (_req, res) => jsonError(res, 405, "method_not_allowed"));
  app.delete("/mcp", (_req, res) => jsonError(res, 405, "method_not_allowed"));

  app.post("/internal/whatsapp/inbound", async (req, res) => {
    if (!workerEventTokenAllowed(req, env)) return res.status(401).json({ ok: false, error: "whatsapp_worker_event_token_invalid" });
    try {
      const result = await routeWhatsAppInboundFromWorker(req.body || {}, env, fetchImpl);
      return res.status(result.ok ? 200 : 202).json(result);
    } catch (error) {
      return res.status(Number(error?.statusCode || 500)).json({ ok: false, error: clean(error?.message) || "connector_inbound_failed" });
    }
  });

  app.get("/health", async (req, res) => {
    const token = bearer(req);
    let authorized = legacyTokenAllowed(req, env) || workerEventTokenAllowed(req, env);
    if (!authorized && token) authorized = await authorizeConnectorMcpToken(token, env).then(() => true, () => false);
    if (!authorized) return res.status(401).json({ ok: false, error: "connector_mcp_token_required" });
    const [worker, queued] = await Promise.all([
      whatsappWorkerHealth(env).catch((error) => ({ ok: false, state: "unavailable", error: clean(error?.message) })),
      listConnectorInboxEvents({ states: ["pending", "failed_retryable", "dead_letter"], limit: 1000 }, env).catch(() => []),
    ]);
    return res.json({
      ...worker,
      ok: worker.ok !== false,
      gateway: { ok: true, browserFree: true },
      worker: { ok: worker.ok !== false, state: worker.state || "", error: worker.error || "" },
      queue: {
        pending: queued.filter((item) => item.state === "pending").length,
        retryable: queued.filter((item) => item.state === "failed_retryable").length,
        deadLetter: queued.filter((item) => item.state === "dead_letter").length,
      },
    });
  });

  app.use(async (req, res, next) => {
    if (!legacyCompatibilityEnabled(env)) return next();
    if (!isLoopbackRequest(req)) return res.status(403).json({ ok: false, error: "legacy_wa_rest_loopback_only" });
    if (!legacyTokenAllowed(req, env)) return res.status(401).json({ ok: false, error: "unauthorized" });
    try {
      const url = new URL(req.originalUrl || req.url, "http://orkestr-connectors.local");
      requireWaServicePolicy(req, url, env, req.body || {}, legacyPolicyChecks(req, url, req.body || {}));
      const payload = await requestWhatsAppWorker(`${url.pathname}${url.search}`, {
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? null : req.body || {},
      }, env);
      return res.json(payload);
    } catch (error) {
      return res.status(Number(error?.statusCode || 502)).json({ ok: false, error: clean(error?.message) || "legacy_wa_proxy_failed" });
    }
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: "connector_mcp_route_not_found" }));

  const retryIntervalMs = Math.max(1000, Number(env.ORKESTR_CONNECTOR_INBOX_RETRY_INTERVAL_MS || 5000) || 5000);
  const retryTimer = setInterval(() => void retryConnectorInbox(env, fetchImpl).catch(() => {}), retryIntervalMs);
  retryTimer.unref?.();
  return { app, close: () => clearInterval(retryTimer) };
}

export async function runConnectorsMcpGateway(env = process.env) {
  const gateway = createConnectorsMcpGateway({ env });
  const server = gateway.app.listen(listenPort(env), listenHost(env), () => {
    console.log(`orkestr-connectors-mcp listening on ${listenHost(env)}:${listenPort(env)}`);
  });
  const shutdown = () => {
    gateway.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConnectorsMcpGateway().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
