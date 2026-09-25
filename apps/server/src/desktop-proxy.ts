import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { resolveDesktopTarget } from "./desktop-target.js";
import { proxyDesktopAsset, proxyDesktopSocket } from "./desktop-proxy-transport.js";
import { requestPrincipal } from "../../../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { isMobileDesktopRoute, serveMobileDesktopShell } from "./mobile-desktop-shell.js";
import { assertDesktopAccess } from "../../../packages/core/src/desktop-access.js";
import { onDesktopShareLifecycle } from "../../../packages/core/src/desktop-share-lifecycle.js";
import { validateDesktopShareSession } from "../../../packages/core/src/desktop-shares.js";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { desktopCapabilityRequired } from "../../../packages/browsers/src/desktop-capability-broker.js";
import { hostBoundaryUpgradeDenied } from "./host-boundaries.js";
import { appendSanitizedForwardedHeaders, rawUpgradeHeaderAllowed } from "./upgrade-forwarded-headers.js";

type DesktopTarget = {
  slug: string;
  port: number;
  path: string;
};

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
  const port = await resolveDesktopTarget(request.slug, principal, scope);
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
      shareAttemptId: request.orkestrDesktopShareAttempt?.id || "",
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

  if (request.aborted || response.destroyed) return;

  proxyDesktopAsset(request, response, target);
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
    } else if (rawUpgradeHeaderAllowed(name)) {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!sawHost) lines.push(`Host: 127.0.0.1:${target.port}`);
  appendSanitizedForwardedHeaders(lines, request);
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
    // EventEmitter does not consume a rejected async listener. Reject malformed
    // percent encoding here, before authentication or any upstream work.
    try {
      if (!parseDesktopUrl(request.url)) return;
    } catch {
      writeUpgradeError(socket, 400, "desktop_route_invalid");
      return;
    }
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
        shareAttemptId: auth.desktopShareAttempt?.id || "",
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

    if (socket.destroyed) return;

    proxyDesktopSocket(socket, head, target.port, rawUpgradeHeaders(request, target), (upstream) => {
      registerDesktopShareSocket(socket, upstream, auth.desktopShare || null, auth.desktopShareAttempt || null);
    });
  });
}
