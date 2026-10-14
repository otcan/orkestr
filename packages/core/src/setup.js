import { connectorOrder, getConnectorStatuses } from "../../connectors/src/connectors.js";
import { dataPaths } from "../../storage/src/paths.js";
import { publicAuthStatus } from "./auth-config.js";
import { readOverlay } from "./overlay.js";
import { publicUrlConfig } from "./public-url-config.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { securityStatus } from "./security.js";
import { whatsappOnboardingStatus } from "../../connectors/src/whatsapp-onboarding.js";
import { claudeCodeEnabled } from "./claude-code-client.js";
import { listLlmAccountProfiles } from "./llm-account-profiles.js";

export { connectorOrder };

function onboardingAutoOpenEnabled(env = process.env) {
  return !["0", "false", "no", "off", "disabled"].includes(String(env.ORKESTR_ONBOARDING_AUTO_OPEN || "").trim().toLowerCase());
}

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

export async function getSetupStatus({ env = process.env, home, principal = null, validateConnectors = false } = {}) {
  const paths = dataPaths(env);
  const connectors = await getConnectorStatuses({ env, home, principal, validateGmail: validateConnectors === true });
  const overlay = await readOverlay(env);
  const security = await securityStatus(env);
  const auth = publicAuthStatus(env);
  const urls = publicUrlConfig(env);
  const settings = await readRuntimeSettings(env);
  const whatsappOnboarding = await whatsappOnboardingStatus({ env, settings, connectors });
  const agentRuntime = await agentRuntimeStatus(connectors, env);
  return {
    generatedAt: new Date().toISOString(),
    home: paths.home,
    setupState: setupState(connectors),
    onboarding: {
      autoOpen: onboardingAutoOpenEnabled(env),
    },
    install: installStatus(env),
    agentRuntime,
    settings,
    whatsappOnboarding,
    overlay,
    security,
    auth,
    urls,
    connectors,
  };
}

// Orkestr only opens with a coding agent: Codex signed in, or a ready Claude
// Code account. Exposed as a plain flag (also to non-admins) so the UI can
// gate entry without seeing connector details.
async function agentRuntimeStatus(connectors = [], env = process.env) {
  const codex = connectors.find((connector) => connector.id === "codex")?.state === "connected";
  let claude = false;
  if (!codex && claudeCodeEnabled(env)) {
    const owner = String(env.ORKESTR_ADMIN_USER_ID || "admin").trim() || "admin";
    claude = await listLlmAccountProfiles(owner, { provider: "claude-code" }, env)
      .then((profiles) => profiles.some((profile) => profile.state === "ready"))
      .catch(() => false);
  }
  return { ready: Boolean(codex || claude), codex, claude };
}

// Lets the setup UI show commands in the form this install needs (for
// example `docker exec` in front of the CLI). Not sensitive.
function installStatus(env = process.env) {
  return { docker: String(env.ORKESTR_DOCKER || "").trim() === "1" };
}

export function publicSetupStatus(status = {}) {
  return {
    generatedAt: status.generatedAt || new Date().toISOString(),
    home: "",
    setupState: String(status.setupState || "incomplete"),
    onboarding: {
      autoOpen: status.onboarding?.autoOpen !== false,
    },
    install: { docker: status.install?.docker === true },
    agentRuntime: { ready: status.agentRuntime?.ready === true },
    overlay: publicOverlayStatus(status.overlay),
    security: publicSetupSecurityStatus(status.security),
    auth: publicSetupAuthStatus(status.auth),
    urls: publicSetupUrlStatus(status.urls),
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
    approval: {
      sshCommand: String(security?.approval?.sshCommand || ""),
      approveCommand: String(security?.approval?.approveCommand || ""),
      sudoApproveCommand: String(security?.approval?.sudoApproveCommand || ""),
    },
    mtls: {
      enabled: Boolean(security?.mtls?.enabled),
      configured: Boolean(security?.mtls?.configured),
      mode: String(security?.mtls?.mode || ""),
      caConfigured: Boolean(security?.mtls?.caConfigured),
    },
  };
}

function publicSetupUrlStatus(urls = {}) {
  return {
    primaryDomain: String(urls?.primaryDomain || ""),
    appUrl: String(urls?.appUrl || ""),
    authUrl: String(urls?.authUrl || ""),
    connectUrl: String(urls?.connectUrl || ""),
    launcherUrl: String(urls?.launcherUrl || ""),
    sameOriginAuth: Boolean(urls?.sameOriginAuth),
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
