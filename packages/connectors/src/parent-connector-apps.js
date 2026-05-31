import { readConnectorConfig } from "../../storage/src/config.js";

function clean(value) {
  return String(value || "").trim();
}

function firstEnv(env = process.env, keys = []) {
  for (const key of keys) {
    const value = clean(env[key]);
    if (value) return value;
  }
  return "";
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
    },
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
    },
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

export function parentConnectorRuntimeConfig(providerId, config = {}, env = process.env) {
  const definition = parentConnectorProvider(providerId);
  if (!definition) return { ...(config || {}) };
  const runtimeConfig = { ...(config || {}) };
  for (const [key, envKeys] of Object.entries(definition.envMappings || {})) {
    runtimeConfig[key] = clean(runtimeConfig[key]) || firstEnv(env, envKeys);
  }
  for (const [key, value] of Object.entries(definition.defaults || {})) {
    runtimeConfig[key] = clean(runtimeConfig[key]) || value;
  }
  if (!clean(runtimeConfig.redirectUri) && definition.defaultRedirectPath) {
    const baseUrl = publicBaseUrl(env);
    if (baseUrl) runtimeConfig.redirectUri = `${baseUrl}${definition.defaultRedirectPath}`;
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
  const runtimeConfig = parentConnectorRuntimeConfig(definition.provider, config, env);
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
    userBindingKind: definition.userBindingKind,
    userTokenFile: definition.tokenFile,
    parentConfigState: configState,
    parentAppConfigured: configState === "ready",
    parentAppPartiallyConfigured: configState === "partial",
    userConnectionRequired: Boolean(definition.tokenFile),
    missingParentConfigKeys: missingKeys,
    summary: definition.summary,
  };
}
