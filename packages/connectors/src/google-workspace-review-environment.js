import { createHmac, timingSafeEqual } from "node:crypto";
import { googleWorkspaceReviewAccessEnabled } from "./google-workspace-review-access.js";

function clean(value = "") {
  return String(value || "").trim();
}

function reviewEnvironmentSecret(env = process.env) {
  return clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET);
}

function reviewEnvironmentPassword(env = process.env) {
  return clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD);
}

function reviewEnvironmentError(message, statusCode = 403) {
  const error = new Error(message);
  error.code = message;
  error.statusCode = statusCode;
  return error;
}

function reviewEnvironmentTtlMinutes(env = process.env) {
  const configured = Number(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES || 240);
  return Math.max(5, Math.min(1_440, Number.isFinite(configured) ? configured : 240));
}

function reviewSessionTtlMinutes(env = process.env) {
  const configured = Number(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_SESSION_TTL_MINUTES || 43_200);
  return Math.max(60, Math.min(129_600, Number.isFinite(configured) ? configured : 43_200));
}

export function googleWorkspaceReviewEnvironmentIdentity(env = process.env) {
  return {
    userId: clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID) || "google-reviewer",
    threadId: clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID) || "google-oauth-reviewer",
  };
}

function signature(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameSignature(left, right) {
  const actual = Buffer.from(clean(left), "base64url");
  const expected = Buffer.from(clean(right), "base64url");
  return actual.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sameValue(left, right) {
  const actual = Buffer.from(clean(left));
  const expected = Buffer.from(clean(right));
  return actual.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseTicket(ticket = "") {
  const value = clean(ticket);
  if (!value || value.length > 4096) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? { encoded: parts[0], signature: parts[1], payload } : null;
  } catch {
    return null;
  }
}

function reviewPublicBaseUrl(env = process.env) {
  const configured = clean(
    env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL ||
      env.ORKESTR_CONNECT_PUBLIC_URL ||
      env.ORKESTR_PUBLIC_URL ||
      env.ORKESTR_APP_URL,
  ).replace(/\/+$/g, "");
  if (!configured) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return "";
    url.pathname = url.pathname.replace(/\/+$/g, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

export function googleWorkspaceReviewEnvironmentEnabled(env = process.env) {
  return googleWorkspaceReviewAccessEnabled(env);
}

export function googleWorkspaceReviewPasswordAccessEnabled(env = process.env) {
  return googleWorkspaceReviewEnvironmentEnabled(env) && reviewEnvironmentPassword(env).length >= 16;
}

export function googleWorkspaceReviewEnvironmentTtlMs(env = process.env) {
  return reviewEnvironmentTtlMinutes(env) * 60_000;
}

export function googleWorkspaceReviewSessionTtlMs(env = process.env) {
  return reviewSessionTtlMinutes(env) * 60_000;
}

export function googleWorkspaceReviewSessionCookieName() {
  return "orkestr_google_workspace_review";
}

export function googleWorkspaceReviewSessionCookieHeader(token = "", env = process.env) {
  const value = clean(token);
  if (!value) return "";
  const secure = reviewPublicBaseUrl(env).startsWith("https://") ? "; Secure" : "";
  const maxAge = Math.floor(googleWorkspaceReviewSessionTtlMs(env) / 1_000);
  return `${googleWorkspaceReviewSessionCookieName()}=${encodeURIComponent(value)}; Path=/review/google; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function googleWorkspaceReviewSessionFromCookie(cookieHeader = "") {
  const name = googleWorkspaceReviewSessionCookieName();
  for (const part of String(cookieHeader || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return clean(decodeURIComponent(value.join("=")));
    } catch {
      return "";
    }
  }
  return "";
}

export function verifyGoogleWorkspaceReviewPassword(password = "", env = process.env) {
  return googleWorkspaceReviewPasswordAccessEnabled(env) && sameValue(password, reviewEnvironmentPassword(env));
}

export function createGoogleWorkspaceReviewSession({ userId = "", threadId = "", expiresAt = "" } = {}, env = process.env) {
  if (!googleWorkspaceReviewPasswordAccessEnabled(env)) {
    throw reviewEnvironmentError("google_workspace_review_password_not_configured");
  }
  const expiresAtMs = clean(expiresAt)
    ? Date.parse(clean(expiresAt))
    : Date.now() + googleWorkspaceReviewSessionTtlMs(env);
  if (!clean(userId) || !clean(threadId) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw reviewEnvironmentError("google_workspace_review_session_invalid_request", 400);
  }
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    scope: "google_workspace_review_session",
    userId: clean(userId),
    threadId: clean(threadId),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })).toString("base64url");
  return `${encoded}.${signature(encoded, reviewEnvironmentSecret(env))}`;
}

export function verifyGoogleWorkspaceReviewSession(token = "", env = process.env) {
  const parsed = parseTicket(token);
  if (!parsed) return { ok: false, present: Boolean(clean(token)), reason: "malformed" };
  if (!googleWorkspaceReviewPasswordAccessEnabled(env)) return { ok: false, present: true, reason: "disabled" };
  if (!sameSignature(parsed.signature, signature(parsed.encoded, reviewEnvironmentSecret(env)))) {
    return { ok: false, present: true, reason: "signature" };
  }
  const expiresAtMs = Date.parse(clean(parsed.payload.expiresAt));
  if (
    parsed.payload.v !== 1 ||
    parsed.payload.scope !== "google_workspace_review_session" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    !clean(parsed.payload.userId) ||
    !clean(parsed.payload.threadId)
  ) {
    return { ok: false, present: true, reason: "binding_or_expiry" };
  }
  return {
    ok: true,
    present: true,
    userId: clean(parsed.payload.userId),
    threadId: clean(parsed.payload.threadId),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function createGoogleWorkspaceReviewEnvironmentTicket({ userId = "", threadId = "", expiresAt = "" } = {}, env = process.env) {
  if (!googleWorkspaceReviewEnvironmentEnabled(env)) {
    throw reviewEnvironmentError("google_workspace_review_access_not_configured");
  }
  const requestedExpiry = clean(expiresAt);
  const expiresAtMs = requestedExpiry
    ? Date.parse(requestedExpiry)
    : Date.now() + googleWorkspaceReviewEnvironmentTtlMs(env);
  if (!clean(userId) || !clean(threadId) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw reviewEnvironmentError("google_workspace_review_environment_invalid_request", 400);
  }
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    scope: "google_workspace_review_environment",
    userId: clean(userId),
    threadId: clean(threadId),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })).toString("base64url");
  return `${encoded}.${signature(encoded, reviewEnvironmentSecret(env))}`;
}

export function verifyGoogleWorkspaceReviewEnvironmentTicket(ticket = "", expected = {}, env = process.env) {
  const parsed = parseTicket(ticket);
  if (!parsed) return { ok: false, present: Boolean(clean(ticket)), reason: "malformed" };
  if (!googleWorkspaceReviewEnvironmentEnabled(env)) return { ok: false, present: true, reason: "disabled" };
  if (!sameSignature(parsed.signature, signature(parsed.encoded, reviewEnvironmentSecret(env)))) {
    return { ok: false, present: true, reason: "signature" };
  }
  const expiresAtMs = Date.parse(clean(parsed.payload.expiresAt));
  const userId = clean(expected.userId || parsed.payload.userId);
  const threadId = clean(expected.threadId || parsed.payload.threadId);
  if (
    parsed.payload.v !== 1 ||
    parsed.payload.scope !== "google_workspace_review_environment" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    !userId ||
    !threadId ||
    clean(parsed.payload.userId) !== userId ||
    clean(parsed.payload.threadId) !== threadId
  ) {
    return { ok: false, present: true, reason: "binding_or_expiry" };
  }
  return {
    ok: true,
    present: true,
    userId,
    threadId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function googleWorkspaceReviewEnvironmentPath(ticket = "") {
  const value = clean(ticket);
  return value ? `/review/google/${encodeURIComponent(value)}` : "";
}

export function createGoogleWorkspaceReviewEnvironmentLink(input = {}, env = process.env) {
  if (!googleWorkspaceReviewPasswordAccessEnabled(env)) {
    throw reviewEnvironmentError("google_workspace_review_password_not_configured");
  }
  const identity = googleWorkspaceReviewEnvironmentIdentity(env);
  if (clean(input.threadId) && clean(input.threadId) !== identity.threadId) {
    throw reviewEnvironmentError("google_workspace_review_environment_identity_mismatch", 400);
  }
  const base = reviewPublicBaseUrl(env);
  return {
    ok: true,
    path: "/review/google",
    link: base ? new URL("/review/google", `${base}/`).toString() : "/review/google",
    sessionTtlMs: googleWorkspaceReviewSessionTtlMs(env),
  };
}
