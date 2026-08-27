import type { INestApplication } from "@nestjs/common";
import { canonicalAppGatewayEnabled } from "../../../packages/core/src/canonical-public-references.js";
import { readInstanceIdentity } from "../../../packages/core/src/instance-identity.js";
import { publicUrlConfig } from "../../../packages/core/src/public-url-config.js";

export function legacyInstanceRouteTarget(rawUrl = "", { setupReady = false } = {}): string {
  const parsed = new URL(rawUrl || "/", "http://orkestr.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  let target = "";
  if (parts[0] === "launcher" || (parts[0] === "ng" && parts[1] === "launcher")) target = "/launcher";
  else if (parts[0] === "files" || (parts[0] === "ng" && parts[1] === "files")) target = "/files";
  else if (parts[0] === "timers" || (parts[0] === "ng" && parts[1] === "timers")) target = "/timers";
  else if (["desktops", "desk"].includes(parts[0]) || (parts[0] === "ng" && parts[1] === "desk")) target = "/desktops";
  else if (parts[0] === "jobs" || (parts[0] === "ng" && parts[1] === "jobs")) target = "/settings";
  else if (parts[0] === "settings") target = "/settings";
  else if (parts[0] === "ops" || parts[0] === "mailboxes") target = "/settings";
  else if (parts[0] === "connectors" && !parts[1]) target = "/settings";
  else if (parts[0] === "ng" && parts[1] === "ops") target = "/settings";
  else if (parts[0] === "ng" && parts[1] === "connectors" && !parts[2]) target = "/settings";
  else if (parts[0] === "onboarding" || (parts[0] === "ng" && parts[1] === "onboarding")) target = setupReady ? "/settings" : "/setup/system";
  else if (parts[0] === "setup" && parts[1] !== "pairing") target = setupReady ? "/settings" : parsed.pathname;
  if (!target) return "";
  return `${target}${parsed.search}${parsed.hash}`;
}

function requestHost(request: any): string {
  return String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function loopbackHost(host = ""): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(host || "").toLowerCase());
}

function appHostnames(env = process.env): Set<string> {
  const result = new Set<string>();
  const configured = String(env.ORKESTR_APP_HOST || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (configured) result.add(configured);
  const appUrl = String(publicUrlConfig(env).appUrl || "").trim();
  if (appUrl) {
    try { result.add(new URL(appUrl).hostname.toLowerCase()); } catch { /* invalid config is handled elsewhere */ }
  }
  return result;
}

function redirectBase(env = process.env): string {
  const appUrl = String(publicUrlConfig(env).appUrl || "").trim().replace(/\/+$/, "");
  return appUrl;
}

export function registerLegacyInstanceRedirects(app: INestApplication): void {
  if (!canonicalAppGatewayEnabled(process.env)) return;
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use((request: any, response: any, next: () => void) => {
    if (!request?.orkestrPrincipal || !["GET", "HEAD"].includes(String(request.method || "GET").toUpperCase())) return next();
    const hosts = appHostnames(process.env);
    const host = requestHost(request);
    if (hosts.size && !hosts.has(host) && !loopbackHost(host)) return next();
    const suffix = legacyInstanceRouteTarget(String(request.originalUrl || request.url || "/"));
    if (!suffix) return next();
    void readInstanceIdentity(process.env).then((identity) => {
      if (!identity?.publicRef) return next();
      const canonicalPath = `/instance/${encodeURIComponent(identity.publicRef)}${suffix}`;
      const base = redirectBase(process.env);
      const location = base ? new URL(canonicalPath, `${base}/`).toString() : canonicalPath;
      response
        .status(302)
        .header("cache-control", "no-store")
        .header("deprecation", "true")
        .header("link", `<${location}>; rel=\"canonical\"`)
        .header("location", location)
        .type("text/plain; charset=utf-8")
        .send("Redirecting to the Orkestr instance cockpit.");
    }).catch(() => next());
  });
}
