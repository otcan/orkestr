import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths } from "./connector-storage.js";
import {
  classifyGmailConnectorError,
  enrichGmailTokenAccount,
  readGmailToken,
  startGmailOAuth,
  validateGmailConnection,
} from "./gmail.js";
import {
  listGoogleWorkspaceConnections,
  removeGoogleWorkspaceConnection,
  resolveGoogleWorkspaceConnection,
} from "./google-workspace-connections.js";
import {
  googleWorkspaceCapabilityLabels,
  googleWorkspaceCapabilitiesForScopes,
  normalizeGoogleWorkspaceCapabilities,
} from "./google-workspace-scopes.js";
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

function publicGmailTokenDetails(token = {}) {
  const grantedScopes = Array.isArray(token.grantedScopes)
    ? token.grantedScopes.map(clean).filter(Boolean)
    : splitScopes(token.scope);
  const capabilities = grantedScopes.length
    ? googleWorkspaceCapabilitiesForScopes(grantedScopes, [])
    : Array.isArray(token.capabilities) && token.capabilities.length
      ? normalizeGoogleWorkspaceCapabilities(token.capabilities, [])
      : [];
  return {
    capabilities,
    capabilityLabels: googleWorkspaceCapabilityLabels(capabilities),
    grantedScopes,
  };
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
  const initialGmailToken = provider === "gmail"
    ? await readGmailToken(env, { ...options, allowUnhealthy: true }).catch(() => ({}))
    : null;
  const [tokenExists, priorError] = await Promise.all([
    provider === "gmail"
      ? Boolean(clean(initialGmailToken?.accessToken || initialGmailToken?.refreshToken))
      : fileExists(tokenPath),
    readJson(errorFile(provider, scope), {}),
  ]);
  const priorGmailFailure = provider === "gmail" && clean(priorError.message)
    ? { ...classifyGmailConnectorError(priorError, { errorContext: priorError.errorContext }), ...priorError }
    : null;
  if (
    provider === "gmail" &&
    tokenExists &&
    options.validate === true &&
    priorGmailFailure?.state !== "reauth_required" &&
    clean(initialGmailToken?.connection?.healthState) !== "reauth_required"
  ) {
    await validateGmailConnection(env, options.fetchImpl || fetch, options).catch(() => null);
  }
  const [pending, oauthState, error, token] = await Promise.all([
    readJson(pendingFile(provider, scope), {}),
    readJson(oauthStateFile(provider, scope), {}),
    readJson(errorFile(provider, scope), {}),
    provider === "gmail" ? initialGmailToken : readJson(tokenPath, {}),
  ]);
  let statusToken = token;
  let account = clean(token.account || pending.account || oauthState.account);
  if (provider === "gmail" && tokenExists && !account) {
    const resolved = await enrichGmailTokenAccount(env, options.fetchImpl || fetch, options).catch(() => null);
    if (resolved?.account) {
      account = resolved.account;
      statusToken = resolved.token || { ...token, account };
    }
  }
  const gmailDetails = provider === "gmail" && tokenExists ? publicGmailTokenDetails(statusToken) : {};
  const gmailHasGrantedCapabilities = provider !== "gmail" || !tokenExists || (Array.isArray(gmailDetails.capabilities) && gmailDetails.capabilities.length > 0);
  const gmailFailure = provider === "gmail" && clean(error.message)
    ? { ...classifyGmailConnectorError(error, { errorContext: error.errorContext }), ...error }
    : null;
  const gmailFailureState = clean(gmailFailure?.state);
  const connectionHealthState = provider === "gmail" ? clean(statusToken.connection?.healthState) : "";
  const gmailFailureBlocksToken = gmailFailureState === "reauth_required" ||
    gmailFailureState === "degraded" ||
    (gmailFailureState === "broken" && clean(error.errorContext) !== "oauth_exchange");
  const state = tokenExists && ["reauth_required", "degraded", "broken"].includes(connectionHealthState)
    ? connectionHealthState
    : tokenExists && gmailFailureBlocksToken
    ? gmailFailureState
      : tokenExists
        ? gmailHasGrantedCapabilities ? "connected" : "partial"
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
    connected: state === "connected",
    pending: state === "pending" || state === "authorization_url_ready",
    account,
    ...(provider === "gmail" ? {
      connectionId: clean(statusToken.connectionId),
      selectionSource: clean(statusToken.selectionSource),
      connections: (await listGoogleWorkspaceConnections(env, options).catch(() => ({ connections: [] }))).connections,
    } : {}),
    shop: clean(oauthState.shop),
    parentConnector,
    userConnectionRequired: true,
    ...(provider === "gmail" && tokenExists ? gmailDetails : {}),
    error: clean(error.message),
    reason: clean(error.code || statusToken.connection?.lastErrorCode),
    retryable: error.retryable === true || connectionHealthState === "degraded",
    nextAction: clean(error.nextAction) || (connectionHealthState === "reauth_required" ? "reconnect" : connectionHealthState === "degraded" ? "retry" : ""),
    updatedAt: clean(error.updatedAt),
    message: state === "reauth_required"
      ? `${definition?.label || provider} access is no longer accepted by the provider. Reconnect this user's account.`
      : state === "degraded"
        ? `${definition?.label || provider} is temporarily unavailable. The stored connection has not been discarded.`
        : tokenExists
          ? gmailHasGrantedCapabilities
            ? `${definition?.label || provider} is connected for this user.`
            : `${definition?.label || provider} token is present, but no Google Workspace capabilities were granted. Reconnect and select the required access.`
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
    const oauth = await startGmailOAuth(env, {
      principal,
      account,
      thread: options.thread,
      capabilities: args.capabilities || args.requestedCapabilities || undefined,
      oauthAppId: args.oauthAppId || args.oauth_app,
      googleConnectionId: args.accountId || args.connectionId,
      alias: args.alias,
      useMode: args.useMode,
      setAsMain: args.setAsMain === true,
      setAsThreadDefault: args.setAsThreadDefault === true,
      threadId: clean(options.thread?.id || args.threadId),
    });
    return {
      ok: true,
      provider,
      state: "authorization_url_ready",
      account: oauth.account || account,
      authorizeUrl: oauth.authorizeUrl,
      redirectUri: oauth.redirectUri,
      oauthAppId: oauth.oauthAppId,
      capabilities: oauth.capabilities || [],
      scopes: oauth.scopes || [],
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
  if (provider === "gmail") {
    const selected = await resolveGoogleWorkspaceConnection({
      connectionId: args.accountId || args.connectionId,
      account: args.account,
      threadId: args.threadId,
    }, env, { principal, threadId: args.threadId });
    const removed = await removeGoogleWorkspaceConnection(selected.connection.connectionId, env, { principal });
    await unlinkIfExists(errorFile(provider, scope));
    await unlinkIfExists(oauthStateFile(provider, scope));
    await appendEvent({
      type: "gmail_oauth_disconnected",
      provider,
      userId: scope.userId || undefined,
      accountId: selected.connection.connectionId,
    }, env).catch(() => {});
    return {
      ok: true,
      provider,
      state: "disconnected",
      accountId: selected.connection.connectionId,
      connection: removed.connection,
      status: await connectorAuthStatus(provider, env, { principal }),
    };
  }
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
