import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { canonicalThreadLink, explicitCanonicalAppBase } from "../../../packages/core/src/canonical-app-links.js";
import { desktopShareBaseDomain } from "../../../packages/core/src/desktop-share-http.js";
import { readInstanceIdentity } from "../../../packages/core/src/instance-identity.js";
import { assertResourceAccess } from "../../../packages/core/src/policy.js";
import { listThreads } from "../../../packages/core/src/threads.js";

function enabled(value = ""): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

function explicitBase(value = ""): string {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const parsed = new URL(source);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return "";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function hostBoundariesEnabled(env = process.env): boolean {
  return enabled(env.ORKESTR_HOST_BOUNDARIES);
}

export function configuredHostBoundaries(env = process.env) {
  return {
    appBase: explicitCanonicalAppBase(env),
    connectBase: explicitBase(env.ORKESTR_CONNECT_PUBLIC_URL || env.ORKESTR_CONNECT_PUBLIC_BASE_URL),
    authBase: explicitBase(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_URL),
  };
}

function remoteAddress(request: any): string {
  return String(request?.socket?.remoteAddress || request?.connection?.remoteAddress || "")
    .trim()
    .replace(/^::ffff:/, "");
}

function loopback(value = ""): boolean {
  const address = String(value || "").trim().replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function directHostIsLoopback(request: any): boolean {
  const host = singleHeader(request?.headers?.host);
  if (!host) return false;
  try { return loopback(new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "")); } catch { return false; }
}

function trustedProxy(request: any, env = process.env): boolean {
  if (!enabled(env.ORKESTR_TRUST_PROXY_HEADERS || env.ORKESTR_TRUST_PROXY)) return false;
  const remote = remoteAddress(request);
  const allowed = String(env.ORKESTR_TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((item) => item.trim().replace(/^::ffff:/, ""))
    .filter(Boolean);
  return allowed.includes(remote);
}

export function sanitizeForwardedHostHeaders(request: any, env = process.env): void {
  if (!hostBoundariesEnabled(env)) return;
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") return;
  if (!trustedProxy(request, env)) {
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    return;
  }
  const origin = effectiveRequestOrigin(request, env);
  if (!origin) {
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    return;
  }
  const parsed = new URL(origin);
  headers["x-forwarded-host"] = parsed.host;
  headers["x-forwarded-proto"] = parsed.protocol.replace(/:$/, "");
}

function singleHeader(value: unknown): string {
  const text = String(value || "").trim();
  return text && !text.includes(",") && !/[\s/?#\\]/.test(text) ? text : "";
}

function protocol(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/:$/, "");
  return normalized === "http" || normalized === "https" ? normalized : "";
}

export function effectiveRequestOrigin(request: any, env = process.env): string {
  const useForwarded = trustedProxy(request, env);
  const forwardedHost = useForwarded ? singleHeader(request?.headers?.["x-forwarded-host"]) : "";
  const host = forwardedHost || singleHeader(request?.headers?.host);
  const forwardedProto = useForwarded ? protocol(request?.headers?.["x-forwarded-proto"]) : "";
  const directProto = protocol(request?.protocol || (request?.socket?.encrypted ? "https" : "http"));
  if (!host || !(forwardedProto || directProto)) return "";
  try {
    return new URL(`${forwardedProto || directProto}://${host}`).origin;
  } catch {
    return "";
  }
}

function pathParts(rawUrl = ""): string[] {
  try {
    return new URL(rawUrl || "/", "http://orkestr.local").pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
}

export function legacyThreadRoute(rawUrl = "") {
  const parsed = new URL(rawUrl || "/", "http://orkestr.local");
  const parts = pathParts(rawUrl);
  const offset = parts[0] === "ng" ? 1 : 0;
  if (parts[offset] !== "thread" || !parts[offset + 1]) return null;
  return {
    selector: parts[offset + 1],
    suffix: parts.slice(offset + 2),
    search: parsed.search,
  };
}

function handoffPath(rawUrl = ""): boolean {
  const pathname = new URL(rawUrl || "/", "http://orkestr.local").pathname;
  return pathname === "/setup" || pathname.startsWith("/setup/") ||
    pathname.startsWith("/connect/") || pathname.startsWith("/oauth/") ||
    pathname === "/review/google" || pathname.startsWith("/review/google/") ||
    pathname.startsWith("/google-marketing/oauth/");
}

function connectSupportPath(method = "GET", rawUrl = ""): boolean {
  const verb = String(method || "GET").trim().toUpperCase();
  const pathname = new URL(rawUrl || "/", "http://orkestr.local").pathname;
  if (verb === "GET" && pathname === "/") return true;
  if (verb === "GET" && /^\/(?:main|polyfills)(?:\.[A-Za-z0-9_-]+)?\.js$/.test(pathname)) return true;
  if (verb === "GET" && /^\/styles(?:\.[A-Za-z0-9_-]+)?\.css$/.test(pathname)) return true;
  if (verb === "GET" && pathname === "/favicon.svg") return true;
  if (verb === "GET" && [
    "/api/version",
    "/api/setup/status",
    "/api/health",
    "/api/ready",
    "/api/setup/security/status",
    "/api/setup/security/session-scope",
  ].includes(pathname)) return true;
  if (verb === "POST" && [
    "/api/setup/security/challenge",
    "/api/setup/security/challenges",
    "/api/setup/security/pair",
  ].includes(pathname)) return true;
  if (verb === "GET" && /^\/api\/setup\/security\/challenges\/[^/]+$/.test(pathname)) return true;
  if (verb === "GET" && pathname === "/api/connectors/gmail/oauth/start") return true;
  if (verb === "POST" && (
    pathname === "/api/broker/instances/register" ||
    /^\/api\/broker\/instances\/[^/]+\/heartbeat$/.test(pathname) ||
    /^\/api\/broker\/instances\/[^/]+\/whatsapp\/(?:onboarding|history)$/.test(pathname) ||
    /^\/api\/broker\/instances\/[^/]+\/google-workspace\/(?:connect-link|refresh-token)$/.test(pathname) ||
    pathname === "/api/broker/google-workspace/grants"
  )) return true;
  return false;
}

function canonicalPath(rawUrl = ""): boolean {
  return pathParts(rawUrl)[0] === "instance";
}

function compatibilityPath(rawUrl = ""): boolean {
  const parts = pathParts(rawUrl);
  return parts[0] === "i" && Boolean(parts[1]) && (
    parts[2] === "app" ||
    (parts[2] === "setup" && parts.length === 3) ||
    (parts[2] === "a" && Boolean(parts[3]) && parts[4] === "s")
  );
}

function desktopSharePath(method = "GET", rawUrl = ""): boolean {
  if (String(method || "GET").trim().toUpperCase() !== "GET") return false;
  const pathname = new URL(rawUrl || "/", "http://orkestr.local").pathname;
  return /^\/desktop-share\/[^/]+(?:\/[^/]+)?$/.test(pathname) ||
    /^\/api\/desktop-shares\/[^/]+\/(?:open|status)$/.test(pathname) ||
    /^\/desktop\/[^/]+(?:\/|$)/.test(pathname);
}

function desktopShareOrigin(origin = "", env = process.env): boolean {
  const domain = desktopShareBaseDomain(env);
  if (!origin || !domain) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const suffix = `.${domain}`;
    if (!hostname.endsWith(suffix)) return false;
    const label = hostname.slice(0, -suffix.length);
    return Boolean(label) && !label.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  } catch {
    return false;
  }
}

function localProbeRequest(request: any): boolean {
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return method === "GET" && directLoopbackRequest(request) &&
    ["/api/health", "/api/ready", "/api/version", "/metrics", "/api/metrics"].includes(pathname);
}

function directLoopbackRequest(request: any): boolean {
  return loopback(remoteAddress(request)) && directHostIsLoopback(request);
}

function localCliRequest(request: any): boolean {
  return directLoopbackRequest(request) && request?.orkestrMachineAuth === "cli";
}

function localWhatsAppInboundRequest(request: any): boolean {
  if (!directLoopbackRequest(request) || request?.orkestrMachineAuth !== "whatsapp_inbound") return false;
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return method === "POST" && [
    "/api/connectors/whatsapp/inbound",
    "/api/connectors/whatsapp/inbound-media",
  ].includes(pathname);
}

function localWhatsAppBridgeSendRequest(request: any): boolean {
  if (!directLoopbackRequest(request) || request?.orkestrMachineAuth !== "whatsapp_bridge") return false;
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return method === "POST" && [
    "/api/connectors/whatsapp/bridge/send-text",
    "/api/connectors/whatsapp/bridge/send-media",
  ].includes(pathname);
}

function localMailboxMtaRequest(request: any): boolean {
  if (!directLoopbackRequest(request) || request?.orkestrMachineAuth !== "mailbox_mta") return false;
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return (method === "GET" && pathname === "/api/mailboxes/lookup") ||
    (method === "POST" && pathname === "/api/mailboxes/ingest-spool");
}

function localMailboxVmRelayRequest(request: any): boolean {
  if (!directLoopbackRequest(request) || request?.orkestrMachineAuth !== "mailbox_vm_relay") return false;
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return method === "POST" && pathname === "/api/mailboxes/relay-inbound";
}

function localVagentRequest(request: any): boolean {
  if (!directLoopbackRequest(request) || request?.orkestrMachineAuth !== "vagent") return false;
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local").pathname;
  return method === "POST" && pathname === "/api/integrations/vagent";
}

function targetAtBase(base: string, rawUrl: string): string {
  if (!base) return "";
  const source = new URL(rawUrl || "/", "http://orkestr.local");
  const target = new URL(base);
  target.pathname = source.pathname;
  target.search = source.search;
  return target.toString();
}

async function legacyCanonicalTarget(request: any, rawUrl: string, env = process.env): Promise<string> {
  const route = legacyThreadRoute(rawUrl);
  if (!route) return "";
  const threads = await listThreads(env).catch(() => []);
  const matches = threads.filter((thread: any) =>
    [thread.id, thread.name, thread.bindingName].filter(Boolean).some((value) => String(value) === route.selector),
  );
  if (matches.length !== 1 || !matches[0]?.publicRef) return "";
  try { assertResourceAccess(request?.orkestrPrincipal || {}, matches[0], "thread_access", env); } catch { return ""; }
  const identity = await readInstanceIdentity(env).catch(() => null);
  if (!identity?.publicRef) return "";
  return canonicalThreadLink(matches[0], env, {
    instanceIdentity: identity,
    sourceUrl: `/thread/${encodeURIComponent(route.selector)}/${route.suffix.map(encodeURIComponent).join("/")}${route.search}`,
  });
}

function uniformNotFound(response: any): void {
  response.status(404).header("cache-control", "no-store").type("text/plain; charset=utf-8").send("not found");
}

function recordDenial(reason: string, env = process.env): void {
  void appendEvent({ type: "host_boundary_denied", reason }, env).catch(() => {});
}

function redirect(response: any, location: string): void {
  response.status(308).header("cache-control", "no-store").header("location", location).send("Redirecting.");
}

function allowedBoundaryOrigins(env = process.env) {
  const boundaries = configuredHostBoundaries(env);
  const appOrigin = boundaries.appBase ? new URL(boundaries.appBase).origin : "";
  const connectOrigins = new Set([boundaries.connectBase, boundaries.authBase]
    .filter(Boolean)
    .map((value) => new URL(value).origin));
  return { boundaries, appOrigin, connectOrigins };
}

export function rejectUnknownHostBoundaryRequest(request: any, response: any, env = process.env): boolean {
  if (!hostBoundariesEnabled(env)) return false;
  // Authentication runs after this early host filter. Let direct loopback
  // traffic reach it, then require the verified CLI machine principal below.
  if (directLoopbackRequest(request)) return false;
  const origin = effectiveRequestOrigin(request, env);
  const rawUrl = String(request?.originalUrl || request?.url || "/");
  if (desktopShareOrigin(origin, env) && desktopSharePath(request?.method, rawUrl)) return false;
  const { appOrigin, connectOrigins } = allowedBoundaryOrigins(env);
  if (origin && appOrigin && connectOrigins.size && !connectOrigins.has(appOrigin) && origin === appOrigin) return false;
  if (origin && appOrigin && connectOrigins.size && !connectOrigins.has(appOrigin) && connectOrigins.has(origin)) {
    if (compatibilityPath(rawUrl) || handoffPath(rawUrl) || connectSupportPath(request?.method, rawUrl) ||
        canonicalPath(rawUrl) || legacyThreadRoute(rawUrl)) return false;
  }
  recordDenial(!origin || !appOrigin || !connectOrigins.size || connectOrigins.has(appOrigin)
    ? "invalid_host_or_config"
    : "wrong_host", env);
  uniformNotFound(response);
  return true;
}

export async function enforceHostBoundaryRequest(request: any, response: any, env = process.env): Promise<boolean> {
  if (!hostBoundariesEnabled(env)) return false;
  if (
    localProbeRequest(request) ||
    localCliRequest(request) ||
    localWhatsAppInboundRequest(request) ||
    localWhatsAppBridgeSendRequest(request) ||
    localMailboxMtaRequest(request) ||
    localMailboxVmRelayRequest(request) ||
    localVagentRequest(request)
  ) return false;
  const rawUrl = String(request?.originalUrl || request?.url || "/");
  const origin = effectiveRequestOrigin(request, env);
  const { boundaries, appOrigin, connectOrigins } = allowedBoundaryOrigins(env);

  if (desktopShareOrigin(origin, env) && desktopSharePath(request?.method, rawUrl)) return false;

  if (!origin || !appOrigin || !connectOrigins.size || connectOrigins.has(appOrigin)) {
    recordDenial("invalid_host_or_config", env);
    uniformNotFound(response);
    return true;
  }

  if (compatibilityPath(rawUrl)) {
    if (origin === appOrigin || connectOrigins.has(origin)) return false;
    recordDenial("wrong_host", env);
    uniformNotFound(response);
    return true;
  }

  if (handoffPath(rawUrl)) {
    if (origin === appOrigin) {
      const base = boundaries.connectBase || boundaries.authBase;
      if (base && origin !== new URL(base).origin) { redirect(response, targetAtBase(base, rawUrl)); return true; }
    }
    if (connectOrigins.has(origin)) return false;
    recordDenial("wrong_host", env);
    uniformNotFound(response);
    return true;
  }

  if (connectOrigins.has(origin) && connectSupportPath(request?.method, rawUrl)) return false;

  if (canonicalPath(rawUrl)) {
    if (origin === appOrigin) return false;
    if (origin && connectOrigins.has(origin) && boundaries.appBase) {
      redirect(response, targetAtBase(boundaries.appBase, rawUrl));
    } else { recordDenial("wrong_host", env); uniformNotFound(response); }
    return true;
  }

  if (legacyThreadRoute(rawUrl)) {
    if (origin !== appOrigin && !connectOrigins.has(origin)) {
      recordDenial("wrong_host", env);
      uniformNotFound(response);
      return true;
    }
    const target = await legacyCanonicalTarget(request, rawUrl, env);
    if (!target) { recordDenial("legacy_unresolved", env); uniformNotFound(response); } else redirect(response, target);
    return true;
  }


  if (connectOrigins.has(origin) || origin !== appOrigin) {
    recordDenial("wrong_host", env);
    uniformNotFound(response);
    return true;
  }

  return false;
}

const internalUpgradeToken = randomBytes(32).toString("base64url");
const upgradeDeniedMarker = Symbol("orkestrHostBoundaryUpgradeDenied");

function validInternalUpgrade(request: any): boolean {
  if (!loopback(remoteAddress(request))) return false;
  const supplied = String(request?.headers?.["x-orkestr-internal-canonical-upgrade"] || "");
  const expected = internalUpgradeToken;
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function internalCanonicalUpgradeHeader(): string {
  return internalUpgradeToken;
}

export function hostBoundaryUpgradeDenied(request: any): boolean {
  return request?.[upgradeDeniedMarker] === true;
}

function denyUpgrade(request: any, socket: Duplex): void {
  request[upgradeDeniedMarker] = true;
  socket.end(
    "HTTP/1.1 404 Not Found\r\n" +
    "Connection: close\r\n" +
    "Cache-Control: no-store\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Content-Length: 9\r\n\r\n" +
    "not found",
  );
}

export function attachHostBoundaryUpgrade(server: Server, env = process.env): void {
  if (!hostBoundariesEnabled(env)) return;
  server.prependListener("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sanitizeForwardedHostHeaders(request, env);
    if (validInternalUpgrade(request)) return;
    const origin = effectiveRequestOrigin(request, env);
    const { appOrigin, connectOrigins } = allowedBoundaryOrigins(env);
    const rawUrl = String(request.url || "/");
    const configured = Boolean(origin && appOrigin && connectOrigins.size && !connectOrigins.has(appOrigin));
    const allowed = configured && (
      origin === appOrigin ||
      (connectOrigins.has(origin) && compatibilityPath(rawUrl)) ||
      (desktopShareOrigin(origin, env) && desktopSharePath(request.method, rawUrl))
    );
    if (allowed) return;
    recordDenial(configured ? "wrong_host" : "invalid_host_or_config", env);
    denyUpgrade(request, socket);
  });
}
