import crypto from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { adminPrincipal } from "./principal.js";
import { isAdminPrincipal } from "./policy.js";
import { defaultAdminUser, normalizeUserId } from "./users.js";
import { assertDesktopAccess, authorizeDesktopAccess, desktopAccessMode, desktopBoundaryId } from "./desktop-access.js";
import { emitDesktopShareLifecycle } from "./desktop-share-lifecycle.js";
import { recordThreadResourceInvalidationMetric } from "./observability.js";
import {
  cleanDesktopSlug as cleanSlug,
  desktopShareLineageId as lineageIdFor,
  desktopShareNowIso as nowIso,
  desktopShareRandomToken as randomToken,
  desktopShareSha256 as sha256,
  mutateDesktopShareState as mutateState,
  normalizeDesktopShare as normalizeShare,
  normalizeDesktopShareAttempt as normalizeAttempt,
  publicDesktopShare as publicShare,
  publicDesktopShareAttempt as publicAttempt,
  readDesktopShareState as readState,
} from "./desktop-share-store.js";
import {
  desktopShareBaseDomain,
  desktopShareCookieHeader,
  desktopShareSubdomainFromHost,
  desktopShareUrl,
  parseDesktopShareCookie,
} from "./desktop-share-http.js";

export { desktopShareCookieHeader, desktopShareCookieName, desktopShareSubdomainFromHost } from "./desktop-share-http.js";

const defaultShareTtlMs = 60 * 60 * 1000;
const defaultAccessTtlMs = 30 * 60 * 1000;

function randomDnsLabel() {
  return `d-${crypto.randomBytes(9).toString("hex")}`;
}

function randomChallenge() {
  return `desk-${randomToken(18)}`;
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
  if (share.status === "superseded" || (share.currentShareId && share.currentShareId !== share.id)) {
    const error = desktopShareError("desktop_share_superseded", 409);
    error.lifecycle = {
      shareId: share.id,
      status: "superseded",
      current: false,
      shareGeneration: share.shareGeneration,
      reason: share.supersessionReason || "new_share_created",
    };
    throw error;
  }
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
  return `/desktop/${slug}/vnc.html?autoconnect=1&resize=scale&view_only=false&path=desktop/${slug}/websockify`;
}

function principalForShare(share, env = process.env) {
  const authenticatedAt = share.breakGlass === true ? String(share.breakGlassAuthenticatedAt || "").trim() : "";
  const principal = share.ownerUserId === normalizeUserId(defaultAdminUser(env).id)
    ? adminPrincipal(defaultAdminUser(env))
    : {
        kind: "user",
        userId: share.ownerUserId,
        role: "user",
        source: "desktop-share",
        displayName: share.ownerUserId,
      };
  return authenticatedAt ? { ...principal, authenticatedAt } : principal;
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
    breakGlassChangeRef: share.breakGlassChangeRef,
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

export async function createDesktopShare({ desktopSlug = "", slug = "", ownerUserId = "", principal = null, threadId = "", desktopAccess = null, breakGlass = false, breakGlassReason = "", breakGlassChangeRef = "", recentAuthAt = "", label = "", env = process.env } = {}) {
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
    breakGlassChangeRef,
    recentAuthAt,
  }, env);
  const key = randomToken(32);
  const mutation = await mutateState(env, (state) => {
    const base = {
      desktopSlug: normalizedSlug,
      ownerUserId: resolvedOwnerUserId,
      threadId: String(threadId || access.threadId || "").trim(),
      desktopId: access.desktopId,
      boundaryId: access.boundaryId || desktopBoundaryId(env),
    };
    const lineageId = lineageIdFor(base);
    const lineage = state.desktopShareLineages.find((item) => item.id === lineageId) || null;
    const previous = state.desktopShares.find((item) => item.id === lineage?.currentShareId) || null;
    const generation = Math.max(lineage?.generation || 0, ...state.desktopShares.filter((item) => item.lineageId === lineageId).map((item) => item.shareGeneration || 0)) + 1;
    const share = normalizeShare({
      ...base,
      id: randomToken(12),
      lineageId,
      shareGeneration: generation,
      replacesShareId: previous?.id || null,
      grantRevision: access.grantRevision,
      policyRevision: access.policyRevision,
      desktopGeneration: access.desktopGeneration,
      breakGlass: access.breakGlass === true,
      breakGlassReason: access.breakGlassReason,
      breakGlassChangeRef: access.breakGlassChangeRef,
      breakGlassAuthenticatedAt: access.breakGlass === true ? String(principal?.recentAuthAt || principal?.authenticatedAt || "").trim() : null,
      subdomain: randomDnsLabel(),
      keyHash: sha256(key),
      status: "pending",
      createdAt: nowIso(),
      // Break-glass never creates a long-lived desktop share. The share cannot
      // outlive the short authorization window that created it.
      expiresAt: access.breakGlass && access.breakGlassExpiresAt
        ? new Date(Math.min(Date.now() + shareTtlMs(env), Date.parse(access.breakGlassExpiresAt))).toISOString()
        : new Date(Date.now() + shareTtlMs(env)).toISOString(),
      createdBy: principal?.userId || "system",
      label,
      attempts: [],
    });
    const supersededAt = nowIso();
    let supersededCount = 0;
    state.desktopShares = state.desktopShares.map((item) => {
      if (item.lineageId !== lineageId || ["expired", "revoked", "superseded"].includes(item.status)) return item;
      supersededCount += 1;
      return { ...item, status: "superseded", currentShareId: share.id, supersededAt, supersededBy: share.id, supersessionReason: "new_share_created" };
    });
    share.currentShareId = share.id;
    state.desktopShares.unshift(share);
    state.desktopShareLineages = state.desktopShareLineages.filter((item) => item.id !== lineageId);
    state.desktopShareLineages.push({ ...base, id: lineageId, generation, currentShareId: share.id, migrationAmbiguous: false });
    return { share, supersededCount, supersededShareIds: state.desktopShares.filter((item) => item.supersededBy === share.id).map((item) => item.id) };
  });
  const { share, supersededCount, supersededShareIds } = mutation;
  const url = desktopShareUrl(share, key, env);
  for (const shareId of supersededShareIds) {
    emitDesktopShareLifecycle({ shareId, lineageId: share.lineageId, shareGeneration: share.shareGeneration, reason: "superseded" });
    await appendEvent({ type: "desktop_share_superseded", shareId, lineageId: share.lineageId, supersededBy: share.id, reason: "new_share_created" }, env).catch(() => {});
  }
  await appendEvent({ type: "desktop_share_created", desktopSlug: share.desktopSlug, ownerUserId: share.ownerUserId, shareId: share.id, lineageId: share.lineageId, shareGeneration: share.shareGeneration, supersededCount }, env).catch(() => {});
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
  const now = Date.now();
  const id = String(shareId || "").trim();
  const result = await mutateState(env, async (state) => {
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
    let created = false;
    if (!attempt) {
      token = randomToken(32);
      created = true;
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
    return { share: state.desktopShares[shareIndex], attempt, token, created };
  });
  const { share, attempt, token, created } = result;
  if (created) await appendEvent({ type: "desktop_share_attempt_opened", shareId: share.id, lineageId: share.lineageId, shareGeneration: share.shareGeneration, attemptId: attempt.id }, env).catch(() => {});
  return {
    ok: true,
    share: publicShare(share),
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
  try {
    await assertCurrentShareGrant(share, env);
  } catch (error) {
    // A recipient shell polls this endpoint while its noVNC iframe is open. Make
    // an access or desktop-generation failure terminal before returning it so
    // the controller can replace the stale framebuffer with the revoked state
    // instead of leaving a generic error over an active-looking tab.
    await revokeDesktopShare(share.id, { reason: String(error?.message || "desktop_share_scope_changed"), env }).catch(() => undefined);
    throw error;
  }
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

export async function desktopShareFailureResponse({ shareId = "", key = "", subdomain = "", env = process.env } = {}) {
  const state = await readState(env);
  const share = state.desktopShares.find((item) => item.id === String(shareId || "").trim());
  if (!share) return null;
  try {
    assertShareKey(share, key);
    assertShareSubdomain(share, subdomain);
  } catch {
    return null;
  }
  const terminal = share.status === "superseded" || (share.currentShareId && share.currentShareId !== share.id)
    ? { error: "desktop_share_superseded", statusCode: 409, status: "superseded", reason: share.supersessionReason || "new_share_created" }
    : share.status === "revoked"
      ? { error: "desktop_share_revoked", statusCode: 401, status: "revoked", reason: share.revokeReason || "revoked" }
      : null;
  if (!terminal) return null;
  return {
    ok: false,
    error: terminal.error,
    statusCode: terminal.statusCode,
    lifecycle: {
      shareId: share.id,
      status: terminal.status,
      current: false,
      shareGeneration: share.shareGeneration,
      reason: terminal.reason,
    },
  };
}

export async function listDesktopShares({ ownerUserId = "", desktopSlug = "", threadId = "", includeTerminal = true, env = process.env } = {}) {
  const state = await readState(env);
  const owner = ownerUserId ? normalizeUserId(ownerUserId) : "";
  const slug = cleanSlug(desktopSlug);
  const thread = String(threadId || "").trim();
  const shares = state.desktopShares
    .filter((share) => !owner || share.ownerUserId === owner)
    .filter((share) => !slug || share.desktopSlug === slug)
    .filter((share) => !thread || share.threadId === thread)
    .filter((share) => includeTerminal || !["expired", "revoked", "superseded"].includes(share.status))
    .map((share) => ({
      ...publicShare(share),
      attempts: share.attempts.slice(0, 10).map((attempt) => publicAttempt(attempt)),
    }));
  return {
    ok: true,
    mode: desktopAccessMode(env),
    shares,
    lineages: state.desktopShareLineages.filter((lineage) => shares.some((share) => share.lineageId === lineage.id)),
    migrationAmbiguities: state.desktopShareLineages.filter((lineage) => lineage.migrationAmbiguous).map((lineage) => ({ lineageId: lineage.id, reason: "active_share_lineage_ambiguous" })),
  };
}

export async function revokeDesktopShare(shareId = "", { reason = "operator_revoked", env = process.env } = {}) {
  const id = String(shareId || "").trim();
  const share = await mutateState(env, (state) => {
    const item = state.desktopShares.find((candidate) => candidate.id === id);
    if (!item) throw desktopShareError("desktop_share_not_found", 404);
    if (!["expired", "revoked", "superseded"].includes(item.status)) {
      item.status = "revoked";
      item.revokedAt = nowIso();
      item.revokeReason = String(reason || "operator_revoked").trim().slice(0, 120);
      const lineage = state.desktopShareLineages.find((candidate) => candidate.id === item.lineageId);
      if (lineage?.currentShareId === item.id) lineage.currentShareId = null;
      item.currentShareId = null;
    }
    return item;
  });
  emitDesktopShareLifecycle({ shareId: share.id, lineageId: share.lineageId, shareGeneration: share.shareGeneration, reason: "revoked" });
  recordThreadResourceInvalidationMetric({ resourceType: "desktop", subject: "share", reason: "revoked" });
  await appendEvent({ type: "desktop_share_revoked", shareId: share.id, lineageId: share.lineageId, shareGeneration: share.shareGeneration, reason: share.revokeReason }, env).catch(() => {});
  return { ok: true, share: publicShare(share) };
}

export async function validateDesktopShareSession({ shareId = "", attemptId = "", env = process.env } = {}) {
  const state = await readState(env);
  const share = state.desktopShares.find((item) => item.id === String(shareId || "").trim());
  assertShareActive(share);
  const attempt = share.attempts.find((item) => item.id === String(attemptId || "").trim());
  if (!attempt || attempt.status !== "approved" || Date.parse(attempt.expiresAt || "") <= Date.now()) {
    throw desktopShareError("desktop_share_attempt_not_approved", 401);
  }
  try {
    await assertCurrentShareGrant(share, env);
  } catch (error) {
    await revokeDesktopShare(share.id, { reason: String(error?.message || "desktop_share_scope_changed"), env }).catch(() => undefined);
    throw error;
  }
  return { ok: true, share: publicShare(share), attempt: publicAttempt(attempt) };
}

export async function desktopShareEnforcementPreflight(env = process.env) {
  const state = await readState(env);
  const ambiguities = state.desktopShareLineages.filter((lineage) => lineage.migrationAmbiguous);
  return {
    ok: ambiguities.length === 0,
    mode: desktopAccessMode(env),
    ambiguities: ambiguities.map((lineage) => ({ lineageId: lineage.id, reason: "active_share_lineage_ambiguous" })),
  };
}

export async function approveDesktopShareChallenge(challenge = "", { env = process.env, approvedBy = "thread" } = {}) {
  const value = String(challenge || "").trim();
  if (!value) throw desktopShareError("desktop_share_challenge_required", 400);
  const now = Date.now();
  const approved = await mutateState(env, async (state) => {
    let match = null;
    for (const share of state.desktopShares) {
      if (["expired", "revoked", "superseded"].includes(share.status) || Date.parse(share.expiresAt || "") <= now) continue;
      try {
        assertShareActive(share, now);
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
        match = { share, attempt };
        break;
      }
      if (match) break;
    }
    if (!match) throw desktopShareError("desktop_share_challenge_not_found", 404);
    return match;
  });
  if (!approved) throw desktopShareError("desktop_share_challenge_not_found", 404);
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
