import fs from "node:fs/promises";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { resolveBrokerConnectInstance } from "../../../packages/core/src/broker-instance-registry.js";
import { securityCookieName, verifySecurityToken } from "../../../packages/core/src/security.js";
import { resolveSharedAppShare } from "../../../packages/core/src/shared-apps.js";
import { instanceSetupPairingRedirectPath, normalizeInstanceId } from "./instance-connect-setup.js";
import { publicPairingUrl, publicSiteAllowedForHost, publicSitePath, renderPublicSite } from "./public-site.js";

const publicDir = path.resolve(process.cwd(), "dist/web/browser");
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
    if (url.startsWith("/api/") || url.startsWith("/oauth/") || url.startsWith("/connect/") || url.startsWith("/google-marketing/oauth/")) {
      return next();
    }
    if (isDesktopSharePagePath(url)) {
      return serveDesktopSharePage(response);
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
    if (new URL(url || "/", "http://localhost").pathname === "/robots.txt" && publicSiteAllowedForHost(requestHostHeader(request), process.env)) {
      return response
        .status(200)
        .header("cache-control", "public, max-age=300")
        .type("text/plain; charset=utf-8")
        .send("User-agent: *\nAllow: /\n");
    }
    const privatePublicRedirect = await privatePublicPathRedirectUrl(request, url, process.env);
    if (privatePublicRedirect) {
      return response
        .status(302)
        .header("cache-control", "no-store")
        .header("location", privatePublicRedirect)
        .send("Redirecting to Orkestr authentication.");
    }
    const publicSite = renderPublicSite(url, process.env, { host: requestHostHeader(request) });
    if (publicSite) {
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(publicSite);
    }
    return serveStaticPath(url || "/", response);
  });
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

function serveDesktopSharePage(response: any) {
  return response
    .status(200)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orkestr Desktop Access</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #f6f8fb; }
    main { width: min(92vw, 520px); padding: 28px; border: 1px solid #2d3743; background: #171d24; border-radius: 8px; box-shadow: 0 18px 60px #0008; }
    h1 { margin: 0 0 10px; font-size: 24px; letter-spacing: 0; }
    p { margin: 10px 0; color: #c8d0db; line-height: 1.45; }
    code { display: block; margin: 18px 0; padding: 16px; border-radius: 6px; background: #0b0f14; color: #9be7c1; font-size: 17px; overflow-wrap: anywhere; user-select: all; }
    button, a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 16px; border-radius: 6px; border: 1px solid #5b6b7d; background: #e8edf3; color: #111820; font-weight: 700; text-decoration: none; }
    small { display: block; margin-top: 16px; color: #8f9baa; }
    .error { color: #ffb4a9; }
  </style>
</head>
<body>
  <main>
    <h1>Orkestr Desktop Access</h1>
    <p id="summary">Preparing a one-time desktop challenge.</p>
    <code id="challenge">loading</code>
    <button id="copy" type="button">Copy challenge</button>
    <p id="status"></p>
    <a id="open" class="button" href="#" hidden>Open desktop</a>
    <a id="mobile" class="button" href="#" hidden>Mobile controls</a>
    <small>This link only works for this browser after the exact command below is pasted back to the Orkestr chat.</small>
  </main>
  <script>
    const parts = location.pathname.split('/').filter(Boolean);
    const shareIndex = parts.indexOf('desktop-share');
    const shareParts = shareIndex >= 0 ? parts.slice(shareIndex) : parts;
    const tenantShare = shareParts[0] === 'desktop-share' && shareParts[1] === 'tvm';
    const tenantVmId = tenantShare ? decodeURIComponent(shareParts[2] || '') : '';
    const subdomain = tenantShare ? decodeURIComponent(shareParts[3] || '') : (shareParts.length > 2 ? shareParts[1] : '');
    const shareId = tenantShare ? decodeURIComponent(shareParts[4] || '') : (shareParts[shareParts.length - 1] || '');
    const key = new URLSearchParams(location.search).get('key') || '';
    const challenge = document.getElementById('challenge');
    const statusNode = document.getElementById('status');
    const summary = document.getElementById('summary');
    const open = document.getElementById('open');
    const mobile = document.getElementById('mobile');
    const copy = document.getElementById('copy');
    const api = (action) => {
      const base = tenantVmId
        ? '/api/tenant-vms/' + encodeURIComponent(tenantVmId) + '/desktop-shares/' + encodeURIComponent(shareId) + '/' + action
        : '/api/desktop-shares/' + encodeURIComponent(shareId) + '/' + action;
      return base + '?key=' + encodeURIComponent(key) + (subdomain ? '&subdomain=' + encodeURIComponent(subdomain) : '');
    };
    function mobileDestination(value) {
      const parsed = new URL(value, location.origin);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'desktop' && parts[1] && parts[2] === 'vnc.html') {
        return '/desktop/' + encodeURIComponent(decodeURIComponent(parts[1])) + '/mobile';
      }
      if (parts[0] === 'tenant-vms' && parts[1] && parts[2] === 'desktop' && parts[3] && parts[4] === 'vnc.html') {
        return '/tenant-vms/' + encodeURIComponent(decodeURIComponent(parts[1])) + '/desktop/' + encodeURIComponent(decodeURIComponent(parts[3])) + '/mobile';
      }
      return value;
    }
    async function json(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        const error = new Error(body.renewal && body.renewal.message ? body.renewal.message : (body.error || body.message || 'desktop_share_failed'));
        error.payload = body;
        throw error;
      }
      return body;
    }
    function showExpired(error) {
      const renewal = error && error.payload ? error.payload.renewal : null;
      if (!renewal || !renewal.renewCommand) return false;
      challenge.textContent = renewal.renewCommand;
      summary.textContent = 'This desktop link expired.';
      statusNode.textContent = renewal.message || 'Ask the Orkestr operator to create a fresh desktop link.';
      statusNode.className = 'error';
      copy.textContent = 'Copy renewal command';
      return true;
    }
    async function poll() {
      try {
        const body = await json(api('status'));
        if (body.approved && body.desktopUrl) {
          const desktopUrl = body.desktopUrl;
          statusNode.textContent = 'Approved. Opening the desktop.';
          open.href = desktopUrl;
          open.hidden = false;
          const mobileUrl = mobileDestination(body.desktopUrl);
          if (mobileUrl !== desktopUrl) {
            mobile.href = mobileUrl;
            mobile.hidden = false;
          }
          location.href = desktopUrl;
          return;
        }
        statusNode.textContent = 'Waiting for approval from chat.';
        setTimeout(poll, 2000);
      } catch (error) {
        if (showExpired(error)) return;
        statusNode.textContent = error.message || String(error);
        statusNode.className = 'error';
      }
    }
    async function start() {
      try {
        const body = await json(api('open'));
        const value = body.attempt && body.attempt.challenge ? body.attempt.challenge : '';
        challenge.textContent = 'orkestr desktop approve ' + value;
        summary.textContent = 'Copy this exact command and paste it into the Orkestr chat that requested the desktop.';
        statusNode.textContent = 'Waiting for approval from chat.';
        poll();
      } catch (error) {
        if (showExpired(error)) return;
        challenge.textContent = 'not available';
        statusNode.textContent = error.message || String(error);
        statusNode.className = 'error';
      }
    }
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(challenge.textContent || '');
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy challenge'; }, 1200);
    });
    start();
  </script>
</body>
</html>`);
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

async function serveStaticPath(requestUrl: string, response: any) {
  const url = new URL(requestUrl, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const assetPath = requested === "/favicon.ico" ? "/favicon.svg" : requested;
  const safePath = path.normalize(assetPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const target = filePath.startsWith(publicDir) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);

  try {
    const body = await fs.readFile(target);
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(body);
  } catch {
    try {
      const body = await fs.readFile(path.join(publicDir, "index.html"));
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(body);
    } catch {
      return response
        .status(503)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send("<!doctype html><title>Orkestr web bundle missing</title><h1>Orkestr web bundle missing</h1><p>Run <code>npm run web:verify-static</code> to check the served assets.</p>");
    }
  }
}
