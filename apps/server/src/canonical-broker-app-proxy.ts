import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { brokerProxyAuthHeader } from "./broker-instance-app-proxy.js";

export type CanonicalBrokerTarget = {
  instanceId: string;
  upstreamPath: string;
  prefixPath: string;
  baseUrl: URL;
};

export function canonicalBrokerBaseUrl(value = ""): URL | null {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function targetPort(baseUrl: URL): number {
  return baseUrl.port ? Number(baseUrl.port) : baseUrl.protocol === "https:" ? 443 : 80;
}

function rewrittenLocation(value: unknown, target: CanonicalBrokerTarget): unknown {
  if (!value || Array.isArray(value)) return value;
  try {
    const raw = String(value);
    const parsed = new URL(raw, target.baseUrl);
    if (raw.startsWith("/") || parsed.origin === target.baseUrl.origin) {
      return `${target.prefixPath.replace(/\/+$/, "")}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Preserve an upstream value that cannot be parsed safely.
  }
  return value;
}

function responseHeaders(headers: http.IncomingHttpHeaders, target: CanonicalBrokerTarget, html = false): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  if (headers.location) next.location = rewrittenLocation(headers.location, target) as any;
  delete next.connection;
  if (html) {
    delete next["content-length"];
    delete next["content-encoding"];
  }
  return next;
}

function rewriteHtml(body: Buffer, prefixPath: string): string {
  return body.toString("utf8")
    .replace(/<base\s+href=(["'])\/\1\s*\/?>/i, `<base href="${prefixPath}" />`)
    .replace(/\s(href|src)=(["'])\/favicon\.svg\2/g, ` $1=$2${prefixPath}favicon.svg$2`);
}

function sendBadGateway(response: any): void {
  if (!response.headersSent) response.status(502).type("text/plain; charset=utf-8").send("bad gateway");
  else response.end();
}

export async function proxyCanonicalBrokerHttp(request: any, response: any, target: CanonicalBrokerTarget): Promise<void> {
  let auth = "";
  try { auth = await brokerProxyAuthHeader(request, target as any); } catch { return sendBadGateway(response); }
  const headers: Record<string, unknown> = {
    ...request.headers,
    host: target.baseUrl.host,
    "accept-encoding": "identity",
    "x-forwarded-host": request.headers?.["x-forwarded-host"] || request.headers?.host || "",
    "x-forwarded-proto": request.headers?.["x-forwarded-proto"] || request.protocol || "https",
    "x-forwarded-prefix": target.prefixPath.replace(/\/+$/, ""),
    "x-orkestr-broker-instance-id": target.instanceId,
    "x-orkestr-broker-auth": auth,
  };
  delete headers.connection;
  delete headers.upgrade;
  const client = target.baseUrl.protocol === "https:" ? https : http;
  const upstream = client.request({
    host: target.baseUrl.hostname,
    port: targetPort(target.baseUrl),
    method: request.method,
    path: target.upstreamPath,
    headers: headers as http.OutgoingHttpHeaders,
  }, (upstreamResponse) => {
    const html = String(upstreamResponse.headers["content-type"] || "").toLowerCase().includes("text/html");
    if (!html) {
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers, target));
      upstreamResponse.pipe(response);
      return;
    }
    const chunks: Buffer[] = [];
    upstreamResponse.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    upstreamResponse.on("end", () => {
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers, target, true));
      response.end(rewriteHtml(Buffer.concat(chunks), target.prefixPath));
    });
  });
  upstream.on("error", () => sendBadGateway(response));
  request.pipe(upstream);
}

function rawUpgradeHeaders(request: IncomingMessage, target: CanonicalBrokerTarget, auth: string): string {
  const lines = [`${request.method || "GET"} ${target.upstreamPath} HTTP/${request.httpVersion || "1.1"}`];
  let host = false;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] || "";
    const value = request.rawHeaders[index + 1] || "";
    const lowered = name.toLowerCase();
    if (lowered === "host") { host = true; lines.push(`Host: ${target.baseUrl.host}`); }
    else if (!["x-forwarded-prefix", "x-orkestr-broker-instance-id", "x-orkestr-broker-auth"].includes(lowered)) lines.push(`${name}: ${value}`);
  }
  if (!host) lines.push(`Host: ${target.baseUrl.host}`);
  lines.push(`X-Forwarded-Prefix: ${target.prefixPath.replace(/\/+$/, "")}`);
  lines.push(`X-Orkestr-Broker-Instance-Id: ${target.instanceId}`);
  lines.push(`X-Orkestr-Broker-Auth: ${auth}`, "", "");
  return lines.join("\r\n");
}

function upgradeFailure(socket: Duplex): void {
  socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nbad gateway");
}

export async function proxyCanonicalBrokerUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: CanonicalBrokerTarget,
): Promise<void> {
  let auth = "";
  try { auth = await brokerProxyAuthHeader(request, target as any); } catch { return upgradeFailure(socket); }
  const secure = target.baseUrl.protocol === "https:";
  const upstream = secure
    ? tls.connect({ host: target.baseUrl.hostname, port: targetPort(target.baseUrl), servername: target.baseUrl.hostname })
    : net.connect(targetPort(target.baseUrl), target.baseUrl.hostname);
  upstream.on(secure ? "secureConnect" : "connect", () => {
    upstream.write(rawUpgradeHeaders(request, target, auth));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => upgradeFailure(socket));
}
