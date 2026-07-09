import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { appendEvent, readJson, writeJson, writeSecretJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths, listConnectorScopePaths } from "./connector-storage.js";
import {
  encryptBrokerClientPayload,
  encryptBrokerInstancePayload,
  ensureBrokerClientRegistration,
} from "../../core/src/broker-instance-registry.js";
import {
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceScopesForCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "./google-workspace-scopes.js";
import { readParentConnectorRuntimeConfig } from "./parent-connector-apps.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const gmailApiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const defaultGmailCapabilities = ["gmail_read", "gmail_actions"];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function clean(value) {
  return String(value || "").trim();
}

function splitList(value = "") {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[\s,]+/g).map(clean).filter(Boolean);
}

function uniqueList(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(clean).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeEmail(value = "") {
  return clean(value).toLowerCase();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function looksLikeGoogleAccessToken(value = "") {
  const token = clean(value);
  return token.startsWith("ya29.") || token.startsWith("ya29_") || token.length >= 80;
}

function profileLookupTimeoutMs(env = process.env) {
  return Math.max(250, Math.min(5000, positiveInteger(env.ORKESTR_GMAIL_PROFILE_LOOKUP_TIMEOUT_MS, 1500)));
}

function timeoutFetch(fetchImpl = fetch, timeoutMs = 1500) {
  return async (url, options = {}) => {
    if (!timeoutMs || options.signal) return fetchImpl(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function approvedTesterAccounts(config = {}) {
  return splitList(config.approvedTesters || config.approvedTesterAccounts || config.allowedAccounts)
    .map(normalizeEmail)
    .filter(Boolean);
}

function tenantVmIdForOAuth(env = process.env, options = {}) {
  return clean(options.tenantVmId || env.ORKESTR_TENANT_VM_ID);
}

function normalizePublicBaseUrl(value = "") {
  const text = clean(value).replace(/\/+$/g, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.toString().replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function publicUrlOrigin(value = "") {
  const normalized = normalizePublicBaseUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).origin.replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function explicitGmailOAuthRedirectUri(env = process.env) {
  return clean(env.GMAIL_OAUTH_REDIRECT_URI || env.GOOGLE_OAUTH_REDIRECT_URI);
}

function brokeredGmailOAuthRedirectUri(env = process.env, fallback = "") {
  const explicit = explicitGmailOAuthRedirectUri(env);
  if (explicit) return explicit;
  const base =
    normalizePublicBaseUrl(
      env.ORKESTR_GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL ||
        env.ORKESTR_GMAIL_OAUTH_PUBLIC_BASE_URL ||
        env.GMAIL_OAUTH_PUBLIC_BASE_URL ||
        env.ORKESTR_OAUTH_PUBLIC_BASE_URL ||
        env.ORKESTR_OAUTH_CALLBACK_BASE_URL,
    ) ||
    normalizePublicBaseUrl(
      env.ORKESTR_PUBLIC_APP_URL ||
        env.ORKESTR_PUBLIC_URL ||
        env.ORKESTR_APP_URL ||
        env.ORKESTR_PUBLIC_HTTPS_URL ||
        env.ORKESTR_HTTPS_URL ||
        env.ORKESTR_TAILSCALE_HTTPS_NAME ||
        env.ORKESTR_BASE_URL,
    ) ||
    normalizePublicBaseUrl(env.ORKESTR_GOOGLE_WORKSPACE_CONNECT_PUBLIC_URL) ||
    publicUrlOrigin(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL || env.ORKESTR_PAIRING_URL || env.ORKESTR_AUTH_URL) ||
    normalizePublicBaseUrl(env.ORKESTR_CONNECT_PUBLIC_URL || env.ORKESTR_CONNECT_BASE_URL);
  if (base) return `${base}/oauth/gmail/callback`;
  return clean(fallback);
}

function newOAuthState(env = process.env, options = {}) {
  const baseState = clean(options.state) || randomUUID();
  const tenantVmId = tenantVmIdForOAuth(env, options);
  if (!tenantVmId) return baseState;
  const prefix = `tenant:${tenantVmId}:`;
  return baseState.startsWith(prefix) ? baseState : `${prefix}${baseState}`;
}

function assertApprovedTesterAccount(account = "", config = {}) {
  const approved = approvedTesterAccounts(config);
  if (!approved.length) return;
  const normalized = normalizeEmail(account);
  if (!normalized) {
    const error = new Error("gmail_account_required_for_tester_check");
    error.statusCode = 400;
    throw error;
  }
  if (approved.includes("*")) return;
  const allowed = approved.some((item) =>
    item === normalized ||
    (item.startsWith("@") && normalized.endsWith(item))
  );
  if (!allowed) {
    const error = new Error("gmail_account_not_approved_for_testing");
    error.statusCode = 403;
    error.account = normalized;
    throw error;
  }
}

function requireOAuthConfig(config) {
  const clientId = String(config.clientId || "").trim();
  const clientSecret = String(config.clientSecret || "").trim();
  const redirectUri = String(config.redirectUri || "").trim();
  if (!clientId || !redirectUri) {
    const error = new Error("gmail_oauth_config_required");
    error.statusCode = 400;
    throw error;
  }
  return { clientId, clientSecret, redirectUri };
}

async function requestToken(params, fetchImpl = fetch) {
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || `gmail_token_http_${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

function normalizeOAuthTokenPayload(payload, prior = {}, options = {}) {
  const accessToken = String(payload.access_token || "").trim();
  if (!accessToken) {
    const error = new Error("gmail_token_missing_access_token");
    error.statusCode = 502;
    throw error;
  }
  const expiresIn = Number(payload.expires_in || 3600);
  const requestedCapabilities = normalizeGoogleWorkspaceCapabilities(
    options.capabilities || options.requestedCapabilities || prior.requestedCapabilities || [],
    defaultGmailCapabilities,
  );
  const requestedScopes = uniqueList(options.scopes || options.requestedScopes || prior.requestedScopes || []);
  const grantedScopes = uniqueList(
    splitList(payload.scope || prior.scope || prior.grantedScopes || requestedScopes.join(" ")),
  );
  const capabilities = googleWorkspaceCapabilitiesForScopes(grantedScopes, requestedCapabilities);
  const token = {
    accessToken,
    refreshToken: String(payload.refresh_token || prior.refreshToken || "").trim(),
    account: normalizeEmail(options.account || prior.account || ""),
    scope: grantedScopes.join(" "),
    grantedScopes,
    capabilities,
    requestedCapabilities,
    requestedScopes,
    provider: clean(options.provider || prior.provider || "gmail"),
    tokenType: String(payload.token_type || prior.tokenType || "Bearer"),
    expiresAt: nowSeconds() + Math.max(1, expiresIn),
    updatedAt: new Date().toISOString(),
  };
  const brokerInstanceId = clean(options.brokerInstanceId || prior.brokerInstanceId);
  if (options.brokered === true || prior.brokered === true || brokerInstanceId) {
    token.brokered = true;
    token.brokerGrantSource = clean(options.brokerGrantSource || prior.brokerGrantSource || "parent_broker");
    token.brokerInstanceId = brokerInstanceId;
    token.brokerRefresh = options.brokerRefresh !== false && prior.brokerRefresh !== false;
  }
  return token;
}

async function writeGmailToken(token, env, options = {}) {
  const scope = await connectorScopePaths(env, options);
  await writeSecretJson(connectorFile(scope, "secrets", "gmail-token.json"), token);
  await fs.rm(connectorFile(scope, "secrets", "gmail-error.json"), { force: true }).catch(() => {});
  return token;
}

async function saveTokenPayload(payload, env, prior = {}, options = {}) {
  const token = normalizeOAuthTokenPayload(payload, prior, options);
  return writeGmailToken(token, env, options);
}

function normalizeBrokerGrantToken(rawToken = {}, grant = {}, prior = {}) {
  const accessToken = clean(rawToken.accessToken || rawToken.access_token);
  if (!accessToken) {
    const error = new Error("gmail_token_missing_access_token");
    error.statusCode = 502;
    throw error;
  }
  const requestedCapabilities = normalizeGoogleWorkspaceCapabilities(
    grant.requestedCapabilities || rawToken.requestedCapabilities || prior.requestedCapabilities || [],
    defaultGmailCapabilities,
  );
  const requestedScopes = uniqueList(grant.requestedScopes || rawToken.requestedScopes || prior.requestedScopes || []);
  const grantedScopeInput = Array.isArray(rawToken.grantedScopes)
    ? rawToken.grantedScopes
    : splitList(rawToken.scope || rawToken.grantedScopes || requestedScopes.join(" "));
  const grantedScopes = uniqueList(grantedScopeInput);
  const expiresAt = Number(rawToken.expiresAt || 0);
  return {
    accessToken,
    refreshToken: clean(rawToken.refreshToken || rawToken.refresh_token || prior.refreshToken),
    account: normalizeEmail(grant.account || rawToken.account || prior.account || ""),
    scope: grantedScopes.join(" "),
    grantedScopes,
    capabilities: googleWorkspaceCapabilitiesForScopes(grantedScopes, requestedCapabilities),
    requestedCapabilities,
    requestedScopes,
    provider: clean(grant.provider || rawToken.provider || prior.provider || "google_workspace"),
    tokenType: clean(rawToken.tokenType || rawToken.token_type || prior.tokenType || "Bearer"),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt
      : nowSeconds() + Math.max(1, Number(rawToken.expiresIn || rawToken.expires_in || 3600) || 3600),
    updatedAt: new Date().toISOString(),
    brokered: true,
    brokerGrantSource: "parent_broker",
    brokerInstanceId: clean(grant.brokerInstanceId || rawToken.brokerInstanceId || prior.brokerInstanceId),
    brokerRefresh: true,
  };
}

export async function saveBrokeredGmailGrant(grant = {}, env = process.env) {
  const userId = clean(grant.userId || grant.tenantUserId);
  const prior = await readGmailToken(env, userId ? { userId } : {});
  const token = normalizeBrokerGrantToken(grant.token || grant, grant, prior);
  await writeGmailToken(token, env, userId ? { userId } : {});
  await appendEvent({ type: "gmail_broker_grant_saved", userId: userId || undefined, brokerInstanceId: token.brokerInstanceId || undefined }, env).catch(() => {});
  return {
    ok: true,
    provider: token.provider,
    userId,
    account: token.account || clean(grant.account),
    brokerInstanceId: token.brokerInstanceId,
    capabilities: token.capabilities || [],
    grantedScopes: token.grantedScopes || [],
    expiresAt: token.expiresAt,
  };
}

async function saveOAuthError(error, env, options = {}) {
  const scope = await connectorScopePaths(env, options);
  await writeSecretJson(connectorFile(scope, "secrets", "gmail-error.json"), {
    message: error.message || String(error),
    statusCode: error.statusCode || 500,
    updatedAt: new Date().toISOString(),
  });
}

export async function readGmailToken(env = process.env, options = {}) {
  const scope = await connectorScopePaths(env, options);
  return readJson(connectorFile(scope, "secrets", "gmail-token.json"), {});
}

export async function getGmailProfileEmail(accessToken = "", fetchImpl = fetch, options = {}) {
  const token = clean(accessToken);
  if (!token) return "";
  if (!options.forceProfileLookup && !looksLikeGoogleAccessToken(token)) return "";
  const response = await timeoutFetch(fetchImpl, positiveInteger(options.timeoutMs, profileLookupTimeoutMs(options.env || process.env)))(
    `${gmailApiBase}/profile`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || payload.error || `gmail_profile_http_${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return normalizeEmail(payload.emailAddress || payload.email || "");
}

async function tokenWithResolvedAccount(token = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const account = normalizeEmail(token.account || token.email || token.loginHint);
  const accessToken = token.accessToken || token.access_token;
  let resolved = (account && options.verifyAccount !== true)
    ? ""
    : await getGmailProfileEmail(accessToken, fetchImpl, { ...options, env }).catch(() => "");
  if (account && resolved && resolved !== account) {
    const error = new Error("gmail_account_mismatch");
    error.statusCode = 403;
    error.expectedAccount = account;
    error.actualAccount = resolved;
    throw error;
  }
  if (account) {
    return {
      token: {
        ...token,
        account,
        ...(resolved ? { email: resolved, updatedAt: new Date().toISOString() } : {}),
      },
      account,
      updated: Boolean(resolved),
    };
  }
  let baseToken = token;
  if (!resolved && options.refreshIfNeeded === true && clean(token.refreshToken || token.refresh_token)) {
    const refreshFetch = timeoutFetch(fetchImpl, profileLookupTimeoutMs(env));
    const refreshedAccessToken = await getGmailAccessToken(env, refreshFetch, options).catch(() => "");
    if (refreshedAccessToken && refreshedAccessToken !== accessToken) {
      resolved = await getGmailProfileEmail(refreshedAccessToken, fetchImpl, { ...options, env }).catch(() => "");
      if (resolved) {
        baseToken = await readGmailToken(env, options).catch(() => token);
      }
    }
  }
  if (!resolved) return { token, account: "", updated: false };
  return {
    token: {
      ...baseToken,
      account: resolved,
      email: normalizeEmail(baseToken.email) || resolved,
      updatedAt: new Date().toISOString(),
    },
    account: resolved,
    updated: true,
  };
}

export async function enrichGmailTokenAccount(env = process.env, fetchImpl = fetch, options = {}) {
  const token = await readGmailToken(env, options);
  const resolved = await tokenWithResolvedAccount(token, env, fetchImpl, { ...options, refreshIfNeeded: true });
  if (resolved.updated) {
    await writeGmailToken(resolved.token, env, options);
  }
  return resolved;
}

export async function startGmailOAuth(env = process.env, options = {}) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const brokered = Boolean(clean(options.brokerInstanceId || options.brokerTenantVmId));
  const redirectUri = brokered
    ? brokeredGmailOAuthRedirectUri(env, config.redirectUri)
    : clean(config.redirectUri);
  const { clientId } = requireOAuthConfig({ ...config, redirectUri });
  const scope = await connectorScopePaths(env, options);
  const tenantVmId = tenantVmIdForOAuth(env, options);
  const state = newOAuthState(env, options);
  const account = normalizeEmail(options.account || config.account || "");
  const capabilities = normalizeGoogleWorkspaceCapabilities(options.capabilities || options.requestedCapabilities, defaultGmailCapabilities);
  const requestedScopes = uniqueList(options.scopes || options.requestedScopes || googleWorkspaceScopesForCapabilities(capabilities));
  const provider = clean(options.provider || "gmail");
  assertApprovedTesterAccount(account, config);
  const thread = options.thread && typeof options.thread === "object" ? options.thread : {};
  const binding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  await writeJson(connectorFile(scope, "oauth", "gmail-state.json"), {
    provider,
    state,
    connectId: clean(options.connectId),
    account,
    userId: scope.userId || "",
    tenantVmId,
    threadId: clean(options.threadId || thread.id),
    chatId: clean(options.chatId || binding.chatId),
    accountId: clean(options.accountId || binding.responderAccountId || binding.outboundAccountId),
    brokerInstanceId: clean(options.brokerInstanceId),
    brokerTenantVmId: clean(options.brokerTenantVmId),
    brokerTenantUserId: clean(options.brokerTenantUserId),
    brokerTenantThreadId: clean(options.brokerTenantThreadId),
    brokerTenantChatId: clean(options.brokerTenantChatId),
    brokerTenantAccountId: clean(options.brokerTenantAccountId),
    requestedCapabilities: capabilities,
    requestedScopes,
    redirectUri,
    createdAt: new Date().toISOString(),
  });
  await fs.rm(connectorFile(scope, "secrets", "gmail-error.json"), { force: true }).catch(() => {});
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", requestedScopes.join(" "));
  url.searchParams.set("state", state);
  if (account) url.searchParams.set("login_hint", account);
  await appendEvent({ type: `${provider === "google_workspace" ? "google_workspace" : "gmail"}_oauth_started`, userId: scope.userId || undefined }, env);
  return { authorizeUrl: url.toString(), state, redirectUri, account, provider, capabilities, scopes: requestedScopes };
}

export async function exchangeGmailCode(code, env = process.env, fetchImpl = fetch, options = {}) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const { clientId, clientSecret, redirectUri: configuredRedirectUri } = requireOAuthConfig(config);
  const redirectUri = String(options.redirectUri || configuredRedirectUri || "").trim();
  if (!clientSecret) {
    const error = new Error("gmail_client_secret_required");
    error.statusCode = 400;
    throw error;
  }
  try {
    const payload = await requestToken(
      {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      },
      fetchImpl,
    );
    const token = options.saveToken === false
      ? normalizeOAuthTokenPayload(payload, {}, options)
      : await saveTokenPayload(payload, env, {}, options);
    const scope = await connectorScopePaths(env, options);
    await appendEvent({ type: "gmail_oauth_token_exchanged", userId: scope.userId || undefined }, env);
    return token;
  } catch (error) {
    await saveOAuthError(error, env, options);
    throw error;
  }
}

export async function refreshGmailBrokerToken(refreshToken, env = process.env, fetchImpl = fetch) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const { clientId, clientSecret } = requireOAuthConfig(config);
  const token = clean(refreshToken);
  if (!clientSecret || !token) {
    const error = new Error("gmail_refresh_config_required");
    error.statusCode = 400;
    throw error;
  }
  return requestToken(
    {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token,
    },
    fetchImpl,
  );
}

async function refreshBrokeredGmailAccessToken(prior = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const refreshToken = clean(prior.refreshToken);
  if (!refreshToken) {
    const error = new Error("gmail_refresh_config_required");
    error.statusCode = 400;
    throw error;
  }
  const registration = await ensureBrokerClientRegistration(env);
  if (registration?.ok === false || !registration?.instanceId || !registration?.brokerBaseUrl) {
    const error = new Error(registration?.reason || "broker_google_workspace_registration_required");
    error.statusCode = Number(registration?.status || 409) || 409;
    throw error;
  }
  const expectedInstanceId = clean(prior.brokerInstanceId);
  if (expectedInstanceId && expectedInstanceId !== clean(registration.instanceId)) {
    const error = new Error("broker_google_workspace_instance_mismatch");
    error.statusCode = 409;
    throw error;
  }
  const body = await encryptBrokerClientPayload({
    provider: clean(prior.provider || options.provider || "google_workspace"),
    refreshToken,
    requestedCapabilities: prior.requestedCapabilities || options.requestedCapabilities || options.capabilities || [],
    requestedScopes: prior.requestedScopes || options.requestedScopes || options.scopes || [],
  }, registration, env);
  const url = new URL(`/api/broker/instances/${encodeURIComponent(registration.instanceId)}/google-workspace/refresh-token`, registration.brokerBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `broker_google_workspace_refresh_http_${response.status}`);
    error.statusCode = response.status || 502;
    throw error;
  }
  const tokenPayload = payload.token || payload;
  const token = await saveTokenPayload(tokenPayload, env, prior, {
    ...options,
    provider: prior.provider || options.provider || "google_workspace",
    requestedCapabilities: prior.requestedCapabilities || options.requestedCapabilities || options.capabilities || [],
    requestedScopes: prior.requestedScopes || options.requestedScopes || options.scopes || [],
    brokered: true,
    brokerGrantSource: "parent_broker",
    brokerInstanceId: clean(prior.brokerInstanceId || registration.instanceId),
    brokerRefresh: true,
  });
  const scope = await connectorScopePaths(env, options);
  await appendEvent({ type: "gmail_broker_token_refreshed", userId: scope.userId || undefined }, env).catch(() => {});
  return token;
}

export async function refreshGmailAccessToken(env = process.env, fetchImpl = fetch, options = {}) {
  const prior = await readGmailToken(env, options);
  if (prior.brokered === true || prior.brokerRefresh === true) {
    return refreshBrokeredGmailAccessToken(prior, env, fetchImpl, options);
  }
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const { clientId, clientSecret } = requireOAuthConfig(config);
  const refreshToken = String(prior.refreshToken || "").trim();
  if (!clientSecret || !refreshToken) {
    const error = new Error("gmail_refresh_config_required");
    error.statusCode = 400;
    throw error;
  }
  try {
    const payload = await requestToken(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      },
      fetchImpl,
    );
    const token = await saveTokenPayload(payload, env, prior, {
      ...options,
      provider: prior.provider || options.provider || "gmail",
      requestedCapabilities: prior.requestedCapabilities || options.requestedCapabilities || options.capabilities || [],
      requestedScopes: prior.requestedScopes || options.requestedScopes || options.scopes || [],
    });
    const scope = await connectorScopePaths(env, options);
    await appendEvent({ type: "gmail_oauth_token_refreshed", userId: scope.userId || undefined }, env);
    return token;
  } catch (error) {
    await saveOAuthError(error, env, options);
    throw error;
  }
}

export async function getGmailAccessToken(env = process.env, fetchImpl = fetch, options = {}) {
  const token = await readGmailToken(env, options);
  if (token.accessToken && Number(token.expiresAt || 0) - 120 > nowSeconds()) {
    return token.accessToken;
  }
  const refreshed = await refreshGmailAccessToken(env, fetchImpl, options);
  return refreshed.accessToken;
}

async function findOAuthState(state, env = process.env) {
  let sawSavedState = false;
  for (const scope of await listConnectorScopePaths(env)) {
    const savedState = await readJson(connectorFile(scope, "oauth", "gmail-state.json"), {});
    if (!savedState.state) continue;
    sawSavedState = true;
    if (!state || state === savedState.state) {
      return {
        savedState,
        scopeOptions: scope.userId ? { userId: scope.userId } : {},
      };
    }
  }
  if (sawSavedState || state) {
    const error = new Error("gmail_oauth_state_mismatch");
    error.statusCode = 400;
    throw error;
  }
  return { savedState: {}, scopeOptions: {} };
}

async function provisionBrokeredGmailGrant(savedState = {}, token = {}, env = process.env, fetchImpl = fetch) {
  const brokerInstanceId = clean(savedState.brokerInstanceId);
  if (!brokerInstanceId) return null;
  const account = normalizeEmail(token.account || token.email);
  const { record, body } = await encryptBrokerInstancePayload(brokerInstanceId, {
    provider: savedState.provider || "google_workspace",
    account,
    userId: savedState.brokerTenantUserId || savedState.userId || "",
    tenantVmId: savedState.brokerTenantVmId || "",
    threadId: savedState.brokerTenantThreadId || savedState.threadId || "",
    chatId: savedState.brokerTenantChatId || savedState.chatId || "",
    accountId: savedState.brokerTenantAccountId || savedState.accountId || "",
    brokerInstanceId,
    requestedCapabilities: savedState.requestedCapabilities || [],
    requestedScopes: savedState.requestedScopes || [],
    token: {
      accessToken: token.accessToken || "",
      refreshToken: token.refreshToken || "",
      account,
      email: account,
      scope: token.scope || "",
      grantedScopes: token.grantedScopes || [],
      capabilities: token.capabilities || [],
      requestedCapabilities: token.requestedCapabilities || savedState.requestedCapabilities || [],
      requestedScopes: token.requestedScopes || savedState.requestedScopes || [],
      provider: token.provider || savedState.provider || "google_workspace",
      tokenType: token.tokenType || "Bearer",
      expiresAt: token.expiresAt || 0,
    },
  }, env);
  const baseUrl = clean(record.endpointBaseUrl || record.connectBaseUrl);
  if (!baseUrl) {
    const error = new Error("broker_google_workspace_grant_endpoint_missing");
    error.statusCode = 502;
    throw error;
  }
  const url = new URL("/api/broker/google-workspace/grants", baseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `broker_google_workspace_grant_http_${response.status}`);
    error.statusCode = response.status || 502;
    throw error;
  }
  return payload;
}

export async function finishGmailOAuth(query, env = process.env, fetchImpl = fetch) {
  const code = String(query.get("code") || "").trim();
  const state = String(query.get("state") || "").trim();
  if (!code) {
    const error = new Error("gmail_oauth_code_required");
    error.statusCode = 400;
    throw error;
  }
  const { savedState, scopeOptions } = await findOAuthState(state, env);
  const brokered = Boolean(clean(savedState.brokerInstanceId));
  const token = await exchangeGmailCode(code, env, fetchImpl, {
    ...scopeOptions,
    account: "",
    redirectUri: savedState.redirectUri || "",
    provider: savedState.provider || "gmail",
    connectId: savedState.connectId || "",
    requestedCapabilities: savedState.requestedCapabilities || [],
    requestedScopes: savedState.requestedScopes || [],
    saveToken: false,
  });
  const resolved = await tokenWithResolvedAccount(token, env, fetchImpl, scopeOptions);
  if (!brokered) {
    await writeGmailToken(resolved.token, env, scopeOptions);
  }
  const brokerGrant = brokered
    ? await provisionBrokeredGmailGrant(savedState, resolved.token, env, fetchImpl)
    : null;
  const account = resolved.account || savedState.account || "";
  return {
    ok: true,
    provider: savedState.provider || "gmail",
    brokered,
    brokerInstanceId: savedState.brokerInstanceId || "",
    brokerGrant,
    state,
    connectId: savedState.connectId || "",
    account,
    userId: savedState.userId || "",
    threadId: savedState.threadId || "",
    chatId: savedState.chatId || "",
    accountId: savedState.accountId || "",
    scope: resolved.token.scope,
    grantedScopes: resolved.token.grantedScopes || [],
    requestedCapabilities: savedState.requestedCapabilities || [],
    capabilities: resolved.token.capabilities || [],
    expiresAt: resolved.token.expiresAt,
    receivedAt: new Date().toISOString(),
  };
}

function decodeBase64Url(data = "") {
  const normalized = String(data).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function headerMap(headers = []) {
  return Object.fromEntries(headers.map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
}

function collectPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const text = collectPlainText(part);
    if (text) return text;
  }
  return "";
}

export function normalizeGmailMessage(message) {
  const headers = headerMap(message.payload?.headers || []);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds || [],
    snippet: message.snippet || "",
    internalDate: message.internalDate || "",
    subject: headers.subject || "",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || "",
    text: collectPlainText(message.payload) || message.snippet || "",
  };
}

async function gmailApiGet(resourcePath, params, env, fetchImpl, options = {}) {
  const accessToken = await getGmailAccessToken(env, fetchImpl, options);
  const url = new URL(`${gmailApiBase}${resourcePath}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || payload.error || `gmail_api_http_${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

export async function listGmailMessages({ maxResults = 10, query = "" } = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const payload = await gmailApiGet(
    "/messages",
    {
      maxResults: Math.max(1, Math.min(50, Number(maxResults) || 10)),
      q: query,
    },
    env,
    fetchImpl,
    options,
  );
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    nextPageToken: payload.nextPageToken || "",
    resultSizeEstimate: payload.resultSizeEstimate || 0,
  };
}

export async function getGmailMessage(messageId, env = process.env, fetchImpl = fetch, options = {}) {
  const id = String(messageId || "").trim();
  if (!id) {
    const error = new Error("gmail_message_id_required");
    error.statusCode = 400;
    throw error;
  }
  const payload = await gmailApiGet(`/messages/${encodeURIComponent(id)}`, { format: "full" }, env, fetchImpl, options);
  return normalizeGmailMessage(payload);
}
