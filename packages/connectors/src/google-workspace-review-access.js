import { createHmac, timingSafeEqual } from "node:crypto";

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value = "") {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function reviewSecret(env = process.env) {
  return clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET);
}

function reviewAccessError(message, statusCode = 403) {
  const error = new Error(message);
  error.code = message;
  error.statusCode = statusCode;
  return error;
}

function maxTtlMinutes(env = process.env) {
  const configured = Number(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_TTL_MINUTES || 10_080);
  return Math.max(5, Math.min(43_200, Number.isFinite(configured) ? configured : 10_080));
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

export function googleWorkspaceReviewAccessEnabled(env = process.env) {
  return truthy(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED) && reviewSecret(env).length >= 32;
}

export function googleWorkspaceReviewAccessTtlMs(env = process.env) {
  return maxTtlMinutes(env) * 60_000;
}

export function createGoogleWorkspaceReviewAccessTicket({ connectId = "", userId = "", expiresAt = "" } = {}, env = process.env) {
  if (!googleWorkspaceReviewAccessEnabled(env)) {
    throw reviewAccessError("google_workspace_review_access_not_configured");
  }
  const expiresAtMs = Date.parse(clean(expiresAt));
  if (!clean(connectId) || !clean(userId) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw reviewAccessError("google_workspace_review_access_invalid_request", 400);
  }
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    connectId: clean(connectId),
    userId: clean(userId),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })).toString("base64url");
  return `${encoded}.${signature(encoded, reviewSecret(env))}`;
}

export function verifyGoogleWorkspaceReviewAccessTicket(ticket = "", { connectId = "", userId = "" } = {}, env = process.env) {
  const parsed = parseTicket(ticket);
  if (!parsed) return { ok: false, present: Boolean(clean(ticket)), reason: "malformed" };
  if (!googleWorkspaceReviewAccessEnabled(env)) return { ok: false, present: true, reason: "disabled" };
  if (!sameSignature(parsed.signature, signature(parsed.encoded, reviewSecret(env)))) {
    return { ok: false, present: true, reason: "signature" };
  }
  const expiresAtMs = Date.parse(clean(parsed.payload.expiresAt));
  if (
    parsed.payload.v !== 1 ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    clean(parsed.payload.connectId) !== clean(connectId) ||
    clean(parsed.payload.userId) !== clean(userId)
  ) {
    return { ok: false, present: true, reason: "binding_or_expiry" };
  }
  return { ok: true, present: true, expiresAt: new Date(expiresAtMs).toISOString() };
}
