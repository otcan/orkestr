import { randomUUID } from "node:crypto";
import { readConnectorConfig } from "../../storage/src/config.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson, writeSecretJson } from "../../storage/src/store.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const gmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
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

async function saveTokenPayload(payload, env, prior = {}) {
  const paths = await ensureDataDirs(env);
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
  await writeSecretJson(`${paths.secrets}/gmail-token.json`, token);
  return token;
}

async function saveOAuthError(error, env) {
  const paths = await ensureDataDirs(env);
  await writeSecretJson(`${paths.secrets}/gmail-error.json`, {
    message: error.message || String(error),
    statusCode: error.statusCode || 500,
    updatedAt: new Date().toISOString(),
  });
}

export async function readGmailToken(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(`${paths.secrets}/gmail-token.json`, {});
}

export async function startGmailOAuth(env = process.env) {
  const config = await readConnectorConfig("gmail", env);
  const { clientId, redirectUri } = requireOAuthConfig(config);
  const paths = await ensureDataDirs(env);
  const state = randomUUID();
  await writeJson(`${paths.oauth}/gmail-state.json`, {
    state,
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
  await appendEvent({ type: "gmail_oauth_started" }, env);
  return { authorizeUrl: url.toString(), state, redirectUri };
}

export async function exchangeGmailCode(code, env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("gmail", env);
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig(config);
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
    const token = await saveTokenPayload(payload, env);
    await appendEvent({ type: "gmail_oauth_token_exchanged" }, env);
    return token;
  } catch (error) {
    await saveOAuthError(error, env);
    throw error;
  }
}

export async function refreshGmailAccessToken(env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("gmail", env);
  const { clientId, clientSecret } = requireOAuthConfig(config);
  const prior = await readGmailToken(env);
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
    const token = await saveTokenPayload(payload, env, prior);
    await appendEvent({ type: "gmail_oauth_token_refreshed" }, env);
    return token;
  } catch (error) {
    await saveOAuthError(error, env);
    throw error;
  }
}

export async function getGmailAccessToken(env = process.env, fetchImpl = fetch) {
  const token = await readGmailToken(env);
  if (token.accessToken && Number(token.expiresAt || 0) - 120 > nowSeconds()) {
    return token.accessToken;
  }
  const refreshed = await refreshGmailAccessToken(env, fetchImpl);
  return refreshed.accessToken;
}

export async function finishGmailOAuth(query, env = process.env, fetchImpl = fetch) {
  const paths = await ensureDataDirs(env);
  const code = String(query.get("code") || "").trim();
  const state = String(query.get("state") || "").trim();
  if (!code) {
    const error = new Error("gmail_oauth_code_required");
    error.statusCode = 400;
    throw error;
  }
  const savedState = await readJson(`${paths.oauth}/gmail-state.json`, {});
  if (savedState.state && state !== savedState.state) {
    const error = new Error("gmail_oauth_state_mismatch");
    error.statusCode = 400;
    throw error;
  }
  const token = await exchangeGmailCode(code, env, fetchImpl);
  return {
    ok: true,
    state,
    scope: token.scope,
    expiresAt: token.expiresAt,
    receivedAt: new Date().toISOString(),
  };
}
