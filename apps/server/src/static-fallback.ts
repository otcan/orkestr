import fs from "node:fs/promises";
import { serveDesktopSharePage } from "./desktop-share-page.js";
import { publicUrlConfig } from "../../../packages/core/src/public-url-config.js";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { resolveBrokerConnectInstance } from "../../../packages/core/src/broker-instance-registry.js";
import { securityCookieName, verifySecurityToken } from "../../../packages/core/src/security.js";
import { resolveSharedAppShare } from "../../../packages/core/src/shared-apps.js";
import { instanceSetupPairingRedirectPath, normalizeInstanceId } from "./instance-connect-setup.js";
import { maybeHandleInstanceEntry } from "./instance-entry.js";
import { publicPairingUrl, publicSiteAllowedForHost, publicSitePath } from "./public-site.js";
import { maybeServePublicSite } from "./public-site-static.js";

const publicDir = path.resolve(process.cwd(), "dist/web/browser");
const launcherDir = path.resolve(process.cwd(), "dist/launcher");
const publicAssetDir = path.resolve(process.cwd(), "docs/assets");

const mimeTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

export function registerStaticFallback(app: INestApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use(async (request: any, response: any, next: () => void) => {
    const url = String(request.originalUrl || request.url || "");
    if (url.startsWith("/api/") || url.startsWith("/auth/") || url.startsWith("/oauth/") || url.startsWith("/connect/") || url === "/review/google" || url.startsWith("/review/google/") || url.startsWith("/google-marketing/oauth/") || isMcpBridgePath(url) || isSecretLinkPath(url)) {
      return next();
    }
    if (isDesktopSharePagePath(url)) {
      return serveDesktopSharePage(response, publicUrlConfig(process.env).appUrl);
    }
    const sharedAppHandled = await maybeHandleSharedAppRoute(request, response, url);
    if (sharedAppHandled) return;
    let instanceSetupRedirect = "";
    try {
      instanceSetupRedirect = await instanceSetupRedirectUrl(request, url);
    } catch (error: any) {
      if (isInstanceSetupPath(url)) {
        return response
          .status(Number(error?.statusCode || 404))
          .header("cache-control", "no-store")
          .type("text/plain; charset=utf-8")
          .send(String(error?.message || "broker_instance_unavailable"));
      }
      throw error;
    }
    if (instanceSetupRedirect) {
      return response
        .status(302)
        .header("cache-control", "no-store")
        .header("location", instanceSetupRedirect)
        .send("Redirecting to Orkestr app access.");
    }
    if (url.startsWith("/public-assets/")) {
      return servePublicAsset(url, response);
    }
    const publicPath = new URL(url || "/", "http://localhost").pathname;
    if (maybeServePublicSite(request, response, url, process.env)) return;
    if (["/", "/instance-entry"].includes(publicPath)) {
      const authenticated = Boolean(request?.orkestrSecuritySession) || await requestHasSecuritySession(request, process.env);
      if (await maybeHandleInstanceEntry(request, response, url, { authenticated, env: process.env })) return;
    }
    const privatePublicRedirect = await privatePublicPathRedirectUrl(request, url, process.env);
    if (privatePublicRedirect) {
      return response
        .status(302)
        .header("cache-control", "no-store")
        .header("location", privatePublicRedirect)
        .send("Redirecting to Orkestr authentication.");
    }
    return serveStaticPath(
      url || "/",
      response,
      String(request.orkestrCanonicalPrefix || ""),
      request.orkestrLauncherBoundary === true,
    );
  });
}

// Remote MCP endpoint and its OAuth server (thread-bridge-mcp.controller.ts).
function isMcpBridgePath(requestUrl: string) {
  const pathname = new URL(requestUrl || "/", "http://localhost").pathname;
  return pathname === "/mcp" || pathname.startsWith("/mcp-oauth/") || pathname.startsWith("/.well-known/oauth-");
}

// One-time secret link pages (modules/secret-links).
function isSecretLinkPath(requestUrl: string) {
  return new URL(requestUrl || "/", "http://localhost").pathname.startsWith("/s/");
}

function isDesktopSharePagePath(requestUrl: string) {
  const pathname = new URL(requestUrl || "/", "http://localhost").pathname;
  if (pathname.startsWith("/desktop-share/")) return true;
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "i" && Boolean(parts[1]) && parts[2] === "app" && parts[3] === "desktop-share";
}

async function maybeHandleSharedAppRoute(request: any, response: any, requestUrl: string): Promise<boolean> {
  const route = parseSharedAppRoute(requestUrl);
  if (!route) return false;
  let resolved: any = null;
  try {
    resolved = await resolveSharedAppShare(route.instanceId, route.appSlug, route.shareToken, { includeDenied: true });
  } catch (error: any) {
    return sendSharedAppDenied(response, "Share link not found.", Number(error?.statusCode || 404));
  }
  if (resolved.deniedReason) {
    return sendSharedAppDenied(response, resolved.deniedReason === "expired" ? "This share link has expired." : "This share link has been revoked.", 403);
  }
  return false;
}

function parseSharedAppRoute(requestUrl: string) {
  const url = new URL(requestUrl || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 6 || parts[0] !== "i" || parts[2] !== "a" || parts[4] !== "s") return null;
  const instanceId = safeDecode(parts[1]);
  const appSlug = safeDecode(parts[3]);
  const shareToken = safeDecode(parts[5]);
  if (!instanceId || !appSlug || !shareToken) return null;
  return {
    instanceId,
    appSlug,
    shareToken,
    fullPath: `${url.pathname}${url.search}`,
  };
}

function safeDecode(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sendSharedAppDenied(response: any, message: string, statusCode = 403): boolean {
  response
    .status(statusCode)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Share unavailable</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111814; color: #eef8ef; }
    main { width: min(520px, calc(100% - 32px)); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; color: #b8c9ba; line-height: 1.5; }
  </style>
</head>
<body><main><h1>Share unavailable</h1><p>${escapeHtml(message)}</p></main></body>
</html>`);
  return true;
}

function escapeHtml(value = ""): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function instanceSetupRedirectUrl(request: any, requestUrl: string): Promise<string> {
  const url = new URL(requestUrl || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "i" || parts[2] !== "setup") return "";
  const instanceId = normalizeInstanceId(parts[1]);
  if (!instanceId) return "";
  await resolveBrokerConnectInstance(instanceId, process.env);
  return instanceSetupPairingRedirectPath(instanceId, url.searchParams.get("return") || "", url.searchParams.get("connector") || "");
}

function isInstanceSetupPath(requestUrl: string): boolean {
  const url = new URL(requestUrl || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "i" && parts[2] === "setup";
}

async function privatePublicPathRedirectUrl(request: any, requestUrl: string, env = process.env) {
  const url = new URL(requestUrl || "/", "http://localhost");
  if (!publicSitePath(url.pathname)) return "";
  if (publicSiteAllowedForHost(requestHostHeader(request), env)) return "";
  if (request?.orkestrSecuritySession) return "";
  if (await requestHasSecuritySession(request, env)) return "";
  const pairingUrl = publicPairingUrl(env);
  if (!pairingUrl) return "";
  try {
    const target = new URL(pairingUrl);
    target.searchParams.set("return", originalRequestUrl(request, requestUrl));
    return target.toString();
  } catch {
    return "";
  }
}

async function requestHasSecuritySession(request: any, env = process.env) {
  const token = cookieValue(request?.headers?.cookie || "", securityCookieName());
  if (!token) return false;
  return verifySecurityToken(token, env, { request }).catch(() => false);
}

function cookieValue(header: string, name: string) {
  const raw = String(header || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function requestHostHeader(request: any) {
  return String(request.headers?.["x-forwarded-host"] || request.headers?.host || "");
}

function originalRequestOrigin(request: any) {
  const proto = String(request.headers?.["x-forwarded-proto"] || request.protocol || "https").split(",")[0].trim() || "https";
  const host = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "localhost").split(",")[0].trim() || "localhost";
  return `${proto}://${host}`;
}

function originalRequestUrl(request: any, requestUrl: string) {
  return `${originalRequestOrigin(request)}${requestUrl || "/"}`;
}


async function servePublicAsset(requestUrl: string, response: any) {
  const url = new URL(requestUrl, "http://localhost");
  const requested = decodeURIComponent(url.pathname.replace(/^\/public-assets\/?/, "/"));
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicAssetDir, safePath);
  const target = filePath.startsWith(publicAssetDir) ? filePath : "";
  const ext = path.extname(target);

  try {
    const body = await fs.readFile(target);
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(body);
  } catch {
    return response
      .status(404)
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send("public asset not found");
  }
}

function rewriteStaticBase(body: Buffer, prefixPath = ""): Buffer | string {
  if (!prefixPath) return body;
  const base = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  return body.toString("utf8").replace(/<base\s+href=(["'])\/\1\s*\/?>/i, `<base href="${base}" />`);
}

async function serveStaticPath(requestUrl: string, response: any, prefixPath = "", launcher = false) {
  const staticDir = launcher ? launcherDir : publicDir;
  const url = new URL(requestUrl, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const assetPath = requested === "/favicon.ico" ? "/favicon.svg" : requested;
  const safePath = path.normalize(assetPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(staticDir, safePath);
  const target = filePath.startsWith(staticDir) ? filePath : path.join(staticDir, "index.html");
  const ext = path.extname(target);

  try {
    const body = await fs.readFile(target);
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(ext === ".html" ? rewriteStaticBase(body, prefixPath) : body);
  } catch {
    try {
      const body = await fs.readFile(path.join(staticDir, "index.html"));
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(rewriteStaticBase(body, prefixPath));
    } catch {
      return response
        .status(503)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(launcher
          ? "<!doctype html><title>Orkestr launcher missing</title><h1>Orkestr launcher missing</h1><p>Run <code>npm run launcher:build</code> to build the standalone launcher.</p>"
          : "<!doctype html><title>Orkestr web bundle missing</title><h1>Orkestr web bundle missing</h1><p>Run <code>npm run web:verify-static</code> to check the served assets.</p>");
    }
  }
}
