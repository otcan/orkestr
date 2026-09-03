import { appendEvent } from "../../storage/src/store.js";
import {
  assertProofFresh,
  contentSha256ForRequest,
  mobileAuthError,
  nowIso,
  randomToken,
  requestProofPath,
  sha256,
  verifyEs256Proof,
} from "./mobile-device-crypto.js";
import {
  mobileAccessTtlMs,
  mobileRefreshTtlMs,
  publicMobileSession,
  readMobileDeviceState,
  rememberMobileDeviceProofJti,
  withMobileDeviceState,
} from "./mobile-devices.js";
import {
  hushMobileRouteKind,
  hushMobileVoiceRoute,
  isMobileSessionRefreshRoute,
  mobileDeviceMachineAuthContext,
} from "./mobile-device-request-context.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { defaultAdminUser, getUser } from "./users.js";

export const mobileRequestAudience = "orkestr.mobile.request";
export const mobileRefreshAudience = "orkestr.mobile.refresh";

function bearerToken(request = {}) {
  return String(request?.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function activeAccessSession(state = {}, token = "") {
  const tokenHash = sha256(token);
  return (state.sessions || []).find((session) =>
    session.accessTokenHash === tokenHash && Date.parse(session.accessExpiresAt || "") > Date.now()
  ) || null;
}

function hasRequiredScopes(session = {}, route = {}) {
  const scopes = new Set(Array.isArray(session.scopes) ? session.scopes : []);
  return (route.scopes || []).every((scope) => scopes.has(scope));
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
  if (audience === mobileRequestAudience && claims.ath !== sha256(token)) throw mobileAuthError("mobile_device_token_binding_invalid", 401);
  if (audience === mobileRefreshAudience && claims.rth !== sha256(token)) throw mobileAuthError("mobile_device_token_binding_invalid", 401);
}

function mobileFailure(error, fallback = "mobile_device_proof_invalid") {
  return {
    ok: false,
    statusCode: 401,
    error: error?.message || fallback,
    machineAuth: hushMobileRouteKind,
  };
}

export async function authorizeMobileDeviceHttpRequest(request, env = process.env) {
  const token = bearerToken(request);
  if (!token) return null;
  const initial = await readMobileDeviceState(env);
  const initialSession = activeAccessSession(initial, token);
  if (!initialSession) return null;
  if (isMobileSessionRefreshRoute(request)) return null;

  const route = hushMobileVoiceRoute(request);
  if (!route) {
    return { ok: false, statusCode: 403, error: "hush_mobile_route_forbidden", machineAuth: hushMobileRouteKind };
  }

  return withMobileDeviceState(env, async (state) => {
    const session = activeAccessSession(state, token);
    if (!session) return null;
    const device = (state.devices || []).find((item) => item.id === session.deviceId && item.status === "active");
    if (!device) return { ok: false, statusCode: 401, error: "mobile_device_revoked", machineAuth: hushMobileRouteKind };
    if (!session.ownerUserId || !session.userId || !session.threadId) {
      return { ok: false, statusCode: 403, error: "hush_mobile_context_incomplete", machineAuth: hushMobileRouteKind };
    }
    if (!hasRequiredScopes(session, route)) {
      return { ok: false, statusCode: 403, error: "hush_mobile_scope_denied", machineAuth: hushMobileRouteKind };
    }

    let claims;
    try {
      claims = verifyEs256Proof(String(request?.headers?.["x-orkestr-device-proof"] || ""), device.publicKeyJwk);
      validateRequestClaims(claims, session, device, token, request, mobileRequestAudience);
      rememberMobileDeviceProofJti(state, session.id, device.id, claims.jti, env);
    } catch (error) {
      return mobileFailure(error);
    }

    session.lastAccessedAt = nowIso();
    device.lastAccessedAt = session.lastAccessedAt;
    const user = await getUser(session.userId, env);
    if (user?.status === "disabled") {
      return { ok: false, statusCode: 403, error: "user_disabled", machineAuth: hushMobileRouteKind };
    }
    const principal = session.role === "admin"
      ? adminPrincipal({ ...(user || defaultAdminUser(env)), id: session.userId })
      : userPrincipal({ ...(user || {}), id: session.userId, role: "user", source: "hush-mobile-device" });
    principal.source = "hush-mobile-device";
    return {
      ok: true,
      principal,
      machineAuth: hushMobileRouteKind,
      machineAuthContext: mobileDeviceMachineAuthContext({ session, device, claims, route }),
    };
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
    if (!session.ownerUserId || !session.userId || !session.threadId) throw mobileAuthError("hush_mobile_context_incomplete", 403);

    let claims;
    try {
      claims = verifyEs256Proof(proof, device.publicKeyJwk);
      validateRequestClaims(claims, session, device, refreshToken, request, mobileRefreshAudience);
      rememberMobileDeviceProofJti(state, session.id, device.id, claims.jti, env);
    } catch (error) {
      throw mobileAuthError(error?.message || "mobile_device_proof_invalid", 401);
    }

    const accessToken = randomToken(32);
    const nextRefreshToken = randomToken(40);
    Object.assign(session, {
      accessTokenId: `ma_${randomToken(8)}`,
      accessTokenHash: sha256(accessToken),
      accessExpiresAt: new Date(Date.now() + mobileAccessTtlMs(env)).toISOString(),
      refreshTokenId: `mr_${randomToken(8)}`,
      refreshTokenHash: sha256(nextRefreshToken),
      refreshExpiresAt: new Date(Date.now() + mobileRefreshTtlMs(env)).toISOString(),
      lastAccessedAt: nowIso(),
    });
    device.lastAccessedAt = session.lastAccessedAt;
    await appendEvent({ type: "mobile_session_refreshed", deviceId: device.id, sessionId: session.id }, env).catch(() => {});
    return { ok: true, session: publicMobileSession(session), accessToken, refreshToken: nextRefreshToken };
  });
}
