#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import { URL } from "node:url";

function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value) {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function whatsappIdentityCandidates(value = "") {
  const text = clean(value).toLowerCase();
  if (!text) return [];
  const values = [text];
  const digits = text.replace(/[^\d]/g, "");
  if (digits) values.push(digits, `+${digits}`, `${digits}@c.us`);
  const contactMatch = text.match(/^(\d+)@(c\.us|lid)$/i);
  if (contactMatch?.[1]) values.push(contactMatch[1], `+${contactMatch[1]}`, `${contactMatch[1]}@${contactMatch[2].toLowerCase()}`);
  return unique(values);
}

function sameWhatsAppIdentity(left = "", right = "") {
  const leftValues = new Set(whatsappIdentityCandidates(left));
  return whatsappIdentityCandidates(right).some((value) => leftValues.has(value));
}

export function parentWhatsAppBridgePolicyFromEnv(env = process.env) {
  return {
    allowedAccounts: splitList(env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS || env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNT_IDS),
    allowedRecipients: splitList(env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_RECIPIENTS),
    allowedPhoneNumbers: splitList(env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_PHONE_NUMBERS || env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_NUMBERS),
    allowedChatIds: splitList(env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_CHAT_IDS || env.ORKESTR_PARENT_WA_BRIDGE_ALLOWED_CHATS),
    defaultAccount: clean(env.ORKESTR_PARENT_WA_BRIDGE_DEFAULT_ACCOUNT) || "responder",
  };
}

function policyEnabled(policy = {}) {
  return Boolean(
    policy.allowedAccounts?.length ||
    policy.allowedRecipients?.length ||
    policy.allowedPhoneNumbers?.length ||
    policy.allowedChatIds?.length
  );
}

function accountAllowed(policy = {}, accountId = "") {
  if (!policy.allowedAccounts?.length) return true;
  const account = clean(accountId || policy.defaultAccount || "").toLowerCase();
  return policy.allowedAccounts.some((allowed) => clean(allowed).toLowerCase() === account);
}

function recipientAllowed(policy = {}, chatId = "") {
  const allowed = [
    ...(policy.allowedRecipients || []),
    ...(policy.allowedPhoneNumbers || []),
    ...(policy.allowedChatIds || []),
  ];
  if (!allowed.length) return true;
  return allowed.some((value) => sameWhatsAppIdentity(value, chatId));
}

function policyError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

export function assertParentWhatsAppBridgeSendAllowed(payload = {}, policy = parentWhatsAppBridgePolicyFromEnv()) {
  if (!policyEnabled(policy)) return true;
  const accountId = clean(payload.accountId || policy.defaultAccount || "");
  const chatId = clean(payload.to || payload.chatId || "");
  if (!accountAllowed(policy, accountId)) throw policyError("parent_wa_bridge_account_denied");
  if (!recipientAllowed(policy, chatId)) throw policyError("parent_wa_bridge_recipient_denied");
  return true;
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function upstreamUrl(upstreamBase, pathname, search = "") {
  const url = new URL(upstreamBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${String(pathname || "").replace(/^\/+/, "")}`;
  url.search = search || "";
  return url;
}

function routeFor(req, { upstreamBase, defaultAccount }) {
  const url = new URL(req.url || "/", "http://orkestr-parent-wa-bridge.local");
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/health") return { method, url: upstreamUrl(upstreamBase, "/health", url.search) };
  if (method === "GET" && url.pathname === "/qr.svg") return { method, url: upstreamUrl(upstreamBase, "/qr.svg", url.search) };
  if (method === "GET" && url.pathname === "/api/dashboard") return { method, url: upstreamUrl(upstreamBase, "/accounts", url.search), dashboard: true };
  if (method === "POST" && url.pathname === "/send-text") return { method, url: upstreamUrl(upstreamBase, "/send-text"), send: true };
  if (method === "POST" && url.pathname === "/send-media") return { method, url: upstreamUrl(upstreamBase, "/send-media"), send: true };
  if (method === "POST" && url.pathname === "/chats") return { method, url: upstreamUrl(upstreamBase, "/chats") };
  const metaMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/meta$/);
  if (method === "GET" && metaMatch) {
    const accountId = url.searchParams.get("accountId") || defaultAccount;
    const chatId = decodeURIComponent(metaMatch[1]);
    return {
      method,
      url: upstreamUrl(upstreamBase, `/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/participants`),
      meta: true,
    };
  }
  const historyMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/history$/);
  if (method === "GET" && historyMatch) {
    const accountId = url.searchParams.get("accountId") || defaultAccount;
    const chatId = decodeURIComponent(historyMatch[1]);
    return {
      method,
      url: upstreamUrl(upstreamBase, `/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/history`, url.search),
    };
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function upstreamAuthHeaders(options = {}) {
  const headers = {};
  if (options.upstreamToken) headers.authorization = `Bearer ${options.upstreamToken}`;
  if (options.upstreamCookie) {
    headers.cookie = options.upstreamCookie.includes("=")
      ? options.upstreamCookie
      : `${options.upstreamCookieName}=${encodeURIComponent(options.upstreamCookie)}`;
    return headers;
  }
  if (headers.authorization || !options.upstreamCliAuthPath) return headers;
  try {
    const cliAuth = JSON.parse(await fs.readFile(options.upstreamCliAuthPath, "utf8"));
    const token = clean(cliAuth?.token);
    if (token && (!cliAuth?.expiresAt || Date.parse(cliAuth.expiresAt) > Date.now())) {
      headers.authorization = `Bearer ${token}`;
    }
  } catch {
    // Upstream auth remains best-effort; the upstream response explains failures.
  }
  return headers;
}

export function createParentWhatsAppBridgeProxy(options = {}) {
  const policy = options.policy || parentWhatsAppBridgePolicyFromEnv(options.env || process.env);
  const token = clean(options.token ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_TOKEN ?? process.env.ORKESTR_PARENT_WA_BRIDGE_TOKEN);
  const upstreamBase = clean(options.upstreamBase ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM ?? process.env.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM) ||
    "http://127.0.0.1:18912/api/connectors/whatsapp/bridge";
  const defaultAccount = clean(policy.defaultAccount) || "responder";
  return http.createServer(async (req, res) => {
    try {
      if (token && clean(req.headers.authorization) !== `Bearer ${token}`) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }
      const route = routeFor(req, { upstreamBase, defaultAccount });
      if (!route) return json(res, 404, { ok: false, error: "unsupported_whatsapp_bridge_route" });
      const body = ["POST", "PUT", "PATCH"].includes(route.method) ? await readBody(req) : undefined;
      if (route.send && body) assertParentWhatsAppBridgeSendAllowed(JSON.parse(body.toString("utf8") || "{}"), policy);
      const upstreamResponse = await fetch(route.url, {
        method: route.method,
        headers: {
          ...(body ? { "content-type": String(req.headers["content-type"] || "application/json") } : {}),
          ...(await upstreamAuthHeaders({
            upstreamToken: clean(options.upstreamToken ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_TOKEN ?? process.env.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_TOKEN),
            upstreamCookie: clean(options.upstreamCookie ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_COOKIE ?? process.env.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_COOKIE),
            upstreamCookieName: clean(options.upstreamCookieName ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_COOKIE_NAME ?? process.env.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_COOKIE_NAME) || "orkestr_session",
            upstreamCliAuthPath: clean(options.upstreamCliAuthPath ?? options.env?.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_CLI_AUTH_PATH ?? process.env.ORKESTR_PARENT_WA_BRIDGE_UPSTREAM_CLI_AUTH_PATH),
          })),
        },
        body,
      });
      const text = await upstreamResponse.text();
      let output = text;
      let contentType = upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8";
      if (route.dashboard || route.meta) {
        const payload = text ? JSON.parse(text) : {};
        output = route.dashboard
          ? JSON.stringify({ ok: upstreamResponse.ok, accounts: payload.accounts || [], state: payload.state || "" })
          : JSON.stringify({ ok: upstreamResponse.ok, chatId: payload.chatId || "", isGroup: true, participants: payload.participants || [] });
        contentType = "application/json; charset=utf-8";
      }
      res.writeHead(upstreamResponse.status, { "content-type": contentType, "cache-control": "no-store" });
      res.end(output);
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 502);
      json(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 502, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const listenHost = clean(env.ORKESTR_PARENT_WA_BRIDGE_LISTEN_HOST) || "10.42.0.1";
  const listenPort = Number(env.ORKESTR_PARENT_WA_BRIDGE_LISTEN_PORT || 18913);
  createParentWhatsAppBridgeProxy({ env }).listen(listenPort, listenHost, () => {
    console.log(`parent WhatsApp bridge proxy listening on ${listenHost}:${listenPort}`);
  });
}
