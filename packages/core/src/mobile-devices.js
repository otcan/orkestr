import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { getMobileProfile, listMobileProfiles } from "./mobile-device-profiles.js";
import {
  assertProofFresh,
  jwkThumbprint,
  mobileAuthError,
  normalizeDevicePublicJwk,
  nowIso,
  randomToken,
  sha256,
  verifyEs256Proof,
} from "./mobile-device-crypto.js";
import { resourceOwnerUserId } from "./policy.js";
import { getThread } from "./threads.js";
import { getUser, normalizeUserId } from "./users.js";

export const mobilePairingAudience = "orkestr.mobile.pairing";

function mobileAuthEnabled(env = process.env) {
  return String(env.ORKESTR_MOBILE_AUTH_ENABLED || "1").trim() !== "0";
}

function mobileStatePath(env = process.env) {
  return env.ORKESTR_MOBILE_DEVICES_FILE || path.join(dataPaths(env).secrets, "mobile-devices.json");
}

export function mobilePositiveMs(env, key, fallback, min = 1000) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

function positiveInt(env, key, fallback) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function pairingTtlMs(env) {
  return mobilePositiveMs(env, "ORKESTR_MOBILE_PAIRING_TTL_MS", 10 * 60_000);
}

function challengeTtlMs(env) {
  return mobilePositiveMs(env, "ORKESTR_MOBILE_CHALLENGE_TTL_MS", 2 * 60_000);
}

export function mobileAccessTtlMs(env) {
  return mobilePositiveMs(env, "ORKESTR_MOBILE_ACCESS_TTL_MS", 10 * 60_000);
}

export function mobileRefreshTtlMs(env) {
  return mobilePositiveMs(env, "ORKESTR_MOBILE_REFRESH_TTL_MS", 30 * 24 * 60 * 60_000);
}

function proofJtiTtlMs(env) {
  return mobilePositiveMs(env, "ORKESTR_MOBILE_PROOF_JTI_TTL_MS", 5 * 60_000);
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

function normalizeDeviceName(body = {}, machineContext = {}) {
  const raw = String(body.deviceName || machineContext.deviceName || "").trim();
  if (!raw) throw mobileAuthError("mobile_device_name_required", 400);
  if (raw.length > 120) throw mobileAuthError("mobile_device_name_too_long", 400);
  return raw;
}

function machineContextHash(machineContext) {
  return sha256(JSON.stringify(machineContext));
}

export async function readMobileDeviceState(env = process.env) {
  const state = await readJson(mobileStatePath(env), { version: 1, pairings: [], devices: [], sessions: [], proofs: [] });
  return {
    version: 1,
    pairings: Array.isArray(state.pairings) ? state.pairings : [],
    devices: Array.isArray(state.devices) ? state.devices : [],
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    proofs: Array.isArray(state.proofs) ? state.proofs : [],
  };
}

async function writeMobileState(state, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  const pairings = (state.pairings || [])
    .filter((item) => Date.parse(item.expiresAt || item.updatedAt || "") > now || item.status !== "pending")
    .slice(-500);
  await writeSecretJson(mobileStatePath(env), {
    version: 1,
    pairings,
    devices: state.devices || [],
    sessions: (state.sessions || []).filter((item) => Date.parse(item.refreshExpiresAt || "") > now),
    proofs: (state.proofs || []).filter((item) => Date.parse(item.expiresAt || "") > now),
    updatedAt: nowIso(),
  });
}

export function withMobileDeviceState(env, operation) {
  return withStorageFileLock(mobileStatePath(env), async () => {
    const state = await readMobileDeviceState(env);
    const result = await operation(state);
    await writeMobileState(state, env);
    return result;
  }, {
    timeoutMs: mobilePositiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_TIMEOUT_MS", 30_000),
    staleMs: mobilePositiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_STALE_MS", 120_000),
    heartbeatMs: mobilePositiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_HEARTBEAT_MS", 10_000),
  });
}

export function publicMobilePairing(pairing = {}) {
  return {
    id: pairing.id || "",
    approveCode: pairing.approveCode || "",
    status: pairing.status || "pending",
    deviceName: pairing.deviceName || "",
    createdAt: pairing.createdAt || "",
    expiresAt: pairing.expiresAt || "",
    approvedAt: pairing.approvedAt || "",
    completedAt: pairing.completedAt || "",
  };
}

export function publicMobileDevice(device = {}) {
  return {
    id: device.id || "",
    label: device.deviceName || device.label || "",
    status: device.status || "active",
  };
}

export function publicMobileSession(session = {}) {
  return {
    id: session.id || "",
    deviceId: session.deviceId || "",
    accessExpiresAt: session.accessExpiresAt || "",
    refreshExpiresAt: session.refreshExpiresAt || "",
  };
}

function pairingByIdOrCode(state, value = "") {
  const id = String(value || "").trim();
  return (state.pairings || []).find((item) =>
    item.id === id || String(item.approveCode || "").toUpperCase() === id.toUpperCase()
  ) || null;
}

function assertPairingStartAllowed(state, context, env) {
  const now = Date.now();
  const pending = (state.pairings || []).filter((item) => item.status === "pending" && Date.parse(item.expiresAt || "") > now);
  const globalLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_GLOBAL_PENDING_LIMIT", 100);
  if (globalLimit > 0 && pending.length >= globalLimit) throw mobileAuthError("mobile_pairing_global_rate_limited", 429);
  const clientPendingLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_CLIENT_PENDING_LIMIT", 3);
  const clientPending = pending.filter((item) => item.requestedIp === context.ip && item.requestedUserAgent === context.userAgent);
  if (clientPendingLimit > 0 && clientPending.length >= clientPendingLimit) {
    throw mobileAuthError("mobile_pairing_client_pending_rate_limited", 429);
  }
  const windowMs = mobilePositiveMs(env, "ORKESTR_MOBILE_PAIRING_CREATE_WINDOW_MS", 10 * 60_000);
  const createLimit = positiveInt(env, "ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT", 12);
  const recent = (state.pairings || []).filter((item) =>
    item.requestedIp === context.ip &&
    item.requestedUserAgent === context.userAgent &&
    now - Date.parse(item.createdAt || "") < windowMs
  );
  if (createLimit > 0 && recent.length >= createLimit) throw mobileAuthError("mobile_pairing_client_rate_limited", 429);
}

async function resolveApprovalProfile(profileId, principal, env) {
  if (!String(profileId || "").trim()) throw mobileAuthError("mobile_profile_required", 400);
  const profile = await getMobileProfile(profileId, { env, principal });
  if (!profile) throw mobileAuthError("mobile_profile_not_found", 404);
  const ownerUserId = normalizeUserId(profile.ownerUserId);
  if (!principal?.userId || normalizeUserId(principal.userId) !== ownerUserId) {
    throw mobileAuthError("mobile_profile_owner_mismatch", 403);
  }
  const thread = profile.threadId ? await getThread(profile.threadId, env) : null;
  if (!thread) throw mobileAuthError("mobile_profile_thread_not_found", 404);
  if (resourceOwnerUserId(thread, env) !== ownerUserId) throw mobileAuthError("mobile_profile_thread_owner_mismatch", 403);
  const user = await getUser(profile.userId, env);
  if (!user || user.status === "disabled") throw mobileAuthError("mobile_profile_user_unavailable", 403);
  return profile;
}

export async function startMobileDevicePairing({ request = null, body = {}, env = process.env } = {}) {
  if (!mobileAuthEnabled(env)) throw mobileAuthError("mobile_auth_disabled", 404);
  const publicKeyJwk = normalizeDevicePublicJwk(body.publicKeyJwk || body.publicKey || {});
  const machineContext = normalizeMachineContext(body.machineContext || {});
  const deviceName = normalizeDeviceName(body, machineContext);
  if (!machineContext.deviceName) machineContext.deviceName = deviceName;
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
    return { ok: true, pairing: publicMobilePairing(pairing), pollToken };
  });
}

export async function listMobilePairings({ env = process.env, principal = null } = {}) {
  const ownerUserId = principal?.userId ? normalizeUserId(principal.userId) : "";
  const state = await readMobileDeviceState(env);
  const pairings = ownerUserId
    ? state.pairings.filter((pairing) => !pairing.ownerUserId || pairing.ownerUserId === ownerUserId)
    : state.pairings;
  return { pairings: pairings.map(publicMobilePairing).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
}

export async function approveMobileDevicePairing(pairingCode, { profileId = "", principal = null, env = process.env } = {}) {
  if (String(principal?.role || "") !== "admin") throw mobileAuthError("mobile_owner_required", 403);
  const profile = await resolveApprovalProfile(profileId, principal, env);
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingCode);
    if (!pairing) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (pairing.status !== "pending") throw mobileAuthError(`mobile_pairing_${pairing.status}`, 409);
    if (Date.parse(pairing.expiresAt || "") <= Date.now()) throw mobileAuthError("mobile_pairing_expired", 401);
    Object.assign(pairing, {
      status: "approved",
      profileId: profile.id,
      ownerUserId: profile.ownerUserId,
      userId: normalizeUserId(profile.userId),
      threadId: profile.threadId,
      role: profile.role,
      scopes: profile.scopes,
      approvedAt: nowIso(),
      approvedBy: String(principal.userId || "admin").slice(0, 96),
    });
    await appendEvent({ type: "mobile_pairing_approved", pairingId: pairing.id, profileId: profile.id, approvedBy: pairing.approvedBy }, env).catch(() => {});
    return { ok: true, pairing: publicMobilePairing(pairing) };
  });
}

function challengeForPairing(pairing) {
  return {
    id: pairing.challengeId,
    nonce: pairing.challengeNonce,
    audience: mobilePairingAudience,
    expiresAt: pairing.challengeExpiresAt,
    machineContextHash: pairing.machineContextHash,
    publicKeyThumbprint: pairing.publicKeyThumbprint,
  };
}

export async function pollMobileDevicePairing(pairingCode, { pollToken = "", env = process.env } = {}) {
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingCode);
    if (!pairing || pairing.pollTokenHash !== sha256(pollToken)) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (Date.parse(pairing.expiresAt || "") <= Date.now()) throw mobileAuthError("mobile_pairing_expired", 401);
    if (pairing.status !== "approved") return { ok: true, pairing: publicMobilePairing(pairing) };
    if (pairing.challengeId && pairing.challengeNonce && !pairing.challengeConsumedAt && Date.parse(pairing.challengeExpiresAt || "") > Date.now()) {
      return { ok: true, pairing: publicMobilePairing(pairing), challenge: challengeForPairing(pairing) };
    }
    const nonce = randomToken(32);
    Object.assign(pairing, {
      challengeId: `mc_${randomToken(12)}`,
      challengeNonce: nonce,
      challengeNonceHash: sha256(nonce),
      challengeIssuedAt: nowIso(),
      challengeExpiresAt: new Date(Date.now() + challengeTtlMs(env)).toISOString(),
      challengeConsumedAt: "",
    });
    return { ok: true, pairing: publicMobilePairing(pairing), challenge: challengeForPairing(pairing) };
  });
}

export function rememberMobileDeviceProofJti(state, sessionId, deviceId, jti, env) {
  const now = Date.now();
  const used = (state.proofs || []).some((item) =>
    item.sessionId === sessionId && item.deviceId === deviceId && item.jti === jti && Date.parse(item.expiresAt || "") > now
  );
  if (used) throw mobileAuthError("mobile_device_proof_replayed", 401);
  state.proofs = (state.proofs || []).filter((item) => Date.parse(item.expiresAt || "") > now);
  state.proofs.push({ sessionId, deviceId, jti, createdAt: nowIso(), expiresAt: new Date(now + proofJtiTtlMs(env)).toISOString() });
}

export async function completeMobileDevicePairing(pairingCode, { pollToken = "", challengeId = "", proof = "", env = process.env } = {}) {
  return withMobileDeviceState(env, async (state) => {
    const pairing = pairingByIdOrCode(state, pairingCode);
    if (!pairing || pairing.pollTokenHash !== sha256(pollToken)) throw mobileAuthError("mobile_pairing_not_found", 404);
    if (pairing.status !== "approved") throw mobileAuthError(`mobile_pairing_${pairing?.status || "missing"}`, 409);
    if (challengeId !== pairing.challengeId || Date.parse(pairing.challengeExpiresAt || "") <= Date.now() || pairing.challengeConsumedAt) {
      throw mobileAuthError("mobile_pairing_challenge_invalid", 401);
    }
    if (!pairing.ownerUserId || !pairing.userId || !pairing.threadId) throw mobileAuthError("mobile_pairing_profile_missing", 403);
    const claims = verifyEs256Proof(proof, pairing.publicKeyJwk);
    assertProofFresh(claims, mobilePairingAudience);
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
      userId: pairing.userId,
      threadId: pairing.threadId,
      role: pairing.role,
      scopes: pairing.scopes || [],
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
      userId: device.userId,
      threadId: device.threadId,
      role: device.role,
      scopes: device.scopes,
      accessTokenId: `ma_${randomToken(8)}`,
      accessTokenHash: sha256(accessToken),
      accessExpiresAt: new Date(Date.now() + mobileAccessTtlMs(env)).toISOString(),
      refreshTokenId: `mr_${randomToken(8)}`,
      refreshTokenHash: sha256(refreshToken),
      refreshExpiresAt: new Date(Date.now() + mobileRefreshTtlMs(env)).toISOString(),
      createdAt: now,
      lastAccessedAt: now,
    };
    Object.assign(pairing, { status: "completed", deviceId: device.id, completedAt: now, challengeConsumedAt: now, challengeNonce: "" });
    state.devices.push(device);
    state.sessions.push(session);
    await appendEvent({ type: "mobile_device_paired", pairingId: pairing.id, deviceId: device.id, profileId: device.profileId }, env).catch(() => {});
    return { ok: true, device: publicMobileDevice(device), session: publicMobileSession(session), accessToken, refreshToken };
  });
}

export async function listMobileDevices({ env = process.env, principal = null } = {}) {
  const ownerUserId = principal?.userId ? normalizeUserId(principal.userId) : "";
  const state = await readMobileDeviceState(env);
  const devices = ownerUserId ? state.devices.filter((device) => device.ownerUserId === ownerUserId) : state.devices;
  return { devices: devices.map(publicMobileDevice).sort((a, b) => String(a.label).localeCompare(String(b.label))) };
}

export async function revokeMobileDevice(deviceId, { principal = null, env = process.env } = {}) {
  if (String(principal?.role || "") !== "admin") throw mobileAuthError("mobile_owner_required", 403);
  return withMobileDeviceState(env, async (state) => {
    const ownerUserId = principal?.userId ? normalizeUserId(principal.userId) : "";
    const device = (state.devices || []).find((item) => item.id === deviceId && (!ownerUserId || item.ownerUserId === ownerUserId));
    if (!device) throw mobileAuthError("mobile_device_not_found", 404);
    Object.assign(device, { status: "revoked", revokedAt: nowIso(), revokedBy: String(principal.userId || "admin").slice(0, 96) });
    state.sessions = (state.sessions || []).filter((session) => session.deviceId !== device.id);
    await appendEvent({ type: "mobile_device_revoked", deviceId: device.id, revokedBy: device.revokedBy }, env).catch(() => {});
    return { ok: true, device: publicMobileDevice(device) };
  });
}

export { listMobileProfiles };
