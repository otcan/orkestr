import fs from "node:fs/promises";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { resolveBrokerConnectInstance } from "../../../packages/core/src/broker-instance-registry.js";
import { securityCookieName, verifySecurityToken } from "../../../packages/core/src/security.js";
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
    if (url.startsWith("/desktop-share/")) {
      return serveDesktopSharePage(response);
    }
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
        .send("Redirecting to Orkestr connect setup.");
    }
    if (url.startsWith("/public-assets/")) {
      return servePublicAsset(url, response);
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

async function instanceSetupRedirectUrl(request: any, requestUrl: string): Promise<string> {
  const url = new URL(requestUrl || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "i" || parts[2] !== "setup") return "";
  const instanceId = normalizeInstanceId(parts[1]);
  if (!instanceId) return "";
  await resolveBrokerConnectInstance(instanceId, process.env);
  const target = new URL("/setup/pairing", originalRequestOrigin(request));
  target.searchParams.set("instanceId", instanceId);
  target.searchParams.set("return", url.searchParams.get("return") || "/setup");
  return `${target.pathname}${target.search}`;
}

function isInstanceSetupPath(requestUrl: string): boolean {
  const url = new URL(requestUrl || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "i" && parts[2] === "setup";
}

function normalizeInstanceId(value = ""): string {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
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
    <small>This link only works for this browser after the challenge is pasted back to the Orkestr chat.</small>
  </main>
  <script>
    const parts = location.pathname.split('/').filter(Boolean);
    const shareId = parts[parts.length - 1] || '';
    const subdomain = parts.length > 2 ? parts[1] : '';
    const key = new URLSearchParams(location.search).get('key') || '';
    const challenge = document.getElementById('challenge');
    const statusNode = document.getElementById('status');
    const summary = document.getElementById('summary');
    const open = document.getElementById('open');
    const mobile = document.getElementById('mobile');
    const copy = document.getElementById('copy');
    const api = (action) => '/api/desktop-shares/' + encodeURIComponent(shareId) + '/' + action + '?key=' + encodeURIComponent(key) + (subdomain ? '&subdomain=' + encodeURIComponent(subdomain) : '');
    function mobileDestination(value) {
      const parsed = new URL(value, location.origin);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'desktop' && parts[1] && parts[2] === 'vnc.html') {
        return '/desktop/' + encodeURIComponent(decodeURIComponent(parts[1])) + '/mobile';
      }
      return value;
    }
    async function json(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || body.message || 'desktop_share_failed');
      return body;
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
        statusNode.textContent = error.message || String(error);
        statusNode.className = 'error';
      }
    }
    async function start() {
      try {
        const body = await json(api('open'));
        const value = body.attempt && body.attempt.challenge ? body.attempt.challenge : '';
        challenge.textContent = 'orkestr desktop approve ' + value;
        summary.textContent = 'Copy this challenge and paste it into the Orkestr chat that requested the desktop.';
        statusNode.textContent = 'Waiting for approval from chat.';
        poll();
      } catch (error) {
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
