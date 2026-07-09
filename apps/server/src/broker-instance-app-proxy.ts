import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { startGmailOAuth } from "../../../packages/connectors/src/gmail.js";
import { googleWorkspaceBrokeredConnectorSetupPath } from "../../../packages/connectors/src/google-workspace.js";
import { encryptBrokerInstanceProxyPayload, resolveBrokerConnectInstance } from "../../../packages/core/src/broker-instance-registry.js";
import { securityCookieName, securitySessionForToken } from "../../../packages/core/src/security.js";
import { listTenantVms } from "../../../packages/core/src/tenant-vm-registry.js";
import { getUser } from "../../../packages/core/src/users.js";
import { instanceSetupReturnPath } from "./instance-connect-setup.js";

type BrokerAppRoute = {
  instanceId: string;
  upstreamPath: string;
  prefixPath: string;
  exactWithoutSlash: boolean;
};

type BrokerAppTarget = BrokerAppRoute & {
  baseUrl: URL;
};

function normalizeProxyBaseUrl(value = ""): URL | null {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeSegment(value = ""): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeSegment(value = ""): string {
  return encodeURIComponent(decodeSegment(value).trim());
}

function brokerRequestUrl(request: any): string {
  const original = String(request?.originalUrl || "");
  if (original) return original;
  const mounted = String(request?.url || "/");
  return mounted.startsWith("/i/") ? mounted : `/i${mounted.startsWith("/") ? "" : "/"}${mounted}`;
}

function parseBrokerAppUrl(rawUrl: string | undefined): BrokerAppRoute | null {
  const parsed = new URL(String(rawUrl || "/"), "http://orkestr.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  const mounted = parts[0] !== "i" && parts[1] === "app";
  if (!mounted && (parts[0] !== "i" || !parts[1] || parts[2] !== "app")) return null;
  const instanceId = decodeSegment(mounted ? parts[0] : parts[1]).trim();
  if (!instanceId) return null;
  const restParts = parts.slice(mounted ? 2 : 3).map(safeSegment);
  const upstreamPath = `/${restParts.join("/")}${parsed.search}`;
  const prefixPath = `/i/${encodeURIComponent(instanceId)}/app/`;
  return {
    instanceId,
    upstreamPath,
    prefixPath,
    exactWithoutSlash: restParts.length === 0 && !parsed.pathname.endsWith("/"),
  };
}

async function brokerAppTarget(rawUrl: string | undefined): Promise<BrokerAppTarget | null> {
  const route = parseBrokerAppUrl(rawUrl);
  if (!route) return null;
  const result = await resolveBrokerConnectInstance(route.instanceId, process.env);
  const baseUrl = normalizeProxyBaseUrl(result.instance?.endpointBaseUrl || "");
  if (!baseUrl) {
    const error = new Error("broker_instance_endpoint_unavailable");
    Object.assign(error, { statusCode: 503 });
    throw error;
  }
  return { ...route, baseUrl };
}

function sendPlain(response: any, statusCode: number, message: string): void {
  if (typeof response.status === "function") {
    response.status(statusCode).type("text/plain; charset=utf-8").send(message);
    return;
  }
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function sendJson(response: any, statusCode: number, body: Record<string, unknown>): void {
  response
    .status(statusCode)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(JSON.stringify(body));
}

function redirect(response: any, location: string, message = "Redirecting."): void {
  response
    .status(302)
    .header("cache-control", "no-store")
    .header("location", location)
    .type("text/plain; charset=utf-8")
    .send(message);
}

function brokerAppApiRequest(route: BrokerAppRoute): boolean {
  return route.upstreamPath === "/api" || route.upstreamPath.startsWith("/api/") || route.upstreamPath.startsWith("/api?");
}

function canonicalBrokerGoogleWorkspaceConnectorPath(route: BrokerAppRoute): string {
  const parsed = new URL(route.upstreamPath || "/", "http://tenant.local");
  if (parsed.pathname !== "/connect/google") return "";
  const connectId = clean(parsed.searchParams.get("connect") || parsed.searchParams.get("connect_id"));
  if (!connectId) return "";
  return googleWorkspaceBrokeredConnectorSetupPath({
    instanceId: route.instanceId,
    connectId,
    brokerTenantUserId: parsed.searchParams.get("user_id") || parsed.searchParams.get("user") || "",
    brokerTenantThreadName: parsed.searchParams.get("thread") || "",
  }, "gmail");
}

function pairingRedirectUrl(request: any, route: BrokerAppRoute, requestUrl = ""): string {
  const canonicalPath = canonicalBrokerGoogleWorkspaceConnectorPath(route);
  const target = new URL("/setup/pairing", "http://localhost");
  target.searchParams.set("instanceId", route.instanceId);
  target.searchParams.set("return", instanceSetupReturnPath(
    route.instanceId,
    canonicalPath || String(requestUrl || request.originalUrl || request.url || route.prefixPath),
  ));
  return `${target.pathname}${target.search}`;
}

function requestHasInstanceSession(request: any, instanceId: string): boolean {
  const session = request?.orkestrSecuritySession;
  return Boolean(session && String(session.instanceId || "") === instanceId);
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function stringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,]+/g);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const text = clean(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function authIntentAllowsGoogleConnect(session: any, instanceId: string): boolean {
  if (!session || clean(session.instanceId) !== instanceId) return false;
  const intent = session.authIntent && typeof session.authIntent === "object" ? session.authIntent : {};
  const allowedActions = Array.isArray(session.allowedActions) ? session.allowedActions : [];
  return clean(intent.service).toLowerCase() === "gmail" &&
    clean(intent.provider).toLowerCase() === "google_workspace" &&
    clean(intent.action).toLowerCase() === "connect" &&
    allowedActions.some((action: string) => /^orkestr_auth\.google\.connect(?::|$)/.test(clean(action)));
}

function brokerGoogleWorkspaceStartRequest(request: any, route: BrokerAppRoute): URL | null {
  if (String(request?.method || "GET").toUpperCase() !== "GET") return null;
  const parsed = new URL(route.upstreamPath || "/", "http://tenant.local");
  return parsed.pathname === "/api/connectors/gmail/oauth/start" ? parsed : null;
}

async function handleBrokerGoogleWorkspaceStart(request: any, response: any, route: BrokerAppRoute): Promise<boolean> {
  const parsed = brokerGoogleWorkspaceStartRequest(request, route);
  if (!parsed) return false;
  const session = request?.orkestrSecuritySession || null;
  if (!authIntentAllowsGoogleConnect(session, route.instanceId)) return false;
  const intent = session.authIntent && typeof session.authIntent === "object" ? session.authIntent : {};
  const owner = await ownerUserForBrokerInstance(route.instanceId);
  const userId = clean(owner.userId || intent.userId || session.userId);
  const account = clean(parsed.searchParams.get("account") || intent.account).toLowerCase();
  const capabilities = stringArray(parsed.searchParams.getAll("capability").length
    ? parsed.searchParams.getAll("capability")
    : parsed.searchParams.get("capabilities") || "gmail_read");
  const connectId = clean(intent.connectId || session.challengeId || session.id) || randomUUID();
  try {
    const threadId = clean(intent.threadId);
    const chatId = clean(intent.chatId);
    const accountId = clean(intent.accountId);
    const started = await startGmailOAuth(process.env, {
      userId,
      provider: "google_workspace",
      capabilities,
      account,
      connectId,
      threadId,
      chatId,
      accountId,
      brokerInstanceId: route.instanceId,
      brokerTenantVmId: clean(intent.tenantVmId),
      brokerTenantUserId: userId,
      brokerTenantThreadId: threadId,
      brokerTenantChatId: chatId,
      brokerTenantAccountId: accountId,
    });
    sendJson(response, 200, {
      ...started,
      ok: true,
      provider: "google_workspace",
      connectId,
    });
  } catch (error) {
    sendJson(response, Number((error as any)?.statusCode || 400) || 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

function targetPort(baseUrl: URL): number {
  if (baseUrl.port) return Number(baseUrl.port);
  return baseUrl.protocol === "https:" ? 443 : 80;
}

function htmlNeedsRewrite(headers: http.IncomingHttpHeaders): boolean {
  return String(headers["content-type"] || "").toLowerCase().includes("text/html");
}

function rewriteHtmlForBrokerApp(body: Buffer, prefixPath: string): string {
  const base = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  return body.toString("utf8")
    .replace(/<base\s+href=(["'])\/\1\s*\/?>/i, `<base href="${base}" />`)
    .replace(/\s(href|src)=(["'])\/favicon\.svg\2/g, ` $1=$2${base}favicon.svg$2`);
}

function rewriteLocationHeader(value: unknown, target: BrokerAppTarget): unknown {
  if (!value || Array.isArray(value)) return value;
  const raw = String(value);
  try {
    const parsed = new URL(raw, target.baseUrl);
    const targetOrigin = `${target.baseUrl.protocol}//${target.baseUrl.host}`;
    const parsedOrigin = `${parsed.protocol}//${parsed.host}`;
    if (raw.startsWith("/") || parsedOrigin === targetOrigin) {
      const prefix = target.prefixPath.replace(/\/+$/, "");
      return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return value;
  }
  return value;
}

function responseHeaders(headers: http.IncomingHttpHeaders, target: BrokerAppTarget, rewritingHtml = false): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  if (headers.location) next.location = rewriteLocationHeader(headers.location, target) as any;
  delete next.connection;
  if (rewritingHtml) {
    delete next["content-length"];
    delete next["content-encoding"];
  }
  return next;
}

function encodeBrokerAuthHeader(body: unknown): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

async function brokerProxyAuthHeader(request: any, target: BrokerAppTarget): Promise<string> {
  const session = request?.orkestrSecuritySession || {};
  const tenantOwner = await ownerUserForBrokerInstance(target.instanceId);
  const userId = tenantOwner.userId || String(session.userId || "");
  const role = tenantOwner.userId ? "user" : String(session.role || "");
  const displayName = tenantOwner.displayName || String(session.displayName || "");
  const now = Date.now();
  const assertion = await encryptBrokerInstanceProxyPayload(target.instanceId, {
    kind: "broker_app_proxy",
    instanceId: target.instanceId,
    method: String(request?.method || "GET").toUpperCase(),
    path: target.upstreamPath || "/",
    userId,
    role,
    displayName,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  }, process.env);
  return encodeBrokerAuthHeader(assertion.body);
}

async function ownerUserForBrokerInstance(instanceId = ""): Promise<{ userId: string; displayName: string }> {
  const id = String(instanceId || "").trim();
  if (!id) return { userId: "", displayName: "" };
  const vms = await listTenantVms(process.env).catch(() => []);
  const vm = vms.find((item: any) =>
    String(item?.labels?.brokerInstanceId || item?.labels?.instanceId || "").trim() === id ||
    String(item?.endpoint?.brokerInstanceId || "").trim() === id,
  );
  const userId = String(vm?.ownerUserId || "").trim();
  if (!userId) return { userId: "", displayName: "" };
  const user = await getUser(userId, process.env).catch(() => null);
  return { userId, displayName: String(user?.displayName || userId).trim() };
}

async function proxyBrokerAppHttp(request: any, response: any): Promise<void> {
  const requestUrl = brokerRequestUrl(request);
  const route = parseBrokerAppUrl(requestUrl);
  if (!route) {
    sendPlain(response, 404, "broker app route not found");
    return;
  }
  if (route.exactWithoutSlash) {
    const parsed = new URL(requestUrl, "http://orkestr.local");
    redirect(response, `${route.prefixPath}${parsed.search}`, "Redirecting to Orkestr VM WebUI.");
    return;
  }
  const canonicalGoogleConnectorPath = canonicalBrokerGoogleWorkspaceConnectorPath(route);
  if (canonicalGoogleConnectorPath) {
    redirect(response, canonicalGoogleConnectorPath, "Redirecting to the Orkestr instance connector page.");
    return;
  }
  if (!requestHasInstanceSession(request, route.instanceId)) {
    if (brokerAppApiRequest(route)) {
      sendPlain(response, 401, "broker_instance_pairing_required");
      return;
    }
    redirect(response, pairingRedirectUrl(request, route, requestUrl), "Redirecting to Orkestr pairing.");
    return;
  }
  if (await handleBrokerGoogleWorkspaceStart(request, response, route)) return;

  let target: BrokerAppTarget | null = null;
  try {
    target = await brokerAppTarget(requestUrl);
  } catch (error) {
    sendPlain(response, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
    return;
  }
  if (!target) {
    sendPlain(response, 404, "broker app route not found");
    return;
  }
  let brokerAuth = "";
  try {
    brokerAuth = await brokerProxyAuthHeader(request, target);
  } catch (error) {
    sendPlain(response, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
    return;
  }

  const headers = {
    ...request.headers,
    host: target.baseUrl.host,
    "accept-encoding": "identity",
    "x-forwarded-host": request.headers?.["x-forwarded-host"] || request.headers?.host || "",
    "x-forwarded-proto": request.headers?.["x-forwarded-proto"] || request.protocol || "https",
    "x-forwarded-prefix": target.prefixPath.replace(/\/+$/, ""),
    "x-orkestr-broker-instance-id": target.instanceId,
    "x-orkestr-broker-auth": brokerAuth,
  };
  delete (headers as Record<string, unknown>).connection;
  delete (headers as Record<string, unknown>).upgrade;
  const client = target.baseUrl.protocol === "https:" ? https : http;
  const upstream = client.request({
    host: target.baseUrl.hostname,
    port: targetPort(target.baseUrl),
    method: request.method,
    path: target.upstreamPath,
    headers,
  }, (upstreamResponse) => {
    if (!htmlNeedsRewrite(upstreamResponse.headers)) {
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers, target));
      upstreamResponse.pipe(response);
      return;
    }
    const chunks: Buffer[] = [];
    upstreamResponse.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    upstreamResponse.on("end", () => {
      const body = rewriteHtmlForBrokerApp(Buffer.concat(chunks), target.prefixPath);
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers, target, true));
      response.end(body);
    });
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      sendPlain(response, 502, error.message || "broker_instance_app_proxy_failed");
      return;
    }
    response.end();
  });
  request.pipe(upstream);
}

function cookieValue(header: string, name: string): string {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

async function upgradeHasInstanceSession(request: IncomingMessage, instanceId: string): Promise<boolean> {
  const token = cookieValue(String(request.headers.cookie || ""), securityCookieName());
  const session = await securitySessionForToken(token, process.env, { request, touch: false }).catch(() => null);
  return Boolean(session && String(session.instanceId || "") === instanceId);
}

function rawUpgradeHeaders(request: IncomingMessage, target: BrokerAppTarget, brokerAuth = ""): string {
  const lines = [`${request.method || "GET"} ${target.upstreamPath} HTTP/${request.httpVersion || "1.1"}`];
  let sawHost = false;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] || "";
    const value = request.rawHeaders[index + 1] || "";
    const lowered = name.toLowerCase();
    if (lowered === "host") {
      sawHost = true;
      lines.push(`Host: ${target.baseUrl.host}`);
    } else if (["x-forwarded-prefix", "x-orkestr-broker-instance-id", "x-orkestr-broker-auth"].includes(lowered)) {
      continue;
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!sawHost) lines.push(`Host: ${target.baseUrl.host}`);
  lines.push(`X-Forwarded-Prefix: ${target.prefixPath.replace(/\/+$/, "")}`);
  lines.push(`X-Orkestr-Broker-Instance-Id: ${target.instanceId}`);
  if (brokerAuth) lines.push(`X-Orkestr-Broker-Auth: ${brokerAuth}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Gateway"}\r\n`);
  socket.write("Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n");
  socket.write(message);
  socket.destroy();
}

export function registerBrokerInstanceAppProxy(app: INestApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use("/i", (request: any, response: any, next: () => void) => {
    if (!parseBrokerAppUrl(brokerRequestUrl(request))) return next();
    void proxyBrokerAppHttp(request, response);
  });
}

export function attachBrokerInstanceAppProxyUpgrade(server: Server): void {
  server.on("upgrade", async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = parseBrokerAppUrl(request.url);
    if (!route) return;
    if (!(await upgradeHasInstanceSession(request, route.instanceId))) {
      writeUpgradeError(socket, 401, "broker_instance_pairing_required");
      return;
    }

    let target: BrokerAppTarget | null = null;
    try {
      target = await brokerAppTarget(request.url);
    } catch (error) {
      writeUpgradeError(socket, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
      return;
    }
    if (!target) {
      writeUpgradeError(socket, 404, "broker app route not found");
      return;
    }
    let brokerAuth = "";
    try {
      brokerAuth = await brokerProxyAuthHeader(request, target);
    } catch (error) {
      writeUpgradeError(socket, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
      return;
    }

    const secure = target.baseUrl.protocol === "https:";
    const connect = secure
      ? tls.connect({ host: target.baseUrl.hostname, port: targetPort(target.baseUrl), servername: target.baseUrl.hostname })
      : net.connect(targetPort(target.baseUrl), target.baseUrl.hostname);
    connect.on(secure ? "secureConnect" : "connect", () => {
      connect.write(rawUpgradeHeaders(request, target, brokerAuth));
      if (head.length) connect.write(head);
      socket.pipe(connect).pipe(socket);
    });
    connect.on("error", (error) => {
      writeUpgradeError(socket, 502, error.message || "broker_instance_app_proxy_failed");
    });
  });
}
