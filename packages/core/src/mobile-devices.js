import { appendEvent } from "../../storage/src/store.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { getMobileProfile, listMobileProfiles } from "./mobile-device-profiles.js";
import {
  clientMobilePairing,
  clientMobileSession,
  ownerMobileDevice,
  ownerMobilePairing,
  ownerMobileProfile,
} from "./mobile-device-projections.js";
import { readMobileDeviceState, withMobileDeviceState } from "./mobile-device-state.js";
import { getThreadForPrincipal } from "./threads.js";
import {
  assertProofFresh,
  contentSha256ForRequest,
  jwkThumbprint,
  mobileAuthError,
  normalizeDevicePublicJwk,
  nowIso,
  randomToken,
  requestProofPath,
  sha256,
  verifyEs256Proof,
} from "./mobile-device-crypto.js";
import { defaultAdminUser, getUser } from "./users.js";

const pairingAudience = "orkestr.mobile.pairing";
const requestAudience = "orkestr.mobile.request";
const refreshAudience = "orkestr.mobile.refresh";

function mobileAuthEnabled(env = process.env) {
  return String(env.ORKESTR_MOBILE_AUTH_ENABLED || "1").trim() !== "0";
}

function positiveMs(env, key, fallback, min = 1000) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

function positiveInt(env, key, fallback) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function pairingTtlMs(env) {
  return positiveMs(env, "ORKESTR_MOBILE_PAIRING_TTL_MS", 10 * 60_000);
}

function challengeTtlMs(env) {
  return positiveMs(env, "ORKESTR_MOBILE_CHALLENGE_TTL_MS", 2 * 60_000);
}

function accessTtlMs(env) {
  return positiveMs(env, "ORKESTR_MOBILE_ACCESS_TTL_MS", 10 * 60_000);
}

function refreshTtlMs(env) {
  return positiveMs(env, "ORKESTR_MOBILE_REFRESH_TTL_MS", 30 * 24 * 60 * 60_000);
}

function proofJtiTtlMs(env) {
  return positiveMs(env, "ORKESTR_MOBILE_PROOF_JTI_TTL_MS", 5 * 60_000);
}

function requestIp(request) {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "")
    .replace(/^::ffff:/, "")
    .slice(0, 80);
}

function normalizeMachineContext(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const platform = String(value.platform || "unknown").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 32) || "unknown";
  return {
    contractVersion: 1,
    platform,
    appVersion: String(value.appVersion || "").trim().slice(0, 64),
    deviceName: String(value.deviceName || "").trim().slice(0, 120),
    osVersion: String(value.osVersion || "").trim().slice(0, 64),
    installationId: String(value.installationId || "").trim().slice(0, 160),
  };
}

function machineContextHash(machineContext) {
  return sha256(JSON.stringify(machineContext));
}

function pairingByIdOrCode(state, value = "") {
  const id = String(value || "").trim();
  return (state.pairings || []).find((item) =>
    item.id === id || String(item.approveCode || "").toUpperCase() === id.toUpperCase()
  ) || null;
}

function pairingRateLimitError(code, retryAfterMs) {
  const error = mobileAuthError(code, 429);
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return error;
}

function assertPairingStartAllowed(state, context, env) {
  const now = Date.now();
  const pending = (state.pairings || []).filter((item) => item.status === "pending" && Date.parse(item.expiresAt || "") > now);
  const globalLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_GLOBAL_PENDING_LIMIT", 100);
  const windowMs = positiveMs(env, "ORKESTR_MOBILE_PAIRING_CREATE_WINDOW_MS", 10 * 60_000);
  if (globalLimit > 0 && pending.length >= globalLimit) throw pairingRateLimitError("mobile_pairing_global_rate_limited", windowMs);
  const clientPendingLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_CLIENT_PENDING_LIMIT", 3);
  const clientPending = pending.filter((item) => item.requestedIp === context.ip && item.requestedUserAgent === context.userAgent);
  if (clientPendingLimit > 0 && clientPending.length >= clientPendingLimit) {
    throw pairingRateLimitError("mobile_pairing_client_pending_rate_limited", windowMs);
  }
  const createLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT", 12);
  const recent = (state.pairings || []).filter((item) =>
    item.requestedIp === context.ip &&
    item.requestedUserAgent === context.userAgent &&
    now - Date.parse(item.createdAt || "") < windowMs
  );
  if (createLimit > 0 && recent.length >= createLimit) throw pairingRateLimitError("mobile_pairing_client_rate_limited", windowMs);
}

export async function startMobileDevicePairing({ request = null, body = {}, env = process.env } = {}) {
  if (!mobileAuthEnabled(env)) throw mobileAuthError("mobile_auth_disabled", 404);
  const publicKeyJwk = normalizeDevicePublicJwk(body.publicKeyJwk || body.publicKey || {});
  const machineContext = normalizeMachineContext(body.machineContext || {});
  if (typeof body.deviceName !== "string" || !body.deviceName.trim() || body.deviceName.trim().length > 120) {
    throw mobileAuthError("mobile_device_name_invalid", 400);
  }
  const deviceName = body.deviceName.trim();
  const context = {
    ip: requestIp(request),
    userAgent: String(request?.headers?.["user-agent"] || "").slice(0, 240),
  };
  return withMobileDeviceState(env, async (state) => {
    assertPairingStartAllowed(state, context, env);
    const pollToken = randomToken(32);
    const pairing = {
      id: `mp_${randomToken(14)}`,
      approveCode: randomToken(5).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase(),
      pollTokenHash: sha256(pollToken),
      status: "pending",
      deviceName,
      publicKeyJwk,
      publicKeyThumbprint: jwkThumbprint(publicKeyJwk),
      machineContext,
      machineContextHash: machineContextHash(machineContext),
      requestedIp: context.ip,
      requestedUserAgent: context.userAgent,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + pairingTtlMs(env)).toISOString(),
    };
    state.pairings.push(pairing);
    await appendEvent({ type: "mobile_pairing_started", pairingId: pairing.id }, env).catch(() => {});
    return { ok: true, pairing: clientMobilePairing(pairing, { includeApproveCode: true }), pollToken };
  });
}

export async function approveMobileDevicePairing(pairingId, { profileId = "", principal = null, env = process.env } = {}) {
  const ownerUserId = String(principal?.userId || "").trim();
  if (!ownerUserId) throw mobileAuthError("mobile_owner_required", 403);
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingId);
    if (!pairing) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (pairing.status !== "pending") throw mobileAuthError(`mobile_pairing_${pairing.status}`, 409);
    if (Date.parse(pairing.expiresAt || "") <= Date.now()) throw mobileAuthError("mobile_pairing_expired", 401);
    const profile = await getMobileProfile(profileId, { env });
    if (!profile) throw mobileAuthError("mobile_profile_not_found", 404);
    if (profile.ownerUserId !== ownerUserId) throw mobileAuthError("mobile_profile_forbidden", 403);
    const user = await getUser(profile.ownerUserId, env);
    if (!user || user.status === "disabled") throw mobileAuthError("mobile_profile_user_unavailable", 403);
    const thread = await getThreadForPrincipal(profile.threadId, principal, env).catch(() => null);
    if (!thread || String(thread.id || "") !== profile.threadId || String(thread.ownerUserId || ownerUserId) !== ownerUserId) {
      throw mobileAuthError("mobile_profile_thread_forbidden", 403);
    }
    Object.assign(pairing, {
      status: "approved",
      profileId: profile.id,
      ownerUserId,
      threadId: profile.threadId,
      role: user.role,
      approvedAt: nowIso(),
      approvedBy: ownerUserId.slice(0, 96),
    });
    await appendEvent({ type: "mobile_pairing_approved", pairingId: pairing.id, profileId: profile.id, approvedBy: pairing.approvedBy }, env).catch(() => {});
    return { ok: true, pairing: ownerMobilePairing(pairing) };
  });
}

export async function pollMobileDevicePairing(pairingId, { pollToken = "", env = process.env } = {}) {
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingId);
    if (!pairing || pairing.pollTokenHash !== sha256(pollToken)) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (Date.parse(pairing.expiresAt || "") <= Date.now()) throw mobileAuthError("mobile_pairing_expired", 401);
    if (pairing.status !== "approved") return { ok: true, pairing: clientMobilePairing(pairing) };
    const currentChallengeUsable = pairing.challengeId && pairing.challengeNonce && !pairing.challengeConsumedAt &&
      Date.parse(pairing.challengeExpiresAt || "") > Date.now();
    if (!currentChallengeUsable) {
      const nonce = randomToken(32);
      Object.assign(pairing, {
        challengeId: `mc_${randomToken(12)}`,
        challengeNonce: nonce,
        challengeNonceHash: sha256(nonce),
        challengeIssuedAt: nowIso(),
        challengeExpiresAt: new Date(Date.now() + challengeTtlMs(env)).toISOString(),
        challengeConsumedAt: "",
      });
    }
    return {
      ok: true,
      pairing: clientMobilePairing(pairing),
      challenge: {
        id: pairing.challengeId,
        nonce: pairing.challengeNonce,
        audience: pairingAudience,
        expiresAt: pairing.challengeExpiresAt,
        machineContext: pairing.machineContext,
        machineContextHash: pairing.machineContextHash,
        publicKeyThumbprint: pairing.publicKeyThumbprint,
      },
    };
  });
}

function assertProofUnused(state, sessionId, deviceId, jti, env) {
  const now = Date.now();
  const used = (state.proofs || []).some((item) =>
    item.sessionId === sessionId && item.deviceId === deviceId && item.jti === jti && Date.parse(item.expiresAt || "") > now
  );
  if (used) throw mobileAuthError("mobile_device_proof_replayed", 401);
  state.proofs = (state.proofs || []).filter((item) => Date.parse(item.expiresAt || "") > now);
  state.proofs.push({ sessionId, deviceId, jti, createdAt: nowIso(), expiresAt: new Date(now + proofJtiTtlMs(env)).toISOString() });
}

export async function completeMobileDevicePairing(pairingId, { pollToken = "", challengeId = "", proof = "", env = process.env } = {}) {
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingId);
    if (!pairing || pairing.pollTokenHash !== sha256(pollToken)) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (pairing.status !== "approved") throw mobileAuthError(`mobile_pairing_${pairing?.status || "missing"}`, 409);
    if (challengeId !== pairing.challengeId || Date.parse(pairing.challengeExpiresAt || "") <= Date.now() || pairing.challengeConsumedAt) {
      throw mobileAuthError("mobile_pairing_challenge_invalid", 401);
    }
    const claims = verifyEs256Proof(proof, pairing.publicKeyJwk);
    assertProofFresh(claims, pairingAudience);
    if (
      claims.pairingId !== pairing.id ||
      claims.challengeId !== pairing.challengeId ||
      sha256(claims.challenge || "") !== pairing.challengeNonceHash ||
      claims.publicKeyThumbprint !== pairing.publicKeyThumbprint ||
      claims.machineContextHash !== pairing.machineContextHash
    ) throw mobileAuthError("mobile_pairing_proof_scope_invalid", 401);
    const accessToken = randomToken(32);
    const refreshToken = randomToken(40);
    const now = nowIso();
    const device = {
      id: `md_${randomToken(12)}`,
      profileId: pairing.profileId,
      ownerUserId: pairing.ownerUserId,
      threadId: pairing.threadId,
      role: pairing.role,
      deviceName: pairing.deviceName,
      machineContext: pairing.machineContext,
      publicKeyJwk: pairing.publicKeyJwk,
      publicKeyThumbprint: pairing.publicKeyThumbprint,
      status: "active",
      createdAt: now,
      lastAccessedAt: now,
    };
    const session = {
      id: `ms_${randomToken(12)}`,
      deviceId: device.id,
      profileId: device.profileId,
      ownerUserId: device.ownerUserId,
      threadId: device.threadId,
      role: device.role,
      accessTokenId: `ma_${randomToken(8)}`,
      accessTokenHash: sha256(accessToken),
      accessExpiresAt: new Date(Date.now() + accessTtlMs(env)).toISOString(),
      refreshTokenId: `mr_${randomToken(8)}`,
      refreshTokenHash: sha256(refreshToken),
      refreshExpiresAt: new Date(Date.now() + refreshTtlMs(env)).toISOString(),
      createdAt: now,
      lastAccessedAt: now,
    };
    Object.assign(pairing, {
      status: "completed",
      deviceId: device.id,
      completedAt: now,
      challengeConsumedAt: now,
      challengeNonce: "",
    });
    state.devices.push(device);
    state.sessions.push(session);
    await appendEvent({ type: "mobile_device_paired", pairingId: pairing.id, deviceId: device.id, profileId: device.profileId }, env).catch(() => {});
    return {
      ok: true,
      device: ownerMobileDevice(device, session),
      session: clientMobileSession(session),
      accessToken,
      refreshToken,
    };
  });
}

export async function listOwnerMobileProfiles({ principal = null, env = process.env } = {}) {
  const ownerUserId = String(principal?.userId || "").trim();
  if (!ownerUserId) throw mobileAuthError("mobile_owner_required", 403);
  const configured = await listMobileProfiles({ env });
  return {
    profiles: configured.profiles
      .filter((profile) => profile.ownerUserId === ownerUserId)
      .map(ownerMobileProfile),
  };
}

export async function listMobileDevices({ principal = null, env = process.env } = {}) {
  const ownerUserId = String(principal?.userId || "").trim();
  if (!ownerUserId) throw mobileAuthError("mobile_owner_required", 403);
  const state = await readMobileDeviceState(env);
  return {
    devices: state.devices
      .filter((device) => device.ownerUserId === ownerUserId)
      .map((device) => ownerMobileDevice(
        device,
        state.sessions.find((session) => session.deviceId === device.id) || null,
      ))
      .sort((a, b) => String(b.pairedAt || "").localeCompare(String(a.pairedAt || ""))),
  };
}

export async function revokeMobileDevice(deviceId, { principal = null, env = process.env } = {}) {
  const ownerUserId = String(principal?.userId || "").trim();
  if (!ownerUserId) throw mobileAuthError("mobile_owner_required", 403);
  return withMobileDeviceState(env, async (state) => {
    const device = (state.devices || []).find((item) => item.id === deviceId && item.ownerUserId === ownerUserId);
    if (!device) throw mobileAuthError("mobile_device_not_found", 404);
    Object.assign(device, { status: "revoked", revokedAt: nowIso(), revokedBy: ownerUserId.slice(0, 96) });
    state.sessions = (state.sessions || []).filter((session) => session.deviceId !== device.id);
    await appendEvent({ type: "mobile_device_revoked", deviceId: device.id, revokedBy: device.revokedBy }, env).catch(() => {});
    return { ok: true, device: ownerMobileDevice(device) };
  });
}

export async function mobileDeviceContextIsActive(context = {}, env = process.env) {
  const deviceId = String(context?.deviceId || "").trim();
  const profileId = String(context?.profileId || "").trim();
  const threadId = String(context?.threadId || "").trim();
  const ownerUserId = String(context?.ownerUserId || "").trim();
  if (!deviceId || !profileId || !threadId || !ownerUserId) return false;
  const state = await readMobileDeviceState(env);
  const device = (state.devices || []).find((item) =>
    item.id === deviceId &&
    item.status === "active" &&
    item.profileId === profileId &&
    item.threadId === threadId &&
    item.ownerUserId === ownerUserId
  );
  if (!device) return false;
  const profile = await getMobileProfile(profileId, { env });
  return Boolean(
    profile &&
    profile.enabled !== false &&
    profile.threadId === threadId &&
    profile.ownerUserId === ownerUserId
  );
}

function machineContextFor(session, device, profile) {
  return {
    principalKind: "mobile_device",
    routeKind: "hush_mobile",
    deviceId: device.id,
    profileId: session.profileId,
    threadId: profile.threadId,
    ownerUserId: session.ownerUserId,
  };
}

function hushVoiceRouteAllowed(request = {}) {
  const method = String(request?.method || "GET").toUpperCase();
  const path = requestProofPath(request).split("?")[0];
  if (method === "POST" && /(?:^|\/)api\/mobile\/voice-turns$/.test(path)) return true;
  return method === "GET" && /(?:^|\/)api\/mobile\/voice-turns\/[^/]+(?:\/events)?$/.test(path);
}

function validateRequestClaims(claims, session, device, token, request, audience) {
  assertProofFresh(claims, audience);
  const method = String(request?.method || "GET").toUpperCase();
  if (
    claims.sid !== session.id ||
    claims.did !== device.id ||
    claims.method !== method ||
    claims.path !== requestProofPath(request) ||
    claims.bodySha256 !== contentSha256ForRequest(request)
  ) throw mobileAuthError("mobile_device_proof_scope_invalid", 401);
  if (audience === requestAudience && claims.ath !== sha256(token)) throw mobileAuthError("mobile_device_token_binding_invalid", 401);
  if (audience === refreshAudience && claims.rth !== sha256(token)) throw mobileAuthError("mobile_device_token_binding_invalid", 401);
}

export async function authorizeMobileDeviceHttpRequest(request, env = process.env) {
  const token = String(request?.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const tokenHash = sha256(token);
  const initial = await readMobileDeviceState(env);
  const initialSession = (initial.sessions || []).find((item) => item.accessTokenHash === tokenHash);
  if (!initialSession) return null;
  if (!hushVoiceRouteAllowed(request)) {
    return { ok: false, statusCode: 403, error: "mobile_device_route_forbidden", machineAuth: "mobile_device" };
  }
  if (Date.parse(initialSession.accessExpiresAt || "") <= Date.now()) {
    return { ok: false, statusCode: 401, error: "mobile_access_expired", machineAuth: "mobile_device" };
  }
  return withMobileDeviceState(env, async (state) => {
    const session = (state.sessions || []).find((item) => item.accessTokenHash === tokenHash);
    if (!session || Date.parse(session.accessExpiresAt || "") <= Date.now()) {
      return { ok: false, statusCode: 401, error: "mobile_access_expired", machineAuth: "mobile_device" };
    }
    const device = (state.devices || []).find((item) => item.id === session.deviceId && item.status === "active");
    if (!device) return { ok: false, statusCode: 401, error: "mobile_device_revoked", machineAuth: "mobile_device" };
    const profile = await getMobileProfile(session.profileId, { env });
    if (!profile || profile.ownerUserId !== session.ownerUserId || !profile.threadId) {
      return { ok: false, statusCode: 403, error: "mobile_device_profile_unavailable", machineAuth: "mobile_device" };
    }
    const proof = String(request?.headers?.["x-orkestr-device-proof"] || "");
    let claims;
    try {
      claims = verifyEs256Proof(proof, device.publicKeyJwk);
      validateRequestClaims(claims, session, device, token, request, requestAudience);
      assertProofUnused(state, session.id, device.id, claims.jti, env);
    } catch (error) {
      return {
        ok: false,
        statusCode: error?.statusCode || 401,
        error: error?.message || "mobile_device_proof_invalid",
        machineAuth: "mobile_device",
      };
    }
    session.lastAccessedAt = nowIso();
    device.lastAccessedAt = session.lastAccessedAt;
    const user = await getUser(session.ownerUserId, env);
    if (user?.status === "disabled") return { ok: false, statusCode: 403, error: "user_disabled", machineAuth: "mobile_device" };
    const principal = user?.role === "admin"
      ? adminPrincipal({ ...(user || defaultAdminUser(env)), id: session.ownerUserId })
      : userPrincipal({ ...(user || {}), id: session.ownerUserId, role: "user", source: "hush" });
    principal.source = "hush";
    return { ok: true, principal, machineAuth: "mobile_device", machineAuthContext: machineContextFor(session, device, profile) };
  });
}

export async function refreshMobileDeviceSession({ refreshToken = "", proof = "", request = null, env = process.env } = {}) {
  return withMobileDeviceState(env, async (state) => {
    const session = (state.sessions || []).find((item) =>
      item.refreshTokenHash === sha256(refreshToken) && Date.parse(item.refreshExpiresAt || "") > Date.now()
    );
    if (!session) throw mobileAuthError("mobile_refresh_invalid", 401);
    const device = (state.devices || []).find((item) => item.id === session.deviceId && item.status === "active");
    if (!device) throw mobileAuthError("mobile_device_revoked", 401);
    const claims = verifyEs256Proof(proof, device.publicKeyJwk);
    validateRequestClaims(claims, session, device, refreshToken, request, refreshAudience);
    assertProofUnused(state, session.id, device.id, claims.jti, env);
    const accessToken = randomToken(32);
    const nextRefreshToken = randomToken(40);
    Object.assign(session, {
      accessTokenId: `ma_${randomToken(8)}`,
      accessTokenHash: sha256(accessToken),
      accessExpiresAt: new Date(Date.now() + accessTtlMs(env)).toISOString(),
      refreshTokenId: `mr_${randomToken(8)}`,
      refreshTokenHash: sha256(nextRefreshToken),
      refreshExpiresAt: new Date(Date.now() + refreshTtlMs(env)).toISOString(),
      lastAccessedAt: nowIso(),
    });
    device.lastAccessedAt = session.lastAccessedAt;
    await appendEvent({ type: "mobile_session_refreshed", deviceId: device.id, sessionId: session.id }, env).catch(() => {});
    return { ok: true, session: clientMobileSession(session), accessToken, refreshToken: nextRefreshToken };
  });
}

export { listMobileProfiles };
