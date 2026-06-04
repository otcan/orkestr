import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths } from "./connector-storage.js";
import { startGmailOAuth } from "./gmail.js";
import { startOutlookDeviceOAuth } from "./outlook.js";
import {
  parentConnectorAppStatus,
  parentConnectorProvider,
  readParentConnectorRuntimeConfig,
} from "./parent-connector-apps.js";

const oauthProviderIds = new Set(["gmail", "outlook", "jira", "shopify"]);
const statusProviderIds = new Set(["whatsapp", ...oauthProviderIds]);

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function splitScopes(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const parsed = clean(value).split(/[\s,]+/g).map((item) => item.trim()).filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}

function connectorError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeProvider(provider = "") {
  const normalized = clean(provider).toLowerCase();
  if (!statusProviderIds.has(normalized)) throw connectorError("unsupported_connector_provider", 400);
  return normalized;
}

function oauthStateFile(provider, scope) {
  return connectorFile(scope, "oauth", `${provider}-state.json`);
}

function tokenFile(provider, scope) {
  const definition = parentConnectorProvider(provider);
  return definition?.tokenFile ? connectorFile(scope, "secrets", definition.tokenFile) : "";
}

function errorFile(provider, scope) {
  return connectorFile(scope, "secrets", `${provider}-error.json`);
}

function pendingFile(provider, scope) {
  return connectorFile(scope, "secrets", `${provider}-device-pending.json`);
}

async function fileExists(filePath = "") {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(filePath = "") {
  if (!filePath) return false;
  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function normalizeShop(value = "") {
  const raw = clean(value)
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/g, "")
    .toLowerCase();
  if (!raw) return "";
  return raw.includes(".") ? raw : `${raw}.myshopify.com`;
}

function jiraAuthorizationUrl(config = {}, state = "") {
  const clientId = clean(config.clientId);
  const redirectUri = clean(config.redirectUri);
  if (!clientId || !redirectUri) throw connectorError("jira_oauth_config_required", 400);
  const scopes = splitScopes(config.scopes, ["read:jira-user", "read:jira-work", "offline_access"]);
  const url = new URL(clean(config.authorizeUrl) || "https://auth.atlassian.com/authorize");
  url.searchParams.set("audience", clean(config.audience) || "api.atlassian.com");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return { authorizeUrl: url.toString(), scopes, redirectUri };
}

function shopifyAuthorizationUrl(config = {}, args = {}, state = "") {
  const clientId = clean(config.clientId);
  const redirectUri = clean(config.redirectUri);
  const shop = normalizeShop(args.shop || args.account || config.shop);
  if (!clientId || !redirectUri) throw connectorError("shopify_oauth_config_required", 400);
  if (!shop) throw connectorError("shopify_shop_required", 400);
  const scopes = splitScopes(config.scopes, ["read_products", "read_orders"]);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString(), scopes, redirectUri, shop };
}

async function startAuthorizationCodeConnector(provider, args = {}, principal = {}, env = process.env) {
  const config = await readParentConnectorRuntimeConfig(provider, env);
  const scope = await connectorScopePaths(env, { principal });
  const state = randomUUID();
  const account = clean(args.account).toLowerCase();
  const details = provider === "jira"
    ? jiraAuthorizationUrl(config, state)
    : shopifyAuthorizationUrl(config, args, state);
  await writeJson(oauthStateFile(provider, scope), {
    provider,
    state,
    account,
    shop: details.shop || "",
    userId: scope.userId || "",
    redirectUri: details.redirectUri,
    createdAt: nowIso(),
  });
  await appendEvent({
    type: `${provider}_oauth_started`,
    provider,
    userId: scope.userId || undefined,
  }, env).catch(() => {});
  return {
    ok: true,
    provider,
    state: "authorization_url_ready",
    account,
    shop: details.shop || "",
    authorizeUrl: details.authorizeUrl,
    redirectUri: details.redirectUri,
    scopes: details.scopes,
    message: provider === "jira"
      ? "Open the Jira sign-in link and finish Atlassian authorization."
      : "Open the Shopify sign-in link and approve the store permissions.",
  };
}

export async function connectorAuthStatus(providerId = "", env = process.env, options = {}) {
  const provider = normalizeProvider(providerId);
  const definition = parentConnectorProvider(provider);
  const config = await readParentConnectorRuntimeConfig(provider, env);
  const scope = await connectorScopePaths(env, options);
  const parentConnector = parentConnectorAppStatus({ provider, config, env, runtimeStatus: options.runtimeStatus || null });
  if (provider === "whatsapp") {
    return {
      ok: true,
      provider,
      state: parentConnector.parentAppConfigured ? "parent_managed" : "parent_config_missing",
      connected: parentConnector.parentAppConfigured,
      parentConnector,
      userConnectionRequired: false,
      message: parentConnector.parentAppConfigured
        ? "WhatsApp is managed by the parent Orkestr bridge; users are bound through chat routes."
        : "WhatsApp parent bridge configuration is missing.",
    };
  }

  const tokenPath = tokenFile(provider, scope);
  const [tokenExists, pending, oauthState, error] = await Promise.all([
    fileExists(tokenPath),
    readJson(pendingFile(provider, scope), {}),
    readJson(oauthStateFile(provider, scope), {}),
    readJson(errorFile(provider, scope), {}),
  ]);
  const state = tokenExists
    ? "connected"
    : clean(error.message)
      ? "broken"
      : clean(pending.pendingId || pending.deviceCode)
        ? "pending"
        : clean(oauthState.state)
          ? "authorization_url_ready"
          : parentConnector.parentAppConfigured
            ? "not_connected"
            : parentConnector.parentAppPartiallyConfigured
              ? "parent_config_partial"
              : "parent_config_missing";
  return {
    ok: true,
    provider,
    state,
    connected: tokenExists,
    pending: state === "pending" || state === "authorization_url_ready",
    account: clean(pending.account || oauthState.account),
    shop: clean(oauthState.shop),
    parentConnector,
    userConnectionRequired: true,
    error: clean(error.message),
    updatedAt: clean(error.updatedAt),
    message: tokenExists
      ? `${definition?.label || provider} is connected for this user.`
      : parentConnector.parentAppConfigured || parentConnector.parentAppPartiallyConfigured
        ? `${definition?.label || provider} is not connected for this user yet.`
        : `${definition?.label || provider} parent app configuration is missing.`,
  };
}

export async function startConnectorAuth(args = {}, principal = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const provider = normalizeProvider(args.provider);
  if (!oauthProviderIds.has(provider)) throw connectorError("unsupported_connector_auth_provider", 400);
  const account = clean(args.account).toLowerCase();
  if (provider === "gmail") {
    const oauth = await startGmailOAuth(env, { principal, account, thread: options.thread });
    return {
      ok: true,
      provider,
      state: "authorization_url_ready",
      account: oauth.account || account,
      authorizeUrl: oauth.authorizeUrl,
      redirectUri: oauth.redirectUri,
      message: "Open the Gmail sign-in link and finish Google authorization.",
    };
  }
  if (provider === "outlook") {
    const oauth = await startOutlookDeviceOAuth(env, { principal, account }, fetchImpl);
    return {
      ...oauth,
      ok: oauth.ok !== false,
      provider,
      state: oauth.state || "device_code_pending",
      message: oauth.message || "Open the Microsoft sign-in link and enter the device code.",
    };
  }
  return startAuthorizationCodeConnector(provider, args, principal, env);
}

export async function disconnectConnectorAuth(args = {}, principal = {}, env = process.env) {
  const provider = normalizeProvider(args.provider);
  if (provider === "whatsapp") throw connectorError("whatsapp_disconnect_not_supported_here", 400);
  const scope = await connectorScopePaths(env, { principal });
  const removedFiles = [];
  for (const filePath of [
    tokenFile(provider, scope),
    errorFile(provider, scope),
    pendingFile(provider, scope),
    oauthStateFile(provider, scope),
  ].filter(Boolean)) {
    if (await unlinkIfExists(filePath)) removedFiles.push(filePath.replace(scope.root, "").replace(/^\/+/, ""));
  }
  await appendEvent({
    type: `${provider}_oauth_disconnected`,
    provider,
    userId: scope.userId || undefined,
    removedCount: removedFiles.length,
  }, env).catch(() => {});
  return {
    ok: true,
    provider,
    state: "disconnected",
    removedFiles,
    status: await connectorAuthStatus(provider, env, { principal }),
  };
}
