import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { adminPrincipal } from "./principal.js";
import { isAdminPrincipal } from "./policy.js";
import { defaultAdminUser, normalizeUserId } from "./users.js";

const shareCookieName = "orkestr_desktop_share";
const shareAuditTtlMs = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function secretPath(env = process.env) {
  return `${dataPaths(env).secrets}/desktop-shares.json`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function randomDnsLabel() {
  return `d-${crypto.randomBytes(9).toString("hex")}`;
}

function randomChallenge() {
  return `desk-${randomToken(18)}`;
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shareTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_DESKTOP_SHARE_TTL_MS || 15 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(60_000, parsed) : 15 * 60 * 1000;
}

function accessTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_DESKTOP_SHARE_ACCESS_TTL_MS || 30 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(60_000, parsed) : 30 * 60 * 1000;
}

function requestIp(request) {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

function desktopShareError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeAttempt(attempt = {}, now = Date.now()) {
  const expiresAt = String(attempt.expiresAt || "").trim();
  const expired = Date.parse(expiresAt || "") <= now;
  const status = String(attempt.status || (attempt.approvedAt ? "approved" : "pending")).trim() || "pending";
  return {
    id: String(attempt.id || randomToken(10)).trim(),
    tokenHash: String(attempt.tokenHash || "").trim(),
    challenge: String(attempt.challenge || "").trim(),
    status: status === "pending" && expired ? "expired" : status,
    createdAt: String(attempt.createdAt || "").trim() || nowIso(),
    expiresAt,
    openedAt: String(attempt.openedAt || "").trim() || null,
    approvedAt: String(attempt.approvedAt || "").trim() || null,
    approvedBy: String(attempt.approvedBy || "").trim() || null,
    userAgent: String(attempt.userAgent || "").slice(0, 240),
    ip: String(attempt.ip || "").slice(0, 80),
  };
}

function normalizeShare(share = {}, now = Date.now()) {
  const expiresAt = String(share.expiresAt || "").trim();
  const expired = Date.parse(expiresAt || "") <= now;
  const status = String(share.status || "pending").trim() || "pending";
  return {
    id: String(share.id || "").trim(),
    desktopSlug: cleanSlug(share.desktopSlug || share.slug),
    ownerUserId: normalizeUserId(share.ownerUserId || share.userId || "admin"),
    subdomain: String(share.subdomain || "").trim().toLowerCase(),
    keyHash: String(share.keyHash || "").trim(),
    status: status === "pending" && expired ? "expired" : status,
    createdAt: String(share.createdAt || "").trim() || nowIso(),
    expiresAt,
    createdBy: String(share.createdBy || "").trim() || null,
    label: String(share.label || "").trim() || null,
    attempts: Array.isArray(share.attempts) ? share.attempts.map((attempt) => normalizeAttempt(attempt, now)) : [],
  };
}

function keepShare(share, now = Date.now()) {
  const expiresMs = Date.parse(share.expiresAt || "");
  if (Number.isFinite(expiresMs) && expiresMs > now) return true;
  return Number.isFinite(expiresMs) && expiresMs + shareAuditTtlMs > now;
}

async function readState(env = process.env) {
  const state = await readJson(secretPath(env), { desktopShares: [] });
  const now = Date.now();
  return {
    desktopShares: Array.isArray(state.desktopShares)
      ? state.desktopShares.map((share) => normalizeShare(share, now)).filter((share) => share.id && keepShare(share, now))
      : [],
  };
}

async function writeState(state, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  await writeSecretJson(secretPath(env), {
    desktopShares: (state.desktopShares || []).map((share) => normalizeShare(share, now)).filter((share) => keepShare(share, now)),
    updatedAt: nowIso(),
  });
}

function publicShare(share) {
  if (!share) return null;
  return {
    id: share.id,
    desktopSlug: share.desktopSlug,
    ownerUserId: share.ownerUserId,
    subdomain: share.subdomain,
    status: share.status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    label: share.label,
  };
}

function publicAttempt(attempt, { includeChallenge = false } = {}) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    status: attempt.status,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    approvedAt: attempt.approvedAt,
    challenge: includeChallenge ? attempt.challenge : undefined,
  };
}

function ownerUserIdForPrincipal(principal = null, fallback = "", env = process.env) {
  if (principal?.userId && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(fallback || principal?.userId || env.ORKESTR_ADMIN_USER_ID || defaultAdminUser(env).id);
}

function publicHttpsBase(env = process.env) {
  return String(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "").trim().replace(/\/+$/, "");
}

function shareBaseDomain(env = process.env) {
  return String(env.ORKESTR_DESKTOP_SHARE_BASE_DOMAIN || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
}

export function desktopShareSubdomainFromHost(host = "", env = process.env) {
  const domain = shareBaseDomain(env);
  if (!domain) return "";
  const normalizedHost = String(host || "").trim().toLowerCase().split(":")[0];
  if (!normalizedHost.endsWith(`.${domain}`)) return "";
  return normalizedHost.slice(0, -domain.length - 1);
}

function desktopShareUrl(share, key, env = process.env) {
  const template = String(env.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE || "").trim();
  if (template) {
    return template
      .replaceAll("{subdomain}", encodeURIComponent(share.subdomain))
      .replaceAll("{shareId}", encodeURIComponent(share.id))
      .replaceAll("{id}", encodeURIComponent(share.id))
      .replaceAll("{key}", encodeURIComponent(key));
  }
  const domain = shareBaseDomain(env);
  if (domain) {
    return `https://${share.subdomain}.${domain}/desktop-share/${encodeURIComponent(share.id)}?key=${encodeURIComponent(key)}`;
  }
  const base = publicHttpsBase(env) || `http://127.0.0.1:${String(env.ORKESTR_PORT || "19812").trim() || "19812"}`;
  return `${base}/desktop-share/${encodeURIComponent(share.subdomain)}/${encodeURIComponent(share.id)}?key=${encodeURIComponent(key)}`;
}

function assertShareActive(share, now = Date.now()) {
  if (!share) throw desktopShareError("desktop_share_not_found", 404);
  if (share.status === "expired" || Date.parse(share.expiresAt || "") <= now) {
    throw desktopShareError("desktop_share_expired", 401);
  }
  if (share.status === "revoked") throw desktopShareError("desktop_share_revoked", 401);
}

function assertShareKey(share, key) {
  if (!share.keyHash || sha256(key) !== share.keyHash) {
    throw desktopShareError("desktop_share_key_invalid", 401);
  }
}

function assertShareSubdomain(share, subdomain = "") {
  const value = String(subdomain || "").trim().toLowerCase();
  if (value && value !== share.subdomain) throw desktopShareError("desktop_share_subdomain_invalid", 404);
}

function desktopUrlForShare(share) {
  const slug = encodeURIComponent(share.desktopSlug);
  return `/desktop/${slug}/vnc.html?autoconnect=1&resize=scale`;
}

export function desktopShareCookieName() {
  return shareCookieName;
}

export function desktopShareCookieHeader(value, env = process.env, maxAgeMs = accessTtlMs(env)) {
  const secure = String(env.ORKESTR_COOKIE_SECURE || "").trim() === "1" || publicHttpsBase(env).startsWith("https://") || Boolean(shareBaseDomain(env));
  return [
    `${shareCookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function cookieValue(header, name = shareCookieName) {
  const raw = String(header || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function parseShareCookie(header) {
  const value = cookieValue(header);
  const [shareId, token] = value.split(":");
  return { shareId: String(shareId || "").trim(), token: String(token || "").trim() };
}

export async function createDesktopShare({ desktopSlug = "", slug = "", ownerUserId = "", principal = null, label = "", env = process.env } = {}) {
  const normalizedSlug = cleanSlug(desktopSlug || slug);
  if (!normalizedSlug) throw desktopShareError("desktop_slug_required", 400);
  const key = randomToken(32);
  const share = normalizeShare({
    id: randomToken(12),
    desktopSlug: normalizedSlug,
    ownerUserId: ownerUserIdForPrincipal(principal, ownerUserId, env),
    subdomain: randomDnsLabel(),
    keyHash: sha256(key),
    status: "pending",
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + shareTtlMs(env)).toISOString(),
    createdBy: principal?.userId || "system",
    label,
    attempts: [],
  });
  const state = await readState(env);
  await writeState({ desktopShares: [share, ...state.desktopShares] }, env);
  const url = desktopShareUrl(share, key, env);
  await appendEvent({ type: "desktop_share_created", desktopSlug: share.desktopSlug, ownerUserId: share.ownerUserId, shareId: share.id }, env).catch(() => {});
  return {
    ok: true,
    share: publicShare(share),
    url,
    key,
    subdomain: share.subdomain,
    wildcardSubdomainConfigured: Boolean(shareBaseDomain(env) || String(env.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE || "").trim()),
  };
}

export async function openDesktopShare({ shareId = "", key = "", browserToken = "", subdomain = "", request = null, env = process.env } = {}) {
  const state = await readState(env);
  const now = Date.now();
  const id = String(shareId || "").trim();
  const shareIndex = state.desktopShares.findIndex((item) => item.id === id);
  const share = shareIndex >= 0 ? state.desktopShares[shareIndex] : null;
  assertShareActive(share, now);
  assertShareKey(share, key);
  assertShareSubdomain(share, subdomain);

  let token = String(browserToken || "").trim();
  let attempt = token
    ? share.attempts.find((item) => item.tokenHash === sha256(token) && Date.parse(item.expiresAt || "") > now)
    : null;
  if (!attempt) {
    token = randomToken(32);
    attempt = normalizeAttempt({
      id: randomToken(10),
      tokenHash: sha256(token),
      challenge: randomChallenge(),
      status: "pending",
      createdAt: nowIso(),
      openedAt: nowIso(),
      expiresAt: new Date(now + accessTtlMs(env)).toISOString(),
      userAgent: String(request?.headers?.["user-agent"] || "").slice(0, 240),
      ip: requestIp(request).slice(0, 80),
    }, now);
    share.attempts = [attempt, ...share.attempts];
  }
  state.desktopShares[shareIndex] = { ...share, status: attempt.status === "approved" ? "active" : share.status };
  await writeState(state, env);
  return {
    ok: true,
    share: publicShare(state.desktopShares[shareIndex]),
    attempt: publicAttempt(attempt, { includeChallenge: true }),
    approved: attempt.status === "approved",
    desktopUrl: attempt.status === "approved" ? desktopUrlForShare(share) : "",
    cookie: {
      value: `${share.id}:${token}`,
      header: desktopShareCookieHeader(`${share.id}:${token}`, env),
    },
  };
}

export async function desktopShareStatus({ shareId = "", key = "", browserToken = "", subdomain = "", env = process.env } = {}) {
  const state = await readState(env);
  const now = Date.now();
  const share = state.desktopShares.find((item) => item.id === String(shareId || "").trim());
  assertShareActive(share, now);
  assertShareKey(share, key);
  assertShareSubdomain(share, subdomain);
  const attempt = String(browserToken || "").trim()
    ? share.attempts.find((item) => item.tokenHash === sha256(browserToken) && Date.parse(item.expiresAt || "") > now)
    : null;
  return {
    ok: true,
    share: publicShare(share),
    attempt: publicAttempt(attempt),
    approved: attempt?.status === "approved",
    desktopUrl: attempt?.status === "approved" ? desktopUrlForShare(share) : "",
  };
}

export async function approveDesktopShareChallenge(challenge = "", { env = process.env, approvedBy = "thread" } = {}) {
  const value = String(challenge || "").trim();
  if (!value) throw desktopShareError("desktop_share_challenge_required", 400);
  const state = await readState(env);
  const now = Date.now();
  let approved = null;
  for (const share of state.desktopShares) {
    if (share.status === "expired" || share.status === "revoked" || Date.parse(share.expiresAt || "") <= now) continue;
    for (const attempt of share.attempts) {
      if (attempt.challenge !== value || attempt.status !== "pending" || Date.parse(attempt.expiresAt || "") <= now) continue;
      attempt.status = "approved";
      attempt.approvedAt = nowIso();
      attempt.approvedBy = String(approvedBy || "thread").slice(0, 80);
      share.status = "active";
      approved = { share, attempt };
      break;
    }
    if (approved) break;
  }
  if (!approved) throw desktopShareError("desktop_share_challenge_not_found", 404);
  await writeState(state, env);
  await appendEvent({
    type: "desktop_share_challenge_approved",
    shareId: approved.share.id,
    desktopSlug: approved.share.desktopSlug,
    ownerUserId: approved.share.ownerUserId,
    attemptId: approved.attempt.id,
    approvedBy,
  }, env).catch(() => {});
  return {
    ok: true,
    share: publicShare(approved.share),
    attempt: publicAttempt(approved.attempt),
    desktopUrl: desktopUrlForShare(approved.share),
  };
}

export async function authorizeDesktopShareHttpRequest(request, env = process.env) {
  const url = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "desktop" || !parts[1]) return null;
  const requestedSlug = cleanSlug(decodeURIComponent(parts[1]));
  const { shareId, token } = parseShareCookie(request?.headers?.cookie || "");
  if (!shareId || !token) return null;
  const state = await readState(env);
  const now = Date.now();
  const share = state.desktopShares.find((item) => item.id === shareId);
  if (!share) return null;
  assertShareActive(share, now);
  if (share.desktopSlug !== requestedSlug) throw desktopShareError("desktop_share_slug_forbidden", 403);
  const attempt = share.attempts.find((item) => item.tokenHash === sha256(token) && Date.parse(item.expiresAt || "") > now);
  if (!attempt || attempt.status !== "approved") return null;
  const principal = share.ownerUserId === normalizeUserId(defaultAdminUser(env).id)
    ? adminPrincipal(defaultAdminUser(env))
    : {
        kind: "user",
        userId: share.ownerUserId,
        role: "user",
        source: "desktop-share",
        displayName: share.ownerUserId,
      };
  return {
    ok: true,
    principal,
    share: publicShare(share),
    attempt: publicAttempt(attempt),
  };
}
