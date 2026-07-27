import { createHmac, timingSafeEqual } from "node:crypto";
import { googleWorkspaceReviewAccessEnabled } from "./google-workspace-review-access.js";

function clean(value = "") {
  return String(value || "").trim();
}

function reviewEnvironmentSecret(env = process.env) {
  return clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET);
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

function signature(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameSignature(left, right) {
  const actual = Buffer.from(clean(left), "base64url");
  const expected = Buffer.from(clean(right), "base64url");
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

export function googleWorkspaceReviewEnvironmentTtlMs(env = process.env) {
  return reviewEnvironmentTtlMinutes(env) * 60_000;
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
  const ticket = createGoogleWorkspaceReviewEnvironmentTicket(input, env);
  const path = googleWorkspaceReviewEnvironmentPath(ticket);
  const base = reviewPublicBaseUrl(env);
  return {
    ok: true,
    ticket,
    path,
    link: base ? new URL(path, `${base}/`).toString() : path,
    expiresAt: verifyGoogleWorkspaceReviewEnvironmentTicket(ticket, {}, env).expiresAt,
  };
}
