import http from "node:http";
import net from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ensureVirtualBrowserReady } from "../../../packages/browsers/src/browsers.js";
import { requestPrincipal } from "../../../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { isMobileDesktopRoute, serveMobileDesktopShell } from "./mobile-desktop-shell.js";

type DesktopTarget = {
  slug: string;
  port: number;
  path: string;
};

const targetCache = new Map<string, { port: number; expiresAt: number }>();

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

function principalCacheKey(principal: any, slug: string): string {
  return `${String(principal?.userId || "admin")}:${String(principal?.role || "admin")}:${slug}`;
}

async function desktopTarget(rawUrl: string | undefined, principal: any): Promise<DesktopTarget | null> {
  const request = parseDesktopUrl(rawUrl);
  if (!request) return null;
  const cacheKey = principalCacheKey(principal, request.slug);
  const cached = targetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...request, port: cached.port };
  const session = await ensureVirtualBrowserReady(request.slug, process.env, { principal });
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
    serveMobileDesktopShell(response, mobileRoute.slug);
    return;
  }

  let target: DesktopTarget | null = null;
  try {
    target = await desktopTarget(request.originalUrl || request.url, requestPrincipal(request));
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
      target = await desktopTarget(request.url, auth.principal);
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
    });
    upstream.on("error", (error) => {
      writeUpgradeError(socket, 502, error.message || "desktop_proxy_failed");
    });
  });
}
