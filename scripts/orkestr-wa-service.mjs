#!/usr/bin/env node
import http from "node:http";
import { URL } from "node:url";
import {
  createLocalWhatsAppChat,
  getLocalWhatsAppBridgeStatus,
  getLocalWhatsAppQrSvg,
  listLocalWhatsAppChatMessages,
  listLocalWhatsAppChats,
  listLocalWhatsAppChatParticipants,
  logoutLocalWhatsAppAccount,
  recoverLocalWhatsAppChatMessages,
  sendLocalWhatsAppMessage,
  startConfiguredLocalWhatsAppAccounts,
  startLocalWhatsAppAccount,
  stopLocalWhatsAppBridge,
} from "../packages/connectors/src/whatsapp-local-bridge.js";

function clean(value = "") {
  return String(value || "").trim();
}

function listenHost(env = process.env) {
  return clean(env.ORKESTR_WA_SERVICE_HOST || env.WA_HTTP_HOST || "127.0.0.1");
}

function listenPort(env = process.env) {
  const parsed = Number(env.ORKESTR_WA_SERVICE_PORT || env.WA_HTTP_PORT || 18914);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 18914;
}

function authToken(env = process.env) {
  return clean(
    env.ORKESTR_WA_SERVICE_TOKEN ||
    env.WHATSAPP_BRIDGE_TOKEN ||
    env.WA_HTTP_TOKEN ||
    env.ORKESTR_WHATSAPP_BRIDGE_TOKEN,
  );
}

function authDisabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(clean(env.ORKESTR_WA_SERVICE_AUTH_DISABLED).toLowerCase());
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid_json_body");
    error.statusCode = 400;
    throw error;
  }
}

function requireAuth(req, env) {
  if (authDisabled(env)) return true;
  const token = authToken(env);
  if (!token) {
    const error = new Error("wa_service_token_required");
    error.statusCode = 503;
    throw error;
  }
  if (clean(req.headers.authorization) !== `Bearer ${token}`) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  return true;
}

function publicAccount(account = {}) {
  return {
    id: clean(account.id || account.accountId),
    accountId: clean(account.accountId || account.id),
    label: clean(account.label || account.name || account.accountId || account.id),
    state: clean(account.state || account.status),
    ready: account.ready === true,
    authenticated: account.authenticated === true,
    started: account.started === true,
    qrAvailable: account.qrAvailable === true,
    qrUrl: clean(account.qrUrl),
    pairingCode: clean(account.pairingCode),
    pairingCodeUpdatedAt: clean(account.pairingCodeUpdatedAt),
    pairingPhoneNumber: clean(account.pairingPhoneNumber),
    phoneNumber: clean(account.phoneNumber),
    contactId: clean(account.contactId),
    pushName: clean(account.pushName),
    loadingPercent: account.loadingPercent ?? null,
    loadingMessage: clean(account.loadingMessage),
    error: clean(account.error),
    updatedAt: clean(account.updatedAt),
    runtimeAccountId: clean(account.runtimeAccountId || account.accountId || account.id),
    legacyRoleAliases: Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases.map(clean).filter(Boolean) : [],
  };
}

function publicHealth(status = {}) {
  const accounts = Array.isArray(status.accounts) ? status.accounts.map(publicAccount) : [];
  return {
    ok: status.ok !== false,
    mode: "local",
    state: clean(status.state || status.status),
    ready: status.ready === true,
    clientReady: status.clientReady === true,
    authenticated: status.authenticated === true,
    qrAvailable: status.qrAvailable === true,
    qrUrl: clean(status.qrUrl),
    maxAccounts: Number.isFinite(Number(status.maxAccounts)) ? Number(status.maxAccounts) : accounts.length,
    accounts,
    activeTypingCount: Number.isFinite(Number(status.activeTypingCount)) ? Number(status.activeTypingCount) : 0,
    activeTyping: Array.isArray(status.activeTyping) ? status.activeTyping : [],
    updatedAt: new Date().toISOString(),
  };
}

function maybeAccountId(url, fallback = "") {
  return clean(url.searchParams.get("accountId") || fallback);
}

function routeMatch(pathname, pattern) {
  const left = pathname.split("/").filter(Boolean);
  const right = pattern.split("/").filter(Boolean);
  if (left.length !== right.length) return null;
  const params = {};
  for (let index = 0; index < right.length; index += 1) {
    const expected = right[index];
    const actual = left[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

async function handleRequest(req, res, env = process.env) {
  const method = clean(req.method || "GET").toUpperCase();
  const url = new URL(req.url || "/", "http://orkestr-wa.local");
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    requireAuth(req, env);
    return json(res, 200, publicHealth(await getLocalWhatsAppBridgeStatus(env)));
  }
  if (method === "GET" && (url.pathname === "/accounts" || url.pathname === "/api/dashboard")) {
    requireAuth(req, env);
    const health = publicHealth(await getLocalWhatsAppBridgeStatus(env));
    return json(res, 200, { ok: true, state: health.state, accounts: health.accounts });
  }
  if (method === "GET" && url.pathname === "/qr.svg") {
    requireAuth(req, env);
    const svg = await getLocalWhatsAppQrSvg(maybeAccountId(url), env);
    if (!svg) return json(res, 404, { ok: false, error: "whatsapp_qr_not_available" });
    return sendText(res, 200, svg, "image/svg+xml; charset=utf-8");
  }

  let params = routeMatch(url.pathname, "/accounts/:accountId/start") ||
    routeMatch(url.pathname, "/accounts/:accountId/start-phone") ||
    routeMatch(url.pathname, "/accounts/:accountId/pairing-session") ||
    routeMatch(url.pathname, "/accounts/:accountId/reconnect");
  if (method === "POST" && params) {
    requireAuth(req, env);
    const body = await readJsonBody(req);
    const account = await startLocalWhatsAppAccount(params.accountId, env, {
      phoneNumber: clean(body.phoneNumber || body.phone),
      showNotification: body.showNotification !== false,
      intervalMs: Number(body.intervalMs || 0) || undefined,
      authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
    });
    return json(res, 202, { ok: true, account: publicAccount(account) });
  }

  params = routeMatch(url.pathname, "/accounts/:accountId/logout") ||
    routeMatch(url.pathname, "/accounts/:accountId/disconnect");
  if (method === "POST" && params) {
    requireAuth(req, env);
    return json(res, 200, { ok: true, account: publicAccount(await logoutLocalWhatsAppAccount(params.accountId, env)) });
  }

  params = routeMatch(url.pathname, "/accounts/:accountId/chats");
  if (method === "GET" && params) {
    requireAuth(req, env);
    return json(res, 200, await listLocalWhatsAppChats(params.accountId, env));
  }

  params = routeMatch(url.pathname, "/accounts/:accountId/chats/:chatId/history");
  if (method === "GET" && params) {
    requireAuth(req, env);
    return json(res, 200, await listLocalWhatsAppChatMessages({
      accountId: params.accountId,
      chatId: params.chatId,
      limit: Number(url.searchParams.get("limit") || 30) || 30,
      env,
    }));
  }

  params = routeMatch(url.pathname, "/accounts/:accountId/chats/:chatId/participants");
  if (method === "GET" && params) {
    requireAuth(req, env);
    return json(res, 200, await listLocalWhatsAppChatParticipants({
      accountId: params.accountId,
      chatId: params.chatId,
      env,
    }));
  }

  params = routeMatch(url.pathname, "/accounts/:accountId/chats/:chatId/recover");
  if (method === "POST" && params) {
    requireAuth(req, env);
    const body = await readJsonBody(req);
    return json(res, 200, await recoverLocalWhatsAppChatMessages({
      accountId: params.accountId,
      chatId: params.chatId,
      limit: Number(body.limit || 20) || 20,
      unreadOnly: body.unreadOnly !== false,
      markSeen: body.markSeen !== false,
      env,
    }));
  }

  params = routeMatch(url.pathname, "/api/chats/:chatId/history");
  if (method === "GET" && params) {
    requireAuth(req, env);
    return json(res, 200, await listLocalWhatsAppChatMessages({
      accountId: maybeAccountId(url),
      chatId: params.chatId,
      limit: Number(url.searchParams.get("limit") || 30) || 30,
      env,
    }));
  }

  params = routeMatch(url.pathname, "/api/chats/:chatId/meta");
  if (method === "GET" && params) {
    requireAuth(req, env);
    const payload = await listLocalWhatsAppChatParticipants({
      accountId: maybeAccountId(url),
      chatId: params.chatId,
      env,
    });
    return json(res, 200, { ...payload, ok: true, isGroup: /@g\.us$/i.test(params.chatId) });
  }

  if (method === "POST" && (url.pathname === "/send-text" || url.pathname === "/send-media")) {
    requireAuth(req, env);
    const body = await readJsonBody(req);
    const paths = Array.isArray(body.paths)
      ? body.paths.map(clean).filter(Boolean)
      : [clean(body.path)].filter(Boolean);
    return json(res, 200, await sendLocalWhatsAppMessage({
      accountId: clean(body.accountId),
      chatId: clean(body.to || body.chatId),
      text: clean(body.text),
      attachments: paths.map((filePath) => ({ path: filePath })),
      crossAccountEchoSuppression: body.crossAccountEchoSuppression !== false,
      env,
    }));
  }

  if (method === "POST" && url.pathname === "/chats") {
    requireAuth(req, env);
    const body = await readJsonBody(req);
    return json(res, 201, await createLocalWhatsAppChat({
      name: clean(body.name),
      senderAccountId: clean(body.senderAccountId || body.accountId),
      responderAccountId: clean(body.responderAccountId),
      participantIds: Array.isArray(body.participantIds) ? body.participantIds.map(clean).filter(Boolean) : [],
      adminParticipantIds: Array.isArray(body.adminParticipantIds) ? body.adminParticipantIds.map(clean).filter(Boolean) : [],
      promoteParticipantsAsAdmins: body.promoteParticipantsAsAdmins === true,
      generatePicture: body.generatePicture !== false,
      env,
    }));
  }

  return json(res, 404, { ok: false, error: "unsupported_wa_service_route" });
}

export function createOrkestrWaService({ env = process.env } = {}) {
  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, env);
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 500);
      json(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, {
        ok: false,
        error: clean(error?.message || String(error)) || "wa_service_error",
      });
    }
  });
}

async function main() {
  const env = process.env;
  const server = createOrkestrWaService({ env });
  const shutdown = async () => {
    server.close();
    await stopLocalWhatsAppBridge(env).catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await startConfiguredLocalWhatsAppAccounts(env).catch((error) => {
    console.error(`orkestr-wa autostart failed: ${error?.stack || error?.message || String(error)}`);
  });
  server.listen(listenPort(env), listenHost(env), () => {
    console.log(`orkestr-wa service listening on ${listenHost(env)}:${listenPort(env)}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
