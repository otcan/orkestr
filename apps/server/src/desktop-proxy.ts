import http from "node:http";
import net from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ensureVirtualBrowserReady } from "../../../packages/browsers/src/browsers.js";
import { requestPrincipal } from "../../../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { isMobileDesktopRoute, serveMobileDesktopShell } from "./mobile-desktop-shell.js";
import { assertDesktopAccess } from "../../../packages/core/src/desktop-access.js";
import { onDesktopShareLifecycle } from "../../../packages/core/src/desktop-share-lifecycle.js";
import { validateDesktopShareSession } from "../../../packages/core/src/desktop-shares.js";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { desktopCapabilityRequired } from "../../../packages/browsers/src/desktop-capability-broker.js";
import { hostBoundaryUpgradeDenied } from "./host-boundaries.js";

type DesktopTarget = {
  slug: string;
  port: number;
  path: string;
};

const targetCache = new Map<string, { port: number; expiresAt: number }>();
type ShareSocket = {
  shareId: string;
  lineageId: string;
  shareGeneration: number;
  attemptId: string;
  socket: Duplex;
  upstream: Duplex;
  validationTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
};
const shareSockets = new Map<string, Set<ShareSocket>>();

function recordShareSocketEvent(type: string, connection: ShareSocket, reason = ""): void {
  void appendEvent({
    type,
    shareId: connection.shareId,
    lineageId: connection.lineageId,
    shareGeneration: connection.shareGeneration,
    attemptId: connection.attemptId,
    reason,
  }).catch(() => undefined);
}

function unregisterShareSocket(connection: ShareSocket, reason = "disconnected"): void {
  if (connection.closed) return;
  connection.closed = true;
  clearInterval(connection.validationTimer);
  if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
  const connections = shareSockets.get(connection.shareId);
  connections?.delete(connection);
  if (!connections?.size) shareSockets.delete(connection.shareId);
  recordShareSocketEvent("desktop_share_ws_disconnected", connection, reason);
}

function closeShareSocket(connection: ShareSocket, reason: string): void {
  if (connection.closed) return;
  recordShareSocketEvent("desktop_share_ws_forcibly_closed", connection, reason);
  connection.socket.destroy();
  connection.upstream.destroy();
  unregisterShareSocket(connection, reason);
}

function revalidateShareSocket(connection: ShareSocket): void {
  void validateDesktopShareSession({ shareId: connection.shareId, attemptId: connection.attemptId }).catch((error) => {
    const reason = String((error as Error)?.message || "desktop_share_invalid");
    recordShareSocketEvent("desktop_share_ws_stale_reconnect", connection, reason);
    closeShareSocket(connection, reason);
  });
}

function shareSocketExpiryDelayMs(share: any, attempt: any): number | null {
  const expirations = [share?.expiresAt, attempt?.expiresAt]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  if (!expirations.length) return null;
  return Math.max(0, Math.min(...expirations) - Date.now());
}

export function registerDesktopShareSocket(socket: Duplex, upstream: Duplex, share: any, attempt: any): ShareSocket | null {
  const shareId = String(share?.id || "").trim();
  const attemptId = String(attempt?.id || "").trim();
  if (!shareId || !attemptId) return null;
  const expiryDelayMs = shareSocketExpiryDelayMs(share, attempt);
  const connection = {
    shareId,
    lineageId: String(share.lineageId || "").trim(),
    shareGeneration: Number(share.shareGeneration || 0) || 0,
    attemptId,
    socket,
    upstream,
    validationTimer: setInterval(() => revalidateShareSocket(connection), 2_000),
    expiryTimer: expiryDelayMs === null ? null : setTimeout(() => revalidateShareSocket(connection), expiryDelayMs),
    closed: false,
  } satisfies ShareSocket;
  connection.validationTimer.unref?.();
  connection.expiryTimer?.unref?.();
  const connections = shareSockets.get(shareId) || new Set<ShareSocket>();
  connections.add(connection);
  shareSockets.set(shareId, connections);
  socket.once("close", () => unregisterShareSocket(connection));
  upstream.once("close", () => unregisterShareSocket(connection));
  recordShareSocketEvent("desktop_share_ws_connected", connection);
  // Close a socket that became stale in the authorization-to-upstream race
  // immediately instead of granting it the next polling interval.
  revalidateShareSocket(connection);
  return connection;
}

onDesktopShareLifecycle((event) => {
  const direct = event.shareId ? [...(shareSockets.get(event.shareId) || [])] : [];
  const lineage = event.lineageId
    ? [...shareSockets.values()].flatMap((connections) => [...connections]).filter((connection) => connection.lineageId === event.lineageId && connection.shareGeneration < event.shareGeneration)
    : [];
  for (const connection of new Set([...direct, ...lineage])) closeShareSocket(connection, event.reason || "desktop_share_changed");
});

function targetCacheTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_DESKTOP_PROXY_TARGET_CACHE_MS || 2000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 2000;
}

function parseDesktopUrl(rawUrl: string | undefined): { slug: string; path: string } | null {
  const parsed = new URL(String(rawUrl || "/"), "http://orkestr.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "desktop" || !parts[1]) return null;
  const slug = decodeURIComponent(parts[1]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug)) return null;
  const rest = parts.slice(2).join("/") || "vnc.html";
  return {
    slug,
    path: `/${rest}${parsed.search}`,
  };
}

function sessionWebPort(session: Record<string, any>): number {
  const parsed = Number(session.web_port || session.webPort || session.novnc_port || session.noVncPort || portFromEndpoint(session.upstream));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function portFromEndpoint(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  const match = text.match(/(?::|:\/\/[^/:]+:)(\d{2,5})(?:\/|$)/);
  const parsed = Number(match?.[1] || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function principalCacheKey(principal: any, slug: string, threadId = "", grantRevision = 0): string {
  return `${String(principal?.userId || "admin")}:${String(principal?.role || "admin")}:${threadId}:${grantRevision}:${slug}`;
}

function desktopRequestScope(rawUrl: string | undefined, request: any = {}): { threadId: string; grantRevision: number } {
  const parsed = new URL(String(rawUrl || "/"), "http://orkestr.local");
  const share = request?.orkestrDesktopShare || {};
  return {
    threadId: String(share.threadId || parsed.searchParams.get("threadId") || request?.headers?.["x-orkestr-thread-id"] || "").trim(),
    grantRevision: Number(share.grantRevision || 0) || 0,
  };
}

async function desktopTarget(rawUrl: string | undefined, principal: any, scope: any = {}): Promise<DesktopTarget | null> {
  const request = parseDesktopUrl(rawUrl);
  if (!request) return null;
  if (desktopCapabilityRequired(process.env, { threadId: scope.threadId, desktopSlug: request.slug }) && !scope.desktopShare) {
    const error = new Error("desktop_brokered_share_required");
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
  const decision = await assertDesktopAccess({
    principal,
    threadId: scope.threadId,
    desktopSlug: request.slug,
    permission: scope.desktopShare ? "share" : "operate",
  });
  if (scope.grantRevision && decision.grantRevision !== scope.grantRevision) {
    const error = new Error("desktop_share_grant_changed");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  const cacheKey = principalCacheKey(principal, request.slug, scope.threadId, decision.grantRevision);
  const cached = targetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...request, port: cached.port };
  const session = await ensureVirtualBrowserReady(request.slug, process.env, {
    principal,
    threadId: scope.threadId,
    fencingToken: String(scope.fencingToken || "").trim(),
    internalDesktopProxy: true,
  });
  const port = session ? sessionWebPort(session) : 0;
  if (!port) {
    const error = new Error("desktop_not_running");
    Object.assign(error, { statusCode: 409 });
    throw error;
  }
  const ttlMs = targetCacheTtlMs();
  if (ttlMs > 0) targetCache.set(cacheKey, { port, expiresAt: Date.now() + ttlMs });
  return { slug: request.slug, port, path: request.path };
}

function sendJson(response: any, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  if (typeof response.status === "function") {
    response.status(statusCode).type("application/json").send(body);
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(body);
}

async function proxyDesktopHttp(request: any, response: any): Promise<void> {
  const mobileRoute = isMobileDesktopRoute(request.originalUrl || request.url);
  if (mobileRoute) {
    try {
      const scope = desktopRequestScope(request.originalUrl || request.url, request);
      if (desktopCapabilityRequired(process.env, { threadId: scope.threadId, desktopSlug: mobileRoute.slug }) && !request.orkestrDesktopShare) {
        const error = new Error("desktop_brokered_share_required");
        Object.assign(error, { statusCode: 403 });
        throw error;
      }
      await assertDesktopAccess({
        principal: requestPrincipal(request),
        threadId: scope.threadId,
        desktopSlug: mobileRoute.slug,
        permission: request.orkestrDesktopShare ? "share" : "operate",
      });
      serveMobileDesktopShell(response, mobileRoute.slug);
      return;
    } catch (error) {
      sendJson(response, Number((error as any)?.statusCode || 403), { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  let target: DesktopTarget | null = null;
  try {
    const scope = desktopRequestScope(request.originalUrl || request.url, request);
    target = await desktopTarget(request.originalUrl || request.url, requestPrincipal(request), {
      ...scope,
      desktopShare: request.orkestrDesktopShare || null,
      fencingToken: request.headers?.["x-orkestr-desktop-fencing-token"] || "",
    });
  } catch (error) {
    sendJson(response, Number((error as any)?.statusCode || 502), {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!target) {
    sendJson(response, 404, { ok: false, error: "desktop_route_not_found" });
    return;
  }

  const headers = { ...request.headers, host: `127.0.0.1:${target.port}` };
  delete (headers as Record<string, unknown>).connection;
  delete (headers as Record<string, unknown>).upgrade;
  const upstream = http.request({
    host: "127.0.0.1",
    port: target.port,
    method: request.method,
    path: target.path,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 502, { ok: false, error: error.message || "desktop_proxy_failed" });
      return;
    }
    response.end();
  });
  request.pipe(upstream);
}

function rawUpgradeHeaders(request: IncomingMessage, target: DesktopTarget): string {
  const lines = [`${request.method || "GET"} ${target.path} HTTP/${request.httpVersion || "1.1"}`];
  let sawHost = false;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] || "";
    const value = request.rawHeaders[index + 1] || "";
    if (name.toLowerCase() === "host") {
      sawHost = true;
      lines.push(`Host: 127.0.0.1:${target.port}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!sawHost) lines.push(`Host: 127.0.0.1:${target.port}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Gateway"}\r\n`);
  socket.write("Content-Type: application/json\r\nConnection: close\r\n\r\n");
  socket.write(JSON.stringify({ ok: false, error: message }));
  socket.destroy();
}

export function registerDesktopProxy(app: INestApplication): void {
  app.use("/desktop", (request: any, response: any) => {
    void proxyDesktopHttp(request, response);
  });
}

export function attachDesktopProxyUpgrade(server: Server): void {
  server.on("upgrade", async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (hostBoundaryUpgradeDenied(request)) return;
    if (!parseDesktopUrl(request.url)) return;
    const auth: any = await authorizeHttpRequest(request).catch((error) => ({
      ok: false,
      statusCode: 500,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (!auth.ok) {
      writeUpgradeError(socket, Number(auth.statusCode || 401), String(auth.error || "browser_pairing_required"));
      return;
    }

    let target: DesktopTarget | null = null;
    try {
      const share = auth.desktopShare || null;
      const scope = desktopRequestScope(request.url, { headers: request.headers, orkestrDesktopShare: share });
      target = await desktopTarget(request.url, auth.principal, {
        ...scope,
        desktopShare: share,
        fencingToken: request.headers["x-orkestr-desktop-fencing-token"] || "",
      });
    } catch (error) {
      writeUpgradeError(socket, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
      return;
    }
    if (!target) {
      writeUpgradeError(socket, 404, "desktop_route_not_found");
      return;
    }

    const upstream = net.connect(target.port, "127.0.0.1", () => {
      upstream.write(rawUpgradeHeaders(request, target));
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      registerDesktopShareSocket(socket, upstream, auth.desktopShare || null, auth.desktopShareAttempt || null);
    });
    upstream.on("error", (error) => {
      if (!socket.destroyed) writeUpgradeError(socket, 502, error.message || "desktop_proxy_failed");
    });
  });
}
