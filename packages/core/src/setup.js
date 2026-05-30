import { connectorOrder, getConnectorStatuses } from "../../connectors/src/connectors.js";
import { dataPaths } from "../../storage/src/paths.js";
import { publicAuthStatus } from "./auth-config.js";
import { readOverlay } from "./overlay.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { securityStatus } from "./security.js";

export { connectorOrder };

function setupState(connectors) {
  const useful = connectors.filter((connector) => ["connected", "partial"].includes(connector.state));
  if (!useful.length) return "incomplete";
  const byId = Object.fromEntries(connectors.map((connector) => [connector.id, connector]));
  const mailReady =
    ["connected", "partial"].includes(byId.gmail?.state) ||
    ["connected", "partial"].includes(byId.outlook?.state);
  const ready =
    byId.openai?.state === "connected" &&
    byId.codex?.state === "connected" &&
    ["connected", "partial"].includes(byId.whatsapp?.state) &&
    mailReady &&
    ["connected", "partial"].includes(byId.linkedin?.state);
  return ready ? "ready" : "partial";
}

export async function getSetupStatus({ env = process.env, home, principal = null } = {}) {
  const paths = dataPaths(env);
  const connectors = await getConnectorStatuses({ env, home, principal });
  const overlay = await readOverlay(env);
  const security = await securityStatus(env);
  const auth = publicAuthStatus(env);
  const settings = await readRuntimeSettings(env);
  return {
    generatedAt: new Date().toISOString(),
    home: paths.home,
    setupState: setupState(connectors),
    settings,
    overlay,
    security,
    auth,
    connectors,
  };
}

export function publicSetupStatus(status = {}) {
  return {
    generatedAt: status.generatedAt || new Date().toISOString(),
    home: "",
    setupState: String(status.setupState || "incomplete"),
    overlay: publicOverlayStatus(status.overlay),
    security: publicSetupSecurityStatus(status.security),
    auth: publicSetupAuthStatus(status.auth),
    connectors: [],
    config: {},
    whatsappDefaults: {},
    redacted: true,
  };
}

function publicOverlayStatus(overlay = {}) {
  return {
    configured: Boolean(overlay?.configured),
    valid: overlay?.valid !== false,
  };
}

function publicSetupSecurityStatus(security = {}) {
  return {
    generatedAt: security?.generatedAt || null,
    authEnabled: Boolean(security?.authEnabled),
    authRequired: Boolean(security?.authRequired),
    paired: false,
    challengeActive: Boolean(security?.challengeActive),
    pendingChallengeCount: Number(security?.pendingChallengeCount || 0),
    remoteReady: Boolean(security?.remoteReady),
    https: {
      configured: Boolean(security?.https?.configured),
    },
    mtls: {
      enabled: Boolean(security?.mtls?.enabled),
      configured: Boolean(security?.mtls?.configured),
      mode: String(security?.mtls?.mode || ""),
      caConfigured: Boolean(security?.mtls?.caConfigured),
    },
  };
}

function publicSetupAuthStatus(auth = {}) {
  const login = auth?.login && typeof auth.login === "object" ? auth.login : {};
  return {
    provider: String(auth?.provider || "browser_pairing"),
    configured: Boolean(auth?.configured),
    login: {
      passwordless: Boolean(login.passwordless),
      emailRequired: Boolean(login.emailRequired),
      phoneRequired: Boolean(login.phoneRequired),
      requiredFactors: Array.isArray(login.requiredFactors) ? login.requiredFactors.map(String) : [],
    },
  };
}
