import { readConnectorConfig } from "../../storage/src/config.js";

function clean(value) {
  return String(value || "").trim();
}

function isTenantScopedRuntime(env = process.env) {
  return Boolean(
    clean(env.ORKESTR_TENANT_VM_ID) ||
      clean(env.ORKESTR_TENANT_SLICE_ID) ||
      clean(env.ORKESTR_TENANT_BOUNDARY) === "tenant-vm",
  );
}

function firstEnv(env = process.env, keys = []) {
  for (const key of keys) {
    const value = clean(env[key]);
    if (value) return value;
  }
  return "";
}

function connectorConfigError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeGoogleOAuthAppId(value = "") {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function googleOAuthAppsConfig(config = {}, env = process.env) {
  const raw = clean(
    env.ORKESTR_GOOGLE_OAUTH_APPS_JSON ||
      env.GOOGLE_OAUTH_APPS_JSON ||
      (typeof config.oauthApps === "string" ? config.oauthApps : ""),
  );
  if (!raw && config.oauthApps && typeof config.oauthApps === "object" && !Array.isArray(config.oauthApps)) {
    return config.oauthApps;
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw connectorConfigError("google_oauth_apps_config_invalid", 500);
  }
}

export function googleOAuthDefaultAppId(config = {}, env = process.env) {
  return normalizeGoogleOAuthAppId(
    env.ORKESTR_GOOGLE_OAUTH_DEFAULT_APP ||
      env.GOOGLE_OAUTH_DEFAULT_APP ||
      config.defaultOAuthApp ||
      config.oauthAppId ||
      "default",
  ) || "default";
}

export function resolveGoogleOAuthAppConfig(requestedAppId = "", config = {}, env = process.env) {
  const defaultAppId = googleOAuthDefaultAppId(config, env);
  const requested = normalizeGoogleOAuthAppId(requestedAppId);
  const oauthAppId = requested || defaultAppId;
  const profiles = googleOAuthAppsConfig(config, env);
  const profileEntry = Object.entries(profiles).find(([id]) => normalizeGoogleOAuthAppId(id) === oauthAppId);
  const profile = profileEntry?.[1] && typeof profileEntry[1] === "object" && !Array.isArray(profileEntry[1])
    ? profileEntry[1]
    : null;
  if (requested && oauthAppId !== defaultAppId && !profile) {
    throw connectorConfigError("google_oauth_app_not_found", 404);
  }
  const isDefault = oauthAppId === defaultAppId;
  const base = isDefault ? { ...config } : { redirectUri: clean(config.redirectUri) };
  const resolved = profile ? { ...base, ...profile } : base;
  return {
    ...resolved,
    clientId: clean(resolved.clientId || resolved.client_id),
    clientSecret: clean(resolved.clientSecret || resolved.client_secret),
    redirectUri: clean(resolved.redirectUri || resolved.redirect_uri || config.redirectUri),
    approvedTesters: resolved.approvedTesters || resolved.approved_testers || "",
    allowedCapabilities: resolved.allowedCapabilities || resolved.allowed_capabilities || "",
    oauthAppId,
    defaultOAuthAppId: defaultAppId,
    isDefaultOAuthApp: isDefault,
    explicitSelection: Boolean(requested),
  };
}

export async function readGoogleOAuthAppConfig(requestedAppId = "", env = process.env) {
  const config = await readParentConnectorRuntimeConfig("gmail", env);
  return resolveGoogleOAuthAppConfig(requestedAppId, config, env);
}

const providerDefinitions = {
  whatsapp: {
    provider: "whatsapp",
    label: "WhatsApp",
    authMode: "parent_bridge",
    userSurface: "chat",
    setupSurface: "parent",
    userBindingKind: "chat_binding",
    tokenFile: "",
    parentConfigKeys: [],
    envMappings: {
      bridgeUrl: ["WHATSAPP_BRIDGE_URL"],
      bridgeMode: ["WHATSAPP_BRIDGE_MODE"],
      apiToken: ["WHATSAPP_BRIDGE_TOKEN", "WA_HTTP_TOKEN"],
    },
    summary: "Parent Orkestr owns the WhatsApp bridge; users are bound to chats.",
  },
  gmail: {
    provider: "gmail",
    label: "Gmail",
    authMode: "oauth_authorization_code",
    userSurface: "chat",
    setupSurface: "parent",
    userBindingKind: "user_oauth_token",
    tokenFile: "gmail-token.json",
    parentConfigKeys: ["clientId", "clientSecret", "redirectUri"],
    startConfigKeys: ["clientId", "redirectUri"],
    envMappings: {
      clientId: ["GMAIL_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID"],
      clientSecret: ["GMAIL_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET"],
      redirectUri: ["GMAIL_OAUTH_REDIRECT_URI", "GOOGLE_OAUTH_REDIRECT_URI"],
      account: ["GMAIL_OAUTH_ACCOUNT", "GOOGLE_OAUTH_ACCOUNT"],
      approvedTesters: [
        "GMAIL_OAUTH_APPROVED_TESTERS",
        "GOOGLE_OAUTH_APPROVED_TESTERS",
        "GMAIL_OAUTH_ALLOWED_ACCOUNTS",
        "GOOGLE_OAUTH_ALLOWED_ACCOUNTS",
      ],
    },
    defaultRedirectPath: "/oauth/gmail/callback",
    summary: "Parent Orkestr owns the Google OAuth app; each user stores only their own Gmail token.",
  },
  outlook: {
    provider: "outlook",
    label: "Outlook",
    authMode: "oauth_device_code",
    userSurface: "chat",
    setupSurface: "parent",
    userBindingKind: "user_oauth_token",
    tokenFile: "outlook-token.json",
    parentConfigKeys: ["clientId"],
    envMappings: {
      clientId: ["OUTLOOK_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_ID"],
      tenantId: ["OUTLOOK_OAUTH_TENANT_ID", "MICROSOFT_OAUTH_TENANT_ID"],
      scopes: ["OUTLOOK_OAUTH_SCOPES", "MICROSOFT_OAUTH_SCOPES"],
      account: ["OUTLOOK_OAUTH_ACCOUNT", "MICROSOFT_OAUTH_ACCOUNT"],
    },
    defaults: {
      tenantId: "common",
    },
    summary: "Parent Orkestr owns the Microsoft app registration; each user stores only their own Outlook token.",
  },
  jira: {
    provider: "jira",
    label: "Jira",
    authMode: "oauth_authorization_code",
    userSurface: "chat",
    setupSurface: "parent",
    userBindingKind: "user_oauth_token",
    tokenFile: "jira-token.json",
    parentConfigKeys: ["clientId", "clientSecret", "redirectUri"],
    startConfigKeys: ["clientId", "redirectUri"],
    envMappings: {
      clientId: ["JIRA_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_CLIENT_ID"],
      clientSecret: ["JIRA_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_CLIENT_SECRET"],
      redirectUri: ["JIRA_OAUTH_REDIRECT_URI", "ATLASSIAN_OAUTH_REDIRECT_URI"],
      scopes: ["JIRA_OAUTH_SCOPES", "ATLASSIAN_OAUTH_SCOPES"],
      authorizeUrl: ["JIRA_OAUTH_AUTHORIZE_URL", "ATLASSIAN_OAUTH_AUTHORIZE_URL"],
      tokenUrl: ["JIRA_OAUTH_TOKEN_URL", "ATLASSIAN_OAUTH_TOKEN_URL"],
      audience: ["JIRA_OAUTH_AUDIENCE", "ATLASSIAN_OAUTH_AUDIENCE"],
    },
    defaultRedirectPath: "/oauth/jira/callback",
    summary: "Parent Orkestr owns the Atlassian OAuth app; users connect their own Jira account from chat.",
  },
  shopify: {
    provider: "shopify",
    label: "Shopify",
    authMode: "oauth_authorization_code",
    userSurface: "chat",
    setupSurface: "parent",
    userBindingKind: "user_oauth_token",
    tokenFile: "shopify-token.json",
    parentConfigKeys: ["clientId", "clientSecret", "redirectUri"],
    startConfigKeys: ["clientId", "redirectUri"],
    envMappings: {
      clientId: ["SHOPIFY_OAUTH_CLIENT_ID", "SHOPIFY_CLIENT_ID", "SHOPIFY_API_KEY"],
      clientSecret: ["SHOPIFY_OAUTH_CLIENT_SECRET", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_API_SECRET"],
      redirectUri: ["SHOPIFY_OAUTH_REDIRECT_URI", "SHOPIFY_REDIRECT_URI"],
      scopes: ["SHOPIFY_OAUTH_SCOPES", "SHOPIFY_SCOPES"],
      shop: ["SHOPIFY_SHOP", "SHOPIFY_STORE", "SHOPIFY_STORE_DOMAIN"],
    },
    defaultRedirectPath: "/oauth/shopify/callback",
    summary: "Parent Orkestr owns the Shopify connector app; users connect their own Shopify account from chat.",
  },
};

export const parentConnectorProviderOrder = ["whatsapp", "gmail", "outlook", "jira", "shopify"];

export function parentConnectorProviderDefinitions() {
  return parentConnectorProviderOrder.map((id) => ({ ...providerDefinitions[id] }));
}

export function parentConnectorProvider(id) {
  const normalized = clean(id).toLowerCase();
  const definition = providerDefinitions[normalized];
  return definition ? { ...definition } : null;
}

function publicBaseUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_PUBLIC_URL || env.ORKESTR_BASE_URL).replace(/\/+$/, "");
}

function oauthPublicBaseUrl(providerId, env = process.env) {
  const normalized = clean(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return firstEnv(env, [
    `ORKESTR_${normalized}_OAUTH_PUBLIC_BASE_URL`,
    `${normalized}_OAUTH_PUBLIC_BASE_URL`,
    `ORKESTR_${normalized}_OAUTH_CALLBACK_BASE_URL`,
    `${normalized}_OAUTH_CALLBACK_BASE_URL`,
    "ORKESTR_OAUTH_PUBLIC_BASE_URL",
    "ORKESTR_OAUTH_CALLBACK_BASE_URL",
    "ORKESTR_CONNECT_PUBLIC_URL",
    "ORKESTR_CONNECT_BASE_URL",
  ]).replace(/\/+$/, "");
}

function fullRedirectEnvValue(definition, env = process.env) {
  return firstEnv(env, definition.envMappings?.redirectUri || []);
}

export function parentConnectorRuntimeConfig(providerId, config = {}, env = process.env) {
  const definition = parentConnectorProvider(providerId);
  if (!definition) return { ...(config || {}) };
  const runtimeConfig = { ...(config || {}) };
  for (const [key, envKeys] of Object.entries(definition.envMappings || {})) {
    if (key === "redirectUri") continue;
    runtimeConfig[key] = clean(runtimeConfig[key]) || firstEnv(env, envKeys);
  }
  for (const [key, value] of Object.entries(definition.defaults || {})) {
    runtimeConfig[key] = clean(runtimeConfig[key]) || value;
  }
  if (definition.defaultRedirectPath) {
    const explicitRedirectUri = fullRedirectEnvValue(definition, env);
    const brokerBaseUrl = oauthPublicBaseUrl(definition.provider, env);
    const fallbackBaseUrl = publicBaseUrl(env);
    runtimeConfig.redirectUri = explicitRedirectUri ||
      (brokerBaseUrl ? `${brokerBaseUrl}${definition.defaultRedirectPath}` : "") ||
      clean(config.redirectUri) ||
      (fallbackBaseUrl ? `${fallbackBaseUrl}${definition.defaultRedirectPath}` : "");
  } else {
    runtimeConfig.redirectUri = clean(runtimeConfig.redirectUri) || fullRedirectEnvValue(definition, env);
  }
  return runtimeConfig;
}

export async function readParentConnectorRuntimeConfig(providerId, env = process.env) {
  const config = await readConnectorConfig(providerId, env);
  return parentConnectorRuntimeConfig(providerId, config, env);
}

function missingConfigKeys(definition, runtimeConfig, keys = definition.parentConfigKeys || []) {
  return keys.filter((key) => !clean(runtimeConfig[key]));
}

function parentConfigState(definition, runtimeConfig) {
  const requiredMissing = missingConfigKeys(definition, runtimeConfig);
  if (!requiredMissing.length) return "ready";
  const startKeys = definition.startConfigKeys || definition.parentConfigKeys || [];
  if (startKeys.length && !missingConfigKeys(definition, runtimeConfig, startKeys).length) return "partial";
  return "missing";
}

function whatsappParentConfigState(runtimeConfig, runtimeStatus = null) {
  const mode = clean(runtimeStatus?.mode || runtimeConfig.bridgeMode || "local").toLowerCase();
  if (mode !== "external") return "ready";
  return clean(runtimeStatus?.bridgeUrl || runtimeConfig.bridgeUrl) ? "ready" : "missing";
}

export function parentConnectorAppStatus({ provider, config = {}, env = process.env, runtimeStatus = null } = {}) {
  const definition = parentConnectorProvider(provider);
  if (!definition) return null;
  const instanceScoped = isTenantScopedRuntime(env) && Boolean(definition.tokenFile);
  const baseRuntimeConfig = parentConnectorRuntimeConfig(definition.provider, config, env);
  const runtimeConfig = definition.provider === "gmail"
    ? resolveGoogleOAuthAppConfig("", baseRuntimeConfig, env)
    : baseRuntimeConfig;
  const configState = definition.provider === "whatsapp"
    ? whatsappParentConfigState(runtimeConfig, runtimeStatus)
    : parentConfigState(definition, runtimeConfig);
  const missingKeys = definition.provider === "whatsapp"
    ? []
    : missingConfigKeys(definition, runtimeConfig);
  return {
    provider: definition.provider,
    label: definition.label,
    parentManaged: true,
    setupSurface: definition.setupSurface,
    userSurface: definition.userSurface,
    authMode: definition.authMode,
    userBindingKind: instanceScoped ? "instance_oauth_token" : definition.userBindingKind,
    userTokenFile: definition.tokenFile,
    parentConfigState: configState,
    parentAppConfigured: configState === "ready",
    parentAppPartiallyConfigured: configState === "partial",
    userConnectionRequired: Boolean(definition.tokenFile),
    missingParentConfigKeys: missingKeys,
    summary: instanceScoped
      ? `Parent Orkestr owns the ${definition.label} connector app; this instance stores one shared ${definition.label} token.`
      : definition.summary,
  };
}
