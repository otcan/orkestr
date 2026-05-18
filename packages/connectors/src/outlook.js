import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readConnectorConfig } from "../../storage/src/config.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";

const defaultScopes = ["offline_access", "User.Read", "Mail.Read"];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function splitScopes(value) {
  if (Array.isArray(value)) return value.map(String).map((scope) => scope.trim()).filter(Boolean);
  return String(value || "").split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
}

function normalizedTenantId(value) {
  return String(value || "common").trim() || "common";
}

function requireOutlookConfig(config) {
  const clientId = String(config.clientId || "").trim();
  const tenantId = normalizedTenantId(config.tenantId);
  const scopes = splitScopes(config.scopes).length ? splitScopes(config.scopes) : defaultScopes;
  if (!clientId) {
    const error = new Error("outlook_oauth_client_id_required");
    error.statusCode = 400;
    throw error;
  }
  return { clientId, tenantId, scopes };
}

async function postForm(url, params, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function saveOAuthError(error, env) {
  const paths = await ensureDataDirs(env);
  await writeSecretJson(`${paths.secrets}/outlook-error.json`, {
    message: error.message || String(error),
    statusCode: error.statusCode || 500,
    updatedAt: new Date().toISOString(),
  });
}

async function pendingPath(env) {
  const paths = await ensureDataDirs(env);
  return `${paths.secrets}/outlook-device-pending.json`;
}

export async function readOutlookToken(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(`${paths.secrets}/outlook-token.json`, {});
}

export async function startOutlookDeviceOAuth(env = process.env, options = {}, fetchImpl = fetch) {
  const storedConfig = await readConnectorConfig("outlook", env);
  const config = {
    ...storedConfig,
    clientId: storedConfig.clientId || env.OUTLOOK_OAUTH_CLIENT_ID || env.MICROSOFT_OAUTH_CLIENT_ID || "",
    tenantId: storedConfig.tenantId || env.OUTLOOK_OAUTH_TENANT_ID || env.MICROSOFT_OAUTH_TENANT_ID || "common",
    scopes: storedConfig.scopes || env.OUTLOOK_OAUTH_SCOPES || "",
  };
  const { clientId, tenantId, scopes } = requireOutlookConfig(config);
  const account = String(options.account || config.account || "").trim();
  try {
    const { response, payload } = await postForm(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`,
      {
        client_id: clientId,
        scope: scopes.join(" "),
      },
      fetchImpl,
    );
    if (!response.ok || !payload.device_code) {
      const error = new Error(payload.error_description || payload.error || `outlook_device_code_http_${response.status}`);
      error.statusCode = response.status || 502;
      throw error;
    }
    const pending = {
      pendingId: randomUUID(),
      account,
      clientId,
      tenantId,
      scopes,
      deviceCode: String(payload.device_code),
      userCode: String(payload.user_code || ""),
      verificationUri: String(payload.verification_uri || ""),
      verificationUriComplete: String(payload.verification_uri_complete || ""),
      message: String(payload.message || "Approve the Microsoft sign-in request."),
      interval: Number(payload.interval || 5),
      expiresAt: nowSeconds() + Number(payload.expires_in || 900),
      createdAt: new Date().toISOString(),
    };
    await writeSecretJson(await pendingPath(env), pending);
    await appendEvent({ type: "outlook_oauth_device_started" }, env);
    return {
      ok: true,
      provider: "outlook",
      state: "device_code_pending",
      pendingId: pending.pendingId,
      account,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      userCode: pending.userCode,
      message: pending.message,
      interval: pending.interval,
      expiresAt: pending.expiresAt,
      scopes,
    };
  } catch (error) {
    await saveOAuthError(error, env);
    throw error;
  }
}

export async function pollOutlookDeviceOAuth(pendingId, env = process.env, fetchImpl = fetch) {
  const pending = await readJson(await pendingPath(env), {});
  if (!pending.pendingId || String(pendingId || "") !== String(pending.pendingId)) {
    const error = new Error("outlook_oauth_pending_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (nowSeconds() > Number(pending.expiresAt || 0)) {
    await fs.rm(await pendingPath(env), { force: true });
    return {
      ok: false,
      provider: "outlook",
      state: "expired",
      pendingId,
      message: "Microsoft device login expired. Start Outlook sign-in again.",
    };
  }
  const { response, payload } = await postForm(
    `https://login.microsoftonline.com/${encodeURIComponent(pending.tenantId)}/oauth2/v2.0/token`,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: String(pending.clientId),
      device_code: String(pending.deviceCode),
    },
    fetchImpl,
  );
  if (!response.ok || !payload.access_token) {
    const state = String(payload.error || `outlook_token_http_${response.status}`);
    if (state === "authorization_pending" || state === "slow_down") {
      return {
        ok: false,
        provider: "outlook",
        state,
        pendingId,
        account: pending.account || "",
        message: payload.error_description || "Waiting for Microsoft approval.",
        interval: Number(pending.interval || 5) + (state === "slow_down" ? 5 : 0),
      };
    }
    const error = new Error(payload.error_description || payload.error || `outlook_token_http_${response.status}`);
    error.statusCode = response.status || 502;
    await saveOAuthError(error, env);
    throw error;
  }
  const paths = await ensureDataDirs(env);
  const token = {
    accessToken: String(payload.access_token || ""),
    refreshToken: String(payload.refresh_token || ""),
    scope: String(payload.scope || ""),
    tokenType: String(payload.token_type || "Bearer"),
    expiresAt: nowSeconds() + Number(payload.expires_in || 3600),
    account: String(pending.account || ""),
    updatedAt: new Date().toISOString(),
  };
  await writeSecretJson(`${paths.secrets}/outlook-token.json`, token);
  await fs.rm(await pendingPath(env), { force: true });
  await appendEvent({ type: "outlook_oauth_token_stored" }, env);
  return {
    ok: true,
    provider: "outlook",
    state: "connected",
    account: token.account,
    scope: token.scope,
    expiresAt: token.expiresAt,
    message: "Outlook token stored locally.",
  };
}
