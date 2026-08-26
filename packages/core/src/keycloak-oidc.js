import crypto from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { authProvider } from "./auth-config.js";
import { publicUrlConfig } from "./public-url-config.js";
import { createOidcSecuritySession, revokeOidcSecuritySessions } from "./security.js";

const stateTtlMs = 10 * 60 * 1000;
const stateAuditTtlMs = 24 * 60 * 60 * 1000;
const defaultPendingStateLimit = 500;
const discoveryCache = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function enabled(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(clean(value).toLowerCase());
}

function oidcError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function base64urlJson(value = "") {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch {
    throw oidcError("oidc_token_malformed", 401);
  }
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("base64url");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function statePath(env = process.env) {
  return env.ORKESTR_KEYCLOAK_OIDC_STATE_FILE || path.join(dataPaths(env).secrets, "keycloak-oidc-states.json");
}

function issuerFromEnv(env = process.env) {
  const explicit = clean(env.ORKESTR_KEYCLOAK_ISSUER || env.KEYCLOAK_ISSUER).replace(/\/+$/, "");
  if (explicit) return explicit;
  const base = clean(env.ORKESTR_KEYCLOAK_URL || env.KEYCLOAK_URL).replace(/\/+$/, "");
  const realm = clean(env.ORKESTR_KEYCLOAK_REALM || env.KEYCLOAK_REALM);
  return base && realm ? `${base}/realms/${encodeURIComponent(realm)}` : "";
}

function assertHttpsUrl(value = "", code = "oidc_url_invalid", env = process.env) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw oidcError(code, 503);
  }
  const allowHttpForTests = enabled(env.ORKESTR_OIDC_ALLOW_INSECURE_TESTS);
  if ((!allowHttpForTests && parsed.protocol !== "https:") || !["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw oidcError(code, 503);
  }
  return parsed;
}

function callbackUrl(env = process.env) {
  const configured = clean(env.ORKESTR_KEYCLOAK_REDIRECT_URI);
  const appUrl = clean(publicUrlConfig(env).appUrl).replace(/\/+$/, "");
  const candidate = configured || (appUrl ? `${appUrl}/auth/callback` : "");
  const parsed = assertHttpsUrl(candidate, "oidc_redirect_uri_invalid", env);
  if (parsed.pathname !== "/auth/callback" || parsed.search || parsed.hash) throw oidcError("oidc_redirect_uri_invalid", 503);
  if (appUrl && parsed.origin !== new URL(appUrl).origin) throw oidcError("oidc_redirect_origin_mismatch", 503);
  return parsed.toString();
}

export function keycloakOidcSettings(env = process.env) {
  const issuer = issuerFromEnv(env);
  const clientId = clean(env.ORKESTR_KEYCLOAK_CLIENT_ID || env.KEYCLOAK_CLIENT_ID);
  const configured = authProvider(env) === "keycloak" && Boolean(issuer && clientId);
  let redirectUri = "";
  if (configured) {
    try { redirectUri = callbackUrl(env); } catch { redirectUri = ""; }
  }
  return {
    enabled: enabled(env.ORKESTR_KEYCLOAK_OIDC_ENABLED) && configured && Boolean(redirectUri),
    configured,
    issuer,
    clientId,
    redirectUri,
  };
}

export function keycloakOidcEnabled(env = process.env) {
  return keycloakOidcSettings(env).enabled;
}

async function readStates(env = process.env) {
  const state = await readJson(statePath(env), { states: [] });
  return { states: Array.isArray(state.states) ? state.states : [] };
}

async function writeStates(value = {}, env = process.env) {
  const now = Date.now();
  const states = (Array.isArray(value.states) ? value.states : []).filter((item) => {
    const expiresAt = Date.parse(item.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt > now) return true;
    const consumedAt = Date.parse(item.consumedAt || item.expiresAt || "");
    return Number.isFinite(consumedAt) && consumedAt + stateAuditTtlMs > now;
  });
  await ensureDataDirs(env);
  await writeSecretJson(statePath(env), { states, updatedAt: new Date().toISOString() });
}

async function mutateStates(env = process.env, operation) {
  return withStorageFileLock(statePath(env), async () => {
    const state = await readStates(env);
    const result = await operation(state);
    await writeStates(state, env);
    return result;
  }, {
    timeoutMs: Number(env.ORKESTR_KEYCLOAK_OIDC_LOCK_TIMEOUT_MS || 30_000),
    staleMs: Number(env.ORKESTR_KEYCLOAK_OIDC_LOCK_STALE_MS || 120_000),
    heartbeatMs: Number(env.ORKESTR_KEYCLOAK_OIDC_LOCK_HEARTBEAT_MS || 10_000),
  });
}

function sameSecret(left = "", right = "") {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeReturnPath(value = "") {
  const raw = clean(value) || "/apps";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/apps";
  try {
    const parsed = new URL(raw, "http://orkestr.local");
    if (!parsed.pathname.startsWith("/apps")) return "/apps";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/apps";
  }
}

function pendingStateLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_KEYCLOAK_OIDC_PENDING_STATE_LIMIT || defaultPendingStateLimit);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 10_000)) : defaultPendingStateLimit;
}

async function discovery(settings, env = process.env, fetchImpl = fetch) {
  const issuer = assertHttpsUrl(settings.issuer, "oidc_issuer_invalid", env).toString().replace(/\/+$/, "");
  const key = `${issuer}|${settings.clientId}`;
  const cached = discoveryCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  let response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  } catch {
    throw oidcError("oidc_discovery_failed", 503);
  }
  if (!response?.ok) throw oidcError("oidc_discovery_failed", 503);
  const payload = await response.json().catch(() => null);
  if (!payload || clean(payload.issuer).replace(/\/+$/, "") !== issuer) throw oidcError("oidc_discovery_invalid", 503);
  for (const keyName of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const endpoint = assertHttpsUrl(payload[keyName], "oidc_discovery_invalid", env);
    if (endpoint.origin !== new URL(issuer).origin) throw oidcError("oidc_discovery_invalid", 503);
  }
  const value = {
    issuer,
    authorizationEndpoint: String(payload.authorization_endpoint),
    tokenEndpoint: String(payload.token_endpoint),
    jwksUri: String(payload.jwks_uri),
    endSessionEndpoint: clean(payload.end_session_endpoint),
  };
  discoveryCache.set(key, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
  return value;
}

export async function beginKeycloakLogin({ returnTo = "", loginHint = "", env = process.env, fetchImpl = fetch } = {}) {
  const settings = keycloakOidcSettings(env);
  if (!settings.enabled) throw oidcError("oidc_login_unavailable", 404);
  const provider = await discovery(settings, env, fetchImpl);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(48);
  await mutateStates(env, async (states) => {
    const pending = states.states.filter((item) => !item.consumedAt && Date.parse(item.expiresAt || "") > Date.now());
    if (pending.length >= pendingStateLimit(env)) throw oidcError("oidc_login_rate_limited", 429);
    states.states.push({
      stateHash: sha256(state),
      nonce,
      codeVerifier,
      returnTo: safeReturnPath(returnTo),
      expiresAt: new Date(Date.now() + stateTtlMs).toISOString(),
    });
  });
  const target = new URL(provider.authorizationEndpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", settings.clientId);
  target.searchParams.set("redirect_uri", settings.redirectUri);
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("code_challenge", sha256(codeVerifier));
  const hint = clean(loginHint);
  if (/^[A-Za-z0-9._-]{1,80}$/.test(hint)) target.searchParams.set("kc_idp_hint", hint);
  return { authorizationUrl: target.toString() };
}

async function consumeState(value = "", env = process.env) {
  const state = clean(value);
  if (!state) throw oidcError("oidc_state_invalid", 401);
  return mutateStates(env, async (config) => {
    const stateHash = sha256(state);
    const now = Date.now();
    let consumed = null;
    config.states = config.states.map((item) => {
      if (!sameSecret(item.stateHash, stateHash)) return item;
      const expiresAt = Date.parse(item.expiresAt || "");
      if (item.consumedAt || !Number.isFinite(expiresAt) || expiresAt <= now) return item;
      consumed = { ...item, consumedAt: new Date().toISOString() };
      return consumed;
    });
    if (!consumed) throw oidcError("oidc_state_invalid", 401);
    return consumed;
  });
}

function jwtParts(token = "") {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts.every(Boolean)) throw oidcError("oidc_token_malformed", 401);
  return { header: base64urlJson(parts[0]), payload: base64urlJson(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
}

function rsaAlgorithm(alg = "") {
  return new Map([["RS256", "RSA-SHA256"], ["RS384", "RSA-SHA384"], ["RS512", "RSA-SHA512"]]).get(alg) || "";
}

function audienceMatches(audience, clientId = "") {
  const values = Array.isArray(audience) ? audience : [audience];
  return values.map((item) => String(item || "")).includes(clientId);
}

async function verifyJwt(token, { provider, settings, nonce = "", logout = false, env = process.env, fetchImpl = fetch } = {}) {
  const parsed = jwtParts(token);
  const algorithm = rsaAlgorithm(parsed.header?.alg);
  if (!algorithm || parsed.header?.typ && parsed.header.typ !== "JWT" || !clean(parsed.header?.kid)) throw oidcError("oidc_token_invalid", 401);
  let response;
  try { response = await fetchImpl(provider.jwksUri, { headers: { accept: "application/json" } }); } catch { throw oidcError("oidc_jwks_failed", 503); }
  if (!response?.ok) throw oidcError("oidc_jwks_failed", 503);
  const jwks = await response.json().catch(() => null);
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find((item) => item?.kid === parsed.header.kid && item?.kty === "RSA") : null;
  if (!jwk) throw oidcError("oidc_signing_key_unknown", 401);
  let verified = false;
  try {
    verified = crypto.verify(algorithm, Buffer.from(parsed.signed), crypto.createPublicKey({ key: jwk, format: "jwk" }), parsed.signature);
  } catch {
    verified = false;
  }
  if (!verified) throw oidcError("oidc_token_invalid", 401);
  const claims = parsed.payload || {};
  const now = Math.floor(Date.now() / 1000);
  if (clean(claims.iss).replace(/\/+$/, "") !== provider.issuer || !audienceMatches(claims.aud, settings.clientId)) throw oidcError("oidc_token_claims_invalid", 401);
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && clean(claims.azp) !== settings.clientId) throw oidcError("oidc_token_claims_invalid", 401);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now || !Number.isFinite(Number(claims.iat)) || Number(claims.nbf || 0) > now + 30 || Number(claims.iat) > now + 60) throw oidcError("oidc_token_claims_invalid", 401);
  if (!logout && (!nonce || !sameSecret(claims.nonce, nonce))) throw oidcError("oidc_nonce_invalid", 401);
  return claims;
}

function claimList(value = []) {
  return Array.isArray(value) ? value.map((item) => clean(item)).filter(Boolean) : [];
}

function claimsForSession(claims = {}, clientId = "") {
  const subject = clean(claims.sub);
  const email = clean(claims.email);
  if (!subject || !email || claims.email_verified !== true) throw oidcError("oidc_email_unverified", 403);
  const realmRoles = claimList(claims?.realm_access?.roles);
  const clientRoles = claimList(claims?.resource_access?.[clientId]?.roles);
  return {
    subject,
    // Email is required only to establish the verified-email policy. It is not
    // needed for app authorization and must not be copied into local sessions
    // or audit payloads.
    displayName: clean(claims.name || claims.preferred_username || "Orkestr user").slice(0, 160),
    groups: claimList(claims.groups),
    roles: [...new Set([...realmRoles, ...clientRoles])],
    sid: clean(claims.sid).slice(0, 320),
    issuedAt: new Date(Number(claims.iat) * 1000).toISOString(),
  };
}

export async function completeKeycloakLogin({ code = "", state = "", userAgent = "", ip = "", env = process.env, fetchImpl = fetch } = {}) {
  const settings = keycloakOidcSettings(env);
  if (!settings.enabled) throw oidcError("oidc_login_unavailable", 404);
  const pending = await consumeState(state, env);
  const authorizationCode = clean(code);
  if (!authorizationCode) throw oidcError("oidc_code_missing", 401);
  const provider = await discovery(settings, env, fetchImpl);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId,
    code_verifier: pending.codeVerifier,
  });
  const clientSecret = clean(env.ORKESTR_KEYCLOAK_CLIENT_SECRET || env.KEYCLOAK_CLIENT_SECRET);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${settings.clientId}:${clientSecret}`).toString("base64")}`;
  let response;
  try { response = await fetchImpl(provider.tokenEndpoint, { method: "POST", headers, body: form.toString() }); } catch { throw oidcError("oidc_token_exchange_failed", 502); }
  if (!response?.ok) throw oidcError("oidc_token_exchange_failed", 401);
  const tokens = await response.json().catch(() => null);
  const claims = await verifyJwt(tokens?.id_token, { provider, settings, nonce: pending.nonce, env, fetchImpl });
  const identity = claimsForSession(claims, settings.clientId);
  const session = await createOidcSecuritySession({
    ...identity,
    userAgent,
    ip,
    env,
  });
  return { ...session, redirectPath: pending.returnTo };
}

export async function consumeKeycloakBackchannelLogout({ logoutToken = "", env = process.env, fetchImpl = fetch } = {}) {
  const settings = keycloakOidcSettings(env);
  if (!settings.enabled) throw oidcError("oidc_login_unavailable", 404);
  const provider = await discovery(settings, env, fetchImpl);
  const claims = await verifyJwt(logoutToken, { provider, settings, logout: true, env, fetchImpl });
  const event = claims?.events?.["http://schemas.openid.net/event/backchannel-logout"];
  if (!event || (!clean(claims.sid) && !clean(claims.sub))) throw oidcError("oidc_logout_token_invalid", 401);
  return revokeOidcSecuritySessions({ subject: clean(claims.sub), sid: clean(claims.sid), env });
}
