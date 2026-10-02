// Minimal OAuth 2.1 authorization server for remote MCP clients (ChatGPT
// plugins/dots). People sign in with their normal Orkestr login; this server
// only adds client registration, an explicit consent step and short-lived,
// revocable tokens. Approving consent creates the thread-bridge grant that the
// bridge enforces on every call (thread-bridge.js). Tokens are stored hashed.
import crypto from "node:crypto";
import path from "node:path";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { explicitCanonicalAppBase } from "./canonical-app-links.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 200;
export const MCP_OAUTH_SCOPES = Object.freeze(["threads:read", "threads:comment"]);
export const MCP_OAUTH_AUTH_METHOD = "orkestr-oauth";

function clean(value) {
  return String(value ?? "").trim();
}

function oauthError(error, description = "", statusCode = 400) {
  return Object.assign(new Error(error), { statusCode, oauthError: error, description });
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const token = (prefix) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
const nowIso = () => new Date().toISOString();

export function mcpOAuthEnabled(env = process.env) {
  return env.ORKESTR_THREAD_BRIDGE_ENABLED === "1";
}

export function mcpPublicBase(env = process.env) {
  return clean(env.ORKESTR_MCP_PUBLIC_URL).replace(/\/+$/, "") || explicitCanonicalAppBase(env).replace(/\/+$/, "") || "http://127.0.0.1:19812";
}

export function mcpResourceUrl(env = process.env) {
  return `${mcpPublicBase(env)}/mcp`;
}

export function authorizationServerMetadata(env = process.env) {
  const base = mcpPublicBase(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/mcp-oauth/authorize`,
    token_endpoint: `${base}/mcp-oauth/token`,
    registration_endpoint: `${base}/mcp-oauth/register`,
    revocation_endpoint: `${base}/mcp-oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
  };
}

export function protectedResourceMetadata(env = process.env) {
  return {
    resource: mcpResourceUrl(env),
    authorization_servers: [mcpPublicBase(env)],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Orkestr threads",
  };
}

function statePath(env) {
  return env.ORKESTR_MCP_OAUTH_FILE || path.join(dataPaths(env).secrets, "mcp-oauth.json");
}

function grantsPath(env) {
  return path.join(dataPaths(env).home, "thread-bridge-grants.json");
}

function prune(state, now = Date.now()) {
  const live = (entry) => Date.parse(entry.expiresAt || "") > now;
  state.codes = (state.codes || []).filter(live);
  state.tokens = (state.tokens || []).filter(live);
  state.consents = (state.consents || []).filter(live);
  state.clients = (state.clients || []).slice(-MAX_CLIENTS);
  return state;
}

async function mutate(env, operation) {
  const file = statePath(env);
  return withStorageFileLock(file, async () => {
    const state = prune(await readJson(file, { clients: [], codes: [], tokens: [], consents: [] }));
    const result = await operation(state);
    await writeSecretJson(file, state);
    return result;
  });
}

async function readState(env) {
  return prune(await readJson(statePath(env), { clients: [], codes: [], tokens: [], consents: [] }));
}

// Redirect URIs must be HTTPS on an allowed host (default: ChatGPT), or
// loopback for local testing.
function redirectAllowed(uri, env) {
  let parsed;
  try { parsed = new URL(uri); } catch { return false; }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)) return env.ORKESTR_MCP_OAUTH_ALLOW_LOOPBACK === "1";
  const hosts = clean(env.ORKESTR_MCP_OAUTH_REDIRECT_HOSTS || "chatgpt.com,chat.openai.com").split(",").map(clean).filter(Boolean);
  return parsed.protocol === "https:" && hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

export async function registerMcpClient(body = {}, env = process.env) {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(clean).filter(Boolean) : [];
  if (!redirectUris.length || redirectUris.length > 5) throw oauthError("invalid_redirect_uri", "Provide 1-5 redirect_uris.");
  const rejected = redirectUris.find((uri) => !redirectAllowed(uri, env));
  if (rejected) throw oauthError("invalid_redirect_uri", `Redirect URI not allowed: ${rejected}`);
  const authMethod = clean(body.token_endpoint_auth_method) || "client_secret_basic";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) throw oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  const clientId = `mcp_${crypto.randomBytes(12).toString("hex")}`;
  const secret = authMethod === "none" ? "" : token("mcs");
  const client = {
    clientId,
    clientName: clean(body.client_name).slice(0, 80) || "MCP client",
    redirectUris,
    authMethod,
    secretHash: secret ? sha256(secret) : "",
    createdAt: nowIso(),
  };
  await mutate(env, (state) => { state.clients.push(client); });
  await appendEvent({ type: "mcp_oauth_client_registered", clientId, clientName: client.clientName }, env);
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

// Validates an authorization request; returns what the consent page shows.
export async function validateAuthorizeRequest(query = {}, env = process.env) {
  const client = (await readState(env)).clients.find((entry) => entry.clientId === clean(query.client_id));
  if (!client) throw oauthError("invalid_client", "Unknown client_id.", 400);
  const redirectUri = clean(query.redirect_uri);
  if (!client.redirectUris.includes(redirectUri)) throw oauthError("invalid_request", "redirect_uri is not registered for this client.", 400);
  if (clean(query.response_type) !== "code") throw oauthError("unsupported_response_type", "Only response_type=code is supported.");
  if (clean(query.code_challenge_method) !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(clean(query.code_challenge))) {
    throw oauthError("invalid_request", "PKCE with S256 is required.");
  }
  const resource = clean(query.resource);
  if (resource && resource !== mcpResourceUrl(env)) throw oauthError("invalid_target", "Unknown resource.");
  return {
    client: { clientId: client.clientId, clientName: client.clientName },
    redirectUri,
    redirectHost: new URL(redirectUri).host,
    state: clean(query.state).slice(0, 512),
    codeChallenge: clean(query.code_challenge),
    resource: resource || mcpResourceUrl(env),
    scopes: [...MCP_OAUTH_SCOPES],
  };
}

// The consent form carries a one-time id bound to the signed-in session.
export async function createConsent(request, { userId, sessionId }, env = process.env) {
  const consent = { id: token("mcc"), userId, sessionId: clean(sessionId), request, expiresAt: new Date(Date.now() + CONSENT_TTL_MS).toISOString() };
  await mutate(env, (state) => { state.consents.push(consent); });
  return consent.id;
}

export function redirectWith(uri, params = {}) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

async function upsertGrant({ userId, clientId, clientName }, env) {
  const file = grantsPath(env);
  const grantId = `grant_${clientId}`;
  await withStorageFileLock(file, async () => {
    const grants = await readJson(file, []);
    const list = Array.isArray(grants) ? grants.filter((grant) => grant?.id !== grantId) : [];
    list.push({
      id: grantId,
      enabled: true,
      ownerUserId: userId,
      agentId: clientId,
      agentName: clientName,
      issuer: "orkestr",
      authMethod: MCP_OAUTH_AUTH_METHOD,
      observe: "all",
      reply: "all",
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + GRANT_TTL_MS).toISOString(),
    });
    await writeSecretJson(file, list);
  });
  return grantId;
}

export async function decideConsent({ consentId, userId, sessionId, approve }, env = process.env) {
  const consent = await mutate(env, (state) => {
    const found = state.consents.find((entry) => entry.id === clean(consentId));
    state.consents = state.consents.filter((entry) => entry.id !== clean(consentId));
    return found || null;
  });
  if (!consent || consent.userId !== userId || consent.sessionId !== clean(sessionId)) throw oauthError("access_denied", "This approval link expired. Start the connection again.", 400);
  const { request } = consent;
  if (!approve) return redirectWith(request.redirectUri, { error: "access_denied", state: request.state });
  const grantId = await upsertGrant({ userId, clientId: request.client.clientId, clientName: request.client.clientName }, env);
  const code = token("mca");
  await mutate(env, (state) => {
    state.codes.push({
      hash: sha256(code), clientId: request.client.clientId, userId, grantId, redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge, resource: request.resource, scopes: request.scopes,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
  });
  await appendEvent({ type: "mcp_oauth_consent_approved", userId, clientId: request.client.clientId, grantId }, env);
  return redirectWith(request.redirectUri, { code, state: request.state });
}

function clientCredentials(body = {}, authorization = "") {
  const basic = /^Basic\s+(.+)$/i.exec(clean(authorization));
  if (basic) {
    const [id, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    return { clientId: decodeURIComponent(id || ""), secret: decodeURIComponent(rest.join(":")) };
  }
  return { clientId: clean(body.client_id), secret: clean(body.client_secret) };
}

function authenticateClient(state, credentials) {
  const client = state.clients.find((entry) => entry.clientId === credentials.clientId);
  if (!client) throw oauthError("invalid_client", "Unknown client.", 401);
  if (client.authMethod !== "none") {
    const given = Buffer.from(sha256(credentials.secret || ""));
    if (!credentials.secret || !crypto.timingSafeEqual(given, Buffer.from(client.secretHash))) throw oauthError("invalid_client", "Client authentication failed.", 401);
  }
  return client;
}

function issueTokens(state, { clientId, userId, grantId, resource, scopes }) {
  const access = token("mat");
  const refresh = token("mrt");
  const base = { clientId, userId, grantId, resource, scopes };
  state.tokens.push({ ...base, kind: "access", hash: sha256(access), expiresAt: new Date(Date.now() + ACCESS_TTL_MS).toISOString() });
  state.tokens.push({ ...base, kind: "refresh", hash: sha256(refresh), expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString() });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") };
}

export async function exchangeMcpToken(body = {}, authorization = "", env = process.env) {
  const grantType = clean(body.grant_type);
  return mutate(env, (state) => {
    const client = authenticateClient(state, clientCredentials(body, authorization));
    if (grantType === "authorization_code") {
      const hash = sha256(clean(body.code));
      const code = state.codes.find((entry) => entry.hash === hash);
      state.codes = state.codes.filter((entry) => entry.hash !== hash);
      if (!code || code.clientId !== client.clientId || code.redirectUri !== clean(body.redirect_uri)) throw oauthError("invalid_grant", "Invalid or expired code.");
      const verifier = clean(body.code_verifier);
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || challenge !== code.codeChallenge) throw oauthError("invalid_grant", "PKCE verification failed.");
      if (clean(body.resource) && clean(body.resource) !== code.resource) throw oauthError("invalid_target", "Resource mismatch.");
      return issueTokens(state, code);
    }
    if (grantType === "refresh_token") {
      const hash = sha256(clean(body.refresh_token));
      const refresh = state.tokens.find((entry) => entry.kind === "refresh" && entry.hash === hash);
      if (!refresh || refresh.clientId !== client.clientId) throw oauthError("invalid_grant", "Invalid or expired refresh token.");
      state.tokens = state.tokens.filter((entry) => entry.hash !== hash);
      return issueTokens(state, refresh);
    }
    throw oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  });
}

export async function revokeMcpToken(body = {}, env = process.env) {
  const hash = sha256(clean(body.token));
  await mutate(env, (state) => { state.tokens = state.tokens.filter((entry) => entry.hash !== hash); });
}

// Bearer token -> delegated-agent principal for thread-bridge.js.
export async function mcpPrincipalFromAuthorization(authorization = "", env = process.env) {
  const match = /^Bearer\s+(\S+)$/i.exec(clean(authorization));
  if (!match) return null;
  const hash = sha256(match[1]);
  const entry = (await readState(env)).tokens.find((item) => item.kind === "access" && item.hash === hash);
  if (!entry || entry.resource !== mcpResourceUrl(env)) return null;
  return {
    kind: "delegated-agent",
    ownerUserId: entry.userId,
    agentId: entry.clientId,
    grantId: entry.grantId,
    issuer: "orkestr",
    authMethod: MCP_OAUTH_AUTH_METHOD,
    scopes: entry.scopes,
  };
}
