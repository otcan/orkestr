import type { IncomingMessage, Server } from "node:http";
import { explicitCanonicalAppBase } from "../../../packages/core/src/canonical-app-links.js";

const trustedOperatorMarker = Symbol("orkestrTrustedOperatorProxy");

function enabled(value = ""): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

function singleHeader(value: unknown): string {
  const text = String(value || "").trim();
  return text && !text.includes(",") && !/[\s/?#\\]/.test(text) ? text : "";
}

function remoteAddress(request: any): string {
  return String(request?.socket?.remoteAddress || request?.connection?.remoteAddress || "")
    .trim()
    .replace(/^::ffff:/, "");
}

function loopbackRequest(request: any): boolean {
  return ["127.0.0.1", "::1"].includes(remoteAddress(request));
}

function trustedOrigins(env = process.env): Set<string> {
  const configured = [
    ...String(env.ORKESTR_TRUSTED_OPERATOR_ORIGINS || "").split(","),
    ...String(env.ORKESTR_TRUSTED_OPERATOR_HOSTS || "").split(",").map((host) => host.trim() ? `https://${host.trim()}` : ""),
  ];
  const origins = new Set<string>();
  for (const value of configured) {
    try {
      const parsed = new URL(String(value || "").trim());
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) continue;
      origins.add(parsed.origin);
    } catch {}
  }
  return origins;
}

function forwardedOrigin(request: any): string {
  const host = singleHeader(request?.headers?.["x-forwarded-host"]);
  const proto = String(request?.headers?.["x-forwarded-proto"] || "").trim().toLowerCase();
  if (!host || proto !== "https") return "";
  try { return new URL(`https://${host}`).origin; } catch { return ""; }
}

export function trustedOperatorProxyRequest(request: any): boolean {
  return request?.[trustedOperatorMarker] === true;
}

export function applyTrustedOperatorProxy(request: any, env = process.env): boolean {
  if (!enabled(env.ORKESTR_TRUSTED_OPERATOR_PROXY) || !loopbackRequest(request)) return false;
  const origin = forwardedOrigin(request);
  if (!origin || !trustedOrigins(env).has(origin)) return false;
  const canonicalBase = explicitCanonicalAppBase(env);
  if (!canonicalBase) return false;
  const canonical = new URL(canonicalBase);
  request.headers["x-forwarded-host"] = canonical.host;
  request.headers["x-forwarded-proto"] = canonical.protocol.replace(/:$/, "");
  request[trustedOperatorMarker] = true;
  request.orkestrTrustedOperatorProxy = true;
  return true;
}

export function attachTrustedOperatorProxyUpgrade(server: Server, env = process.env): void {
  if (!enabled(env.ORKESTR_TRUSTED_OPERATOR_PROXY)) return;
  server.prependListener("upgrade", (request: IncomingMessage) => {
    applyTrustedOperatorProxy(request, env);
  });
}
