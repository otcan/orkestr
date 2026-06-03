import { publicUrlConfig } from "./public-url-config.js";

function envValue(env, names = []) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function envBool(env, name, fallback = false) {
  const value = String(env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function redactUser(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const [local, domain] = text.split("@");
  if (!domain) return text.length <= 3 ? "***" : `${text.slice(0, 2)}***`;
  return `${local.slice(0, 2) || "**"}***@${domain}`;
}

function issuerFromConfig(env = process.env) {
  const explicit = envValue(env, ["ORKESTR_KEYCLOAK_ISSUER", "KEYCLOAK_ISSUER"]);
  if (explicit) return explicit.replace(/\/+$/, "");
  const baseUrl = envValue(env, ["ORKESTR_KEYCLOAK_URL", "KEYCLOAK_URL"]).replace(/\/+$/, "");
  const realm = envValue(env, ["ORKESTR_KEYCLOAK_REALM", "KEYCLOAK_REALM"]);
  if (baseUrl && realm) return `${baseUrl}/realms/${encodeURIComponent(realm)}`;
  return "";
}

function realmFromIssuer(issuer = "") {
  const match = String(issuer || "").match(/\/realms\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function authProvider(env = process.env) {
  const configured = envValue(env, ["ORKESTR_AUTH_PROVIDER", "AUTH_PROVIDER"]).toLowerCase();
  if (configured) return configured;
  return issuerFromConfig(env) ? "keycloak" : "browser_pairing";
}

export function publicAuthStatus(env = process.env) {
  const provider = authProvider(env);
  const urls = publicUrlConfig(env);
  const issuer = issuerFromConfig(env);
  const realm = envValue(env, ["ORKESTR_KEYCLOAK_REALM", "KEYCLOAK_REALM"]) || realmFromIssuer(issuer);
  const clientId = envValue(env, ["ORKESTR_KEYCLOAK_CLIENT_ID", "KEYCLOAK_CLIENT_ID"]);
  const accountUrl = issuer ? `${issuer}/account` : "";
  const adminUrl = envValue(env, ["ORKESTR_KEYCLOAK_ADMIN_URL", "KEYCLOAK_ADMIN_URL"]);
  const outlookUser = envValue(env, ["ORKESTR_OUTLOOK_SMTP_USER", "OUTLOOK_SMTP_USER"]);
  const outlookFrom = envValue(env, ["ORKESTR_OUTLOOK_SMTP_FROM", "OUTLOOK_SMTP_FROM", "ORKESTR_MAIL_FROM"]);
  const outlookHost = envValue(env, ["ORKESTR_OUTLOOK_SMTP_HOST", "OUTLOOK_SMTP_HOST"]) || "smtp.office365.com";
  const mailProvider = envValue(env, ["ORKESTR_MAIL_PROVIDER", "ORKESTR_EMAIL_PROVIDER"]).toLowerCase();
  const graphFrom = envValue(env, ["ORKESTR_GRAPH_MAIL_FROM", "ORKESTR_OUTLOOK_GRAPH_FROM", "OUTLOOK_GRAPH_FROM", "ORKESTR_MAIL_FROM"]);
  const graphSender = envValue(env, ["ORKESTR_GRAPH_MAIL_SENDER", "ORKESTR_OUTLOOK_GRAPH_SENDER", "OUTLOOK_GRAPH_SENDER"]);
  const graphConfigured = Boolean(
    envValue(env, [
      "ORKESTR_GRAPH_MAIL_ACCESS_TOKEN",
      "ORKESTR_OUTLOOK_GRAPH_ACCESS_TOKEN",
      "OUTLOOK_GRAPH_ACCESS_TOKEN",
      "ORKESTR_GRAPH_MAIL_TOKEN_COMMAND_JSON",
      "ORKESTR_OUTLOOK_GRAPH_TOKEN_COMMAND_JSON",
      "OUTLOOK_GRAPH_TOKEN_COMMAND_JSON",
    ]),
  );
  const passwordless = envBool(env, "ORKESTR_AUTH_PASSWORDLESS", true);
  const requireEmailFactor = envBool(env, "ORKESTR_AUTH_REQUIRE_EMAIL_FACTOR", true);
  const requirePhoneFactor = envBool(env, "ORKESTR_AUTH_REQUIRE_PHONE_FACTOR", true);
  const keycloakConfigured = provider === "keycloak" && Boolean(issuer && clientId);
  const outlookConfigured = Boolean(outlookUser || outlookFrom);
  const effectiveMailProvider = mailProvider || (graphConfigured ? "graph" : "outlook");

  return {
    provider,
    configured: provider === "keycloak" ? keycloakConfigured : true,
    summary: provider === "keycloak"
      ? keycloakConfigured
        ? "Keycloak is configured as the external identity provider."
        : "Set Keycloak issuer and client id to enable external login."
      : "Browser pairing protects this local install until Keycloak is configured.",
    login: {
      passwordless,
      emailRequired: true,
      emailUnique: true,
      phoneRequired: true,
      phoneUnique: false,
      requiredFactors: [
        ...(requireEmailFactor ? ["email"] : []),
        ...(requirePhoneFactor ? ["phone"] : []),
      ],
    },
    keycloak: {
      issuer,
      realm,
      clientId,
      accountUrl,
      adminUrl,
      requiredActions: ["verify email", "verify phone"],
    },
    mail: {
      provider: effectiveMailProvider === "graph" ? "graph" : "outlook",
      configured: effectiveMailProvider === "graph" ? Boolean(graphConfigured && graphFrom) : outlookConfigured,
      host: effectiveMailProvider === "graph" ? "graph.microsoft.com" : outlookHost,
      user: redactUser(effectiveMailProvider === "graph" ? graphSender : outlookUser),
      from: redactUser(effectiveMailProvider === "graph" ? graphFrom : outlookFrom),
      note: effectiveMailProvider === "graph"
        ? "Use Microsoft Graph Mail.Send for Orkestr outbound mail; token material stays in private runtime config."
        : "Use Outlook SMTP in Keycloak for verification email delivery; Orkestr does not store SMTP secrets in public config.",
    },
    storage: {
      genericIdentityLinks: false,
      perUserHome: true,
      note: "Connector identities belong under each user's Orkestr home directory, not in the generic user record.",
    },
    urls: {
      appUrl: urls.appUrl,
      authUrl: urls.authUrl,
      sameOriginAuth: urls.sameOriginAuth,
    },
  };
}
