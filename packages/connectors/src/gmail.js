import { randomUUID } from "node:crypto";
import { appendEvent, readJson, writeJson, writeSecretJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths, listConnectorScopePaths } from "./connector-storage.js";
import { readParentConnectorRuntimeConfig } from "./parent-connector-apps.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const gmailApiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const gmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

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

function normalizeEmail(value = "") {
  return clean(value).toLowerCase();
}

function approvedTesterAccounts(config = {}) {
  return splitList(config.approvedTesters || config.approvedTesterAccounts || config.allowedAccounts)
    .map(normalizeEmail)
    .filter(Boolean);
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

async function saveTokenPayload(payload, env, prior = {}, options = {}) {
  const scope = await connectorScopePaths(env, options);
  const accessToken = String(payload.access_token || "").trim();
  if (!accessToken) {
    const error = new Error("gmail_token_missing_access_token");
    error.statusCode = 502;
    throw error;
  }
  const expiresIn = Number(payload.expires_in || 3600);
  const token = {
    accessToken,
    refreshToken: String(payload.refresh_token || prior.refreshToken || "").trim(),
    scope: String(payload.scope || prior.scope || ""),
    tokenType: String(payload.token_type || prior.tokenType || "Bearer"),
    expiresAt: nowSeconds() + Math.max(1, expiresIn),
    updatedAt: new Date().toISOString(),
  };
  await writeSecretJson(connectorFile(scope, "secrets", "gmail-token.json"), token);
  return token;
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

export async function startGmailOAuth(env = process.env, options = {}) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const { clientId, redirectUri } = requireOAuthConfig(config);
  const scope = await connectorScopePaths(env, options);
  const state = randomUUID();
  const account = normalizeEmail(options.account || config.account || "");
  assertApprovedTesterAccount(account, config);
  const thread = options.thread && typeof options.thread === "object" ? options.thread : {};
  const binding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  await writeJson(connectorFile(scope, "oauth", "gmail-state.json"), {
    state,
    account,
    userId: scope.userId || "",
    threadId: clean(options.threadId || thread.id),
    chatId: clean(options.chatId || binding.chatId),
    accountId: clean(options.accountId || binding.responderAccountId || binding.outboundAccountId),
    redirectUri,
    createdAt: new Date().toISOString(),
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", gmailScopes.join(" "));
  url.searchParams.set("state", state);
  if (account) url.searchParams.set("login_hint", account);
  await appendEvent({ type: "gmail_oauth_started", userId: scope.userId || undefined }, env);
  return { authorizeUrl: url.toString(), state, redirectUri, account };
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
    const token = await saveTokenPayload(payload, env, {}, options);
    const scope = await connectorScopePaths(env, options);
    await appendEvent({ type: "gmail_oauth_token_exchanged", userId: scope.userId || undefined }, env);
    return token;
  } catch (error) {
    await saveOAuthError(error, env, options);
    throw error;
  }
}

export async function refreshGmailAccessToken(env = process.env, fetchImpl = fetch, options = {}) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  const { clientId, clientSecret } = requireOAuthConfig(config);
  const prior = await readGmailToken(env, options);
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
    const token = await saveTokenPayload(payload, env, prior, options);
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

export async function finishGmailOAuth(query, env = process.env, fetchImpl = fetch) {
  const code = String(query.get("code") || "").trim();
  const state = String(query.get("state") || "").trim();
  if (!code) {
    const error = new Error("gmail_oauth_code_required");
    error.statusCode = 400;
    throw error;
  }
  const { savedState, scopeOptions } = await findOAuthState(state, env);
  const token = await exchangeGmailCode(code, env, fetchImpl, {
    ...scopeOptions,
    redirectUri: savedState.redirectUri || "",
  });
  return {
    ok: true,
    state,
    account: savedState.account || "",
    userId: savedState.userId || "",
    threadId: savedState.threadId || "",
    chatId: savedState.chatId || "",
    accountId: savedState.accountId || "",
    scope: token.scope,
    expiresAt: token.expiresAt,
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
