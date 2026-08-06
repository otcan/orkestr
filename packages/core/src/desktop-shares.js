import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { adminPrincipal } from "./principal.js";
import { isAdminPrincipal } from "./policy.js";
import { defaultAdminUser, normalizeUserId } from "./users.js";
import { assertDesktopAccess, authorizeDesktopAccess, desktopAccessMode, desktopBoundaryId } from "./desktop-access.js";
import {
  desktopShareBaseDomain,
  desktopShareCookieHeader,
  desktopShareSubdomainFromHost,
  desktopShareUrl,
  parseDesktopShareCookie,
} from "./desktop-share-http.js";

export { desktopShareCookieHeader, desktopShareCookieName, desktopShareSubdomainFromHost } from "./desktop-share-http.js";

const shareAuditTtlMs = 24 * 60 * 60 * 1000;
const defaultShareTtlMs = 60 * 60 * 1000;
const defaultAccessTtlMs = 30 * 60 * 1000;

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
  const parsed = Number(env.ORKESTR_DESKTOP_SHARE_TTL_MS || defaultShareTtlMs);
  return Number.isFinite(parsed) ? Math.max(60_000, parsed) : defaultShareTtlMs;
}

function accessTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_DESKTOP_SHARE_ACCESS_TTL_MS || defaultAccessTtlMs);
  return Number.isFinite(parsed) ? Math.max(60_000, parsed) : defaultAccessTtlMs;
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
    threadId: String(share.threadId || "").trim() || null,
    desktopId: String(share.desktopId || share.resourceId || "").trim() || null,
    boundaryId: String(share.boundaryId || share.tenantVmId || "").trim() || null,
    grantRevision: Math.max(0, Number(share.grantRevision || 0) || 0),
    policyRevision: Math.max(0, Number(share.policyRevision || 0) || 0),
    desktopGeneration: Math.max(1, Number(share.desktopGeneration || 1) || 1),
    breakGlass: share.breakGlass === true,
    breakGlassReason: String(share.breakGlassReason || "").trim() || null,
    subdomain: String(share.subdomain || "").trim().toLowerCase(),
    keyHash: String(share.keyHash || "").trim(),
    status: status === "pending" && expired ? "expired" : status,
    createdAt: String(share.createdAt || "").trim() || nowIso(),
    expiresAt,
    supersededAt: String(share.supersededAt || "").trim() || null,
    supersededBy: String(share.supersededBy || "").trim() || null,
    revokedAt: String(share.revokedAt || "").trim() || null,
    revokeReason: String(share.revokeReason || "").trim() || null,
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
  const enforce = desktopAccessMode(env) === "enforce";
  return {
    desktopShares: Array.isArray(state.desktopShares)
      ? state.desktopShares
          .map((share) => normalizeShare(share, now))
          .map((share) => enforce && !(share.breakGlass && share.breakGlassReason) && (!share.threadId || !share.desktopId || !share.boundaryId || !share.grantRevision)
            ? { ...share, status: "revoked", revokedAt: share.revokedAt || nowIso(), revokeReason: "legacy_share_missing_thread_scope" }
            : share)
          .filter((share) => share.id && keepShare(share, now))
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
    threadId: share.threadId,
    desktopId: share.desktopId,
    boundaryId: share.boundaryId,
    grantRevision: share.grantRevision,
    desktopGeneration: share.desktopGeneration,
    breakGlass: share.breakGlass === true,
    subdomain: share.subdomain,
    status: share.status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    supersededAt: share.supersededAt || null,
    supersededBy: share.supersededBy || null,
    revokedAt: share.revokedAt || null,
    revokeReason: share.revokeReason || null,
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

function assertShareActive(share, now = Date.now()) {
  if (!share) throw desktopShareError("desktop_share_not_found", 404);
  if (share.status === "expired" || Date.parse(share.expiresAt || "") <= now) {
    throw desktopShareError("desktop_share_expired", 401);
  }
  if (share.status === "revoked") throw desktopShareError("desktop_share_revoked", 401);
  if (share.status === "superseded") throw desktopShareError("desktop_share_superseded", 409);
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

export async function desktopShareRenewalHint({ shareId = "", key = "", subdomain = "", env = process.env } = {}) {
  const state = await readState(env);
  const id = String(shareId || "").trim();
  const share = state.desktopShares.find((item) => item.id === id);
  if (!share) return null;
  try {
    assertShareKey(share, key);
    assertShareSubdomain(share, subdomain);
  } catch {
    return null;
  }
  if (share.status !== "expired" && Date.parse(share.expiresAt || "") > Date.now()) return null;
  return {
    desktopSlug: share.desktopSlug,
    shareId: share.id,
    expiredAt: share.expiresAt,
    renewCommand: `orkestr desktop share ${share.desktopSlug}`,
    message: `This desktop link expired. Ask the Orkestr operator to run: orkestr desktop share ${share.desktopSlug}`,
  };
}

function desktopUrlForShare(share) {
  const slug = encodeURIComponent(share.desktopSlug);
  return `/desktop/${slug}/vnc.html?autoconnect=1&resize=scale&path=desktop/${slug}/websockify`;
}

function principalForShare(share, env = process.env) {
  return share.ownerUserId === normalizeUserId(defaultAdminUser(env).id)
    ? adminPrincipal(defaultAdminUser(env))
    : {
        kind: "user",
        userId: share.ownerUserId,
        role: "user",
        source: "desktop-share",
        displayName: share.ownerUserId,
      };
}

async function assertCurrentShareGrant(share, env = process.env) {
  const decision = await authorizeDesktopAccess({
    principal: principalForShare(share, env),
    threadId: share.threadId,
    desktopSlug: share.desktopSlug,
    desktopId: share.desktopId,
    ownerUserId: share.ownerUserId,
    boundaryId: share.boundaryId,
    desktopGeneration: share.desktopGeneration,
    permission: "share",
    breakGlass: share.breakGlass === true,
    breakGlassReason: share.breakGlassReason,
  }, env);
  if (!decision.allowed) throw desktopShareError(decision.reason || "desktop_share_scope_denied", 403);
  if (share.grantRevision && decision.grantRevision !== share.grantRevision) {
    throw desktopShareError("desktop_share_grant_changed", 401);
  }
  if (share.boundaryId && decision.boundaryId !== share.boundaryId) {
    throw desktopShareError("desktop_share_boundary_changed", 401);
  }
  if (share.desktopGeneration && decision.desktopGeneration !== share.desktopGeneration) {
    throw desktopShareError("desktop_share_generation_changed", 401);
  }
  return decision;
}

export async function createDesktopShare({ desktopSlug = "", slug = "", ownerUserId = "", principal = null, threadId = "", desktopAccess = null, breakGlass = false, breakGlassReason = "", label = "", env = process.env } = {}) {
  const normalizedSlug = cleanSlug(desktopSlug || slug);
  if (!normalizedSlug) throw desktopShareError("desktop_slug_required", 400);
  const resolvedOwnerUserId = ownerUserIdForPrincipal(principal, ownerUserId, env);
  const access = desktopAccess || await assertDesktopAccess({
    principal,
    threadId,
    desktopSlug: normalizedSlug,
    ownerUserId: resolvedOwnerUserId,
    permission: "share",
    breakGlass,
    breakGlassReason,
  }, env);
  const key = randomToken(32);
  const state = await readState(env);
  const share = normalizeShare({
    id: randomToken(12),
    desktopSlug: normalizedSlug,
    ownerUserId: resolvedOwnerUserId,
    threadId: String(threadId || access.threadId || "").trim(),
    desktopId: access.desktopId,
    boundaryId: access.boundaryId || desktopBoundaryId(env),
    grantRevision: access.grantRevision,
    policyRevision: access.policyRevision,
    desktopGeneration: access.desktopGeneration,
    breakGlass: access.breakGlass === true,
    breakGlassReason: access.breakGlassReason,
    subdomain: randomDnsLabel(),
    keyHash: sha256(key),
    status: "pending",
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + shareTtlMs(env)).toISOString(),
    createdBy: principal?.userId || "system",
    label,
    attempts: [],
  });
  const supersededAt = nowIso();
  let supersededCount = 0;
  const desktopShares = state.desktopShares.map((item) => {
    if (
      item.desktopSlug !== share.desktopSlug ||
      item.ownerUserId !== share.ownerUserId ||
      ["expired", "revoked", "superseded"].includes(item.status)
    ) return item;
    supersededCount += 1;
    return {
      ...item,
      status: "superseded",
      supersededAt,
      supersededBy: share.id,
    };
  });
  await writeState({ desktopShares: [share, ...desktopShares] }, env);
  const url = desktopShareUrl(share, key, env);
  await appendEvent({ type: "desktop_share_created", desktopSlug: share.desktopSlug, ownerUserId: share.ownerUserId, shareId: share.id, supersededCount }, env).catch(() => {});
  return {
    ok: true,
    share: publicShare(share),
    url,
    key,
    subdomain: share.subdomain,
    wildcardSubdomainConfigured: Boolean(desktopShareBaseDomain(env) || String(env.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE || "").trim()),
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
  await assertCurrentShareGrant(share, env);

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
  await assertCurrentShareGrant(share, env);
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
    if (["expired", "revoked", "superseded"].includes(share.status) || Date.parse(share.expiresAt || "") <= now) continue;
    try {
      await assertCurrentShareGrant(share, env);
    } catch {
      continue;
    }
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
  const { shareId, token } = parseDesktopShareCookie(request?.headers?.cookie || "");
  if (!shareId || !token) return null;
  const state = await readState(env);
  const now = Date.now();
  const share = state.desktopShares.find((item) => item.id === shareId);
  if (!share) return null;
  assertShareActive(share, now);
  if (share.desktopSlug !== requestedSlug) throw desktopShareError("desktop_share_slug_forbidden", 403);
  await assertCurrentShareGrant(share, env);
  const attempt = share.attempts.find((item) => item.tokenHash === sha256(token) && Date.parse(item.expiresAt || "") > now);
  if (!attempt || attempt.status !== "approved") return null;
  const principal = principalForShare(share, env);
  return {
    ok: true,
    principal,
    share: publicShare(share),
    attempt: publicAttempt(attempt),
  };
}
