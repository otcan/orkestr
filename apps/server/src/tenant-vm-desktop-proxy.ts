import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { getTenantVm } from "../../../packages/core/src/tenant-vm-registry.js";
import { tenantDesktopShareCookiePresent } from "../../../packages/core/src/tenant-desktop-share-routing.js";

type TenantDesktopTarget = {
  tenantVmId: string;
  baseUrl: URL;
  path: string;
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

function decodeSegment(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseTenantDesktopUrl(rawUrl: string | undefined): { tenantVmId: string; path: string } | null {
  const parsed = new URL(String(rawUrl || "/"), "http://orkestr.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "tenant-vms" || !parts[1] || parts[2] !== "desktop" || !parts[3]) return null;
  const tenantVmId = decodeSegment(parts[1]).trim();
  const desktopParts = parts.slice(2).map((part) => encodeURIComponent(decodeSegment(part)));
  return {
    tenantVmId,
    path: `/${desktopParts.join("/")}${parsed.search}`,
  };
}

function tenantBaseUrl(tenantVm: any): URL | null {
  return normalizeProxyBaseUrl(tenantVm?.endpoint?.baseUrl || tenantVm?.endpoint?.brokerBaseUrl || tenantVm?.endpoint?.publicIp || "");
}

async function tenantDesktopTarget(rawUrl: string | undefined): Promise<TenantDesktopTarget | null> {
  const parsed = parseTenantDesktopUrl(rawUrl);
  if (!parsed) return null;
  const tenantVm = await getTenantVm(parsed.tenantVmId);
  if (!tenantVm || tenantVm.deletedAt || tenantVm.status === "deleted") {
    const error = new Error("tenant_vm_not_found");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  const baseUrl = tenantBaseUrl(tenantVm);
  if (!baseUrl) {
    const error = new Error("tenant_vm_endpoint_unavailable");
    Object.assign(error, { statusCode: 503 });
    throw error;
  }
  return { tenantVmId: tenantVm.id, baseUrl, path: parsed.path };
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

function targetPort(baseUrl: URL): number {
  if (baseUrl.port) return Number(baseUrl.port);
  return baseUrl.protocol === "https:" ? 443 : 80;
}

async function proxyTenantDesktopHttp(request: any, response: any): Promise<void> {
  if (!tenantDesktopShareCookiePresent(request.headers?.cookie || "")) {
    sendJson(response, 401, { ok: false, error: "desktop_share_cookie_required" });
    return;
  }

  let target: TenantDesktopTarget | null = null;
  try {
    target = await tenantDesktopTarget(request.originalUrl || request.url);
  } catch (error) {
    sendJson(response, Number((error as any)?.statusCode || 502), {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!target) {
    sendJson(response, 404, { ok: false, error: "tenant_desktop_route_not_found" });
    return;
  }

  const headers = { ...request.headers, host: target.baseUrl.host };
  delete (headers as Record<string, unknown>).connection;
  delete (headers as Record<string, unknown>).upgrade;
  const client = target.baseUrl.protocol === "https:" ? https : http;
  const upstream = client.request({
    host: target.baseUrl.hostname,
    port: targetPort(target.baseUrl),
    method: request.method,
    path: target.path,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 502, { ok: false, error: error.message || "tenant_desktop_proxy_failed" });
      return;
    }
    response.end();
  });
  request.pipe(upstream);
}

function rawUpgradeHeaders(request: IncomingMessage, target: TenantDesktopTarget): string {
  const lines = [`${request.method || "GET"} ${target.path} HTTP/${request.httpVersion || "1.1"}`];
  let sawHost = false;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] || "";
    const value = request.rawHeaders[index + 1] || "";
    if (name.toLowerCase() === "host") {
      sawHost = true;
      lines.push(`Host: ${target.baseUrl.host}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!sawHost) lines.push(`Host: ${target.baseUrl.host}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Gateway"}\r\n`);
  socket.write("Content-Type: application/json\r\nConnection: close\r\n\r\n");
  socket.write(JSON.stringify({ ok: false, error: message }));
  socket.destroy();
}

export function registerTenantVmDesktopProxy(app: INestApplication): void {
  app.use("/tenant-vms", (request: any, response: any, next: () => void) => {
    if (!parseTenantDesktopUrl(request.originalUrl || request.url)) return next();
    void proxyTenantDesktopHttp(request, response);
  });
}

export function attachTenantVmDesktopProxyUpgrade(server: Server): void {
  server.on("upgrade", async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!parseTenantDesktopUrl(request.url)) return;
    if (!tenantDesktopShareCookiePresent(request.headers?.cookie || "")) {
      writeUpgradeError(socket, 401, "desktop_share_cookie_required");
      return;
    }

    let target: TenantDesktopTarget | null = null;
    try {
      target = await tenantDesktopTarget(request.url);
    } catch (error) {
      writeUpgradeError(socket, Number((error as any)?.statusCode || 502), error instanceof Error ? error.message : String(error));
      return;
    }
    if (!target) {
      writeUpgradeError(socket, 404, "tenant_desktop_route_not_found");
      return;
    }

    const secure = target.baseUrl.protocol === "https:";
    const connect = secure
      ? tls.connect({ host: target.baseUrl.hostname, port: targetPort(target.baseUrl), servername: target.baseUrl.hostname })
      : net.connect(targetPort(target.baseUrl), target.baseUrl.hostname);
    connect.on(secure ? "secureConnect" : "connect", () => {
      connect.write(rawUpgradeHeaders(request, target));
      if (head.length) connect.write(head);
      socket.pipe(connect).pipe(socket);
    });
    connect.on("error", (error) => {
      writeUpgradeError(socket, 502, error.message || "tenant_desktop_proxy_failed");
    });
  });
}
