import { isAdminPrincipal } from "../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../packages/core/src/principal.js";
import { directLoopbackRequest, effectiveRequestOrigin, trustedProxy } from "./host-boundaries.js";

// Shared request checks for state-changing connector handlers (ORK-512/513).

/** True when the request only passed authentication through the pre-pairing allowlist. */
export function requestIsAnonymous(request: any): boolean {
  return request?.orkestrAnonymous === true;
}

/** The verified principal, or null for anonymous pre-pairing requests. */
export function authenticatedPrincipal(request: any): any | null {
  if (requestIsAnonymous(request)) return null;
  const principal = requestPrincipal(request);
  return principal?.userId ? principal : null;
}

/** An administrator that authenticated with a session, machine credential, or local no-auth mode. */
export function authenticatedAdminPrincipal(request: any): any | null {
  const principal = authenticatedPrincipal(request);
  if (!principal || !isAdminPrincipal(principal)) return null;
  // Scoped auth-intent sessions (for example a Google connect approval) are
  // not administrator sessions even when they were minted for an admin user.
  const session = request?.orkestrSecuritySession;
  const actions = Array.isArray(session?.allowedActions) ? session.allowedActions : [];
  if (actions.some((action: string) => String(action || "").startsWith("orkestr_auth."))) return null;
  if (session?.shareId) return null;
  return principal;
}

export function requestSessionId(request: any): string {
  return String(request?.orkestrSecuritySession?.id || "").trim();
}

/** Lower-case host of the effective request origin; binds intents to the initiating host. */
export function requestIntentHost(request: any, env = process.env): string {
  const origin = effectiveRequestOrigin(request, env);
  if (origin) return new URL(origin).host.toLowerCase();
  return String(request?.headers?.host || "").trim().toLowerCase();
}

/** Host used for OAuth callback host binding. Direct local loopback calls are exempt. */
export function callbackRequestHost(request: any, env = process.env): string {
  if (directLoopbackRequest(request)) return "";
  return requestIntentHost(request, env);
}

function headerValue(request: any, name: string): string {
  const value = request?.headers?.[name];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

/**
 * CSRF/origin policy for state-changing browser requests. A present Origin
 * must equal the request origin; a cross-site fetch-metadata signal is always
 * rejected. With `requireOrigin`, a missing Origin also fails (used where the
 * only credential is a bearer intent sent from a browser page).
 */
export function originPolicyViolation(request: any, env = process.env, options: { requireOrigin?: boolean } = {}): string {
  const origin = headerValue(request, "origin");
  const fetchSite = headerValue(request, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site") return "cross_site_request";
  if (!origin) return options.requireOrigin ? "origin_required" : "";
  if (origin === "null") return "origin_not_allowed";
  const expected = effectiveRequestOrigin(request, env);
  if (!expected) return "origin_not_allowed";
  return origin.toLowerCase() === expected.toLowerCase() ? "" : "origin_not_allowed";
}

/**
 * Source identity for throttling; hashed before it is persisted. Behind an
 * explicitly trusted reverse proxy, the client address it appended to
 * X-Forwarded-For is used; otherwise the socket peer address.
 */
export function requestSourceKey(request: any, env = process.env): string {
  const peer = String(request?.socket?.remoteAddress || request?.ip || "").trim().replace(/^::ffff:/, "");
  if (trustedProxy(request, env)) {
    const forwarded = headerValue(request, "x-forwarded-for").split(",").map((item) => item.trim()).filter(Boolean);
    const client = forwarded[forwarded.length - 1];
    if (client) return client.replace(/^::ffff:/, "");
  }
  return peer || "unknown";
}

export function jsonRequest(request: any): boolean {
  return /^application\/json(?:\s*;|$)/i.test(headerValue(request, "content-type"));
}
