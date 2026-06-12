import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";

const APPROVE_REPLIES = ["/approve", "approve", "approved", "yes", "y", "allow", "go", "proceed"];
const DENY_REPLIES = ["/deny", "deny", "no", "n", "reject", "stop", "cancel"];

function clean(value) {
  return String(value || "").trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function firstValue(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function commandFlagValue(command, flag) {
  const tokens = clean(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const index = tokens.indexOf(flag);
  if (index < 0) return "";
  return clean(tokens[index + 1] || "").replace(/^["']|["']$/g, "");
}

function commandBypassesApprovals(command) {
  return clean(command).includes("--dangerously-bypass-approvals-and-sandbox");
}

function legacyProfile(env = process.env) {
  return firstValue(env.ORKESTR_INSTALL_PROFILE, env.ORKESTR_SETUP_PROFILE, env.ORKESTR_PROFILE);
}

function profileBypassesApprovals(profile = "") {
  return ["local-trusted", "vps-trusted", "trusted"].includes(clean(profile).toLowerCase());
}

function defaultCodexSettings(env = process.env) {
  const command = clean(env.ORKESTR_RUNTIME_CODEX_COMMAND);
  const legacyYolo = commandBypassesApprovals(command) || profileBypassesApprovals(legacyProfile(env));
  const sandbox = firstValue(env.ORKESTR_CODEX_SANDBOX, commandFlagValue(command, "--sandbox")) || (legacyYolo ? "danger-full-access" : "workspace-write");
  const approvalPolicy = firstValue(env.ORKESTR_CODEX_APPROVAL_POLICY, commandFlagValue(command, "--ask-for-approval")) || (legacyYolo ? "never" : "on-request");
  const yolo = legacyYolo || (sandbox === "danger-full-access" && approvalPolicy === "never");
  return {
    command,
    sandbox,
    approvalPolicy,
    bypassApprovalsAndSandbox: yolo,
    permissionPrompts: {
      mirrorToWhatsApp: !yolo,
      approveReplies: APPROVE_REPLIES,
      denyReplies: DENY_REPLIES,
      alwaysApprove: {
        enabled: false,
        requiresExplicitScope: true,
        allowedScopes: ["this-thread", "session"],
      },
    },
  };
}

function defaultDesktopSettings(env = process.env) {
  const launchDisabled = truthy(env.ORKESTR_BROWSER_LAUNCH_DISABLED);
  const provisioned = clean(env.ORKESTR_INSTANCE_DESKTOPS_PROVISIONED).toLowerCase();
  const explicitlyNotProvisioned = ["0", "false", "no", "off", "disabled"].includes(provisioned);
  const mode = firstValue(env.ORKESTR_BROWSER_DESKTOP_MODE) || (launchDisabled ? "disabled" : "profiles");
  const defaultSlug = firstValue(env.ORKESTR_DEFAULT_DESKTOP_SLUG, env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG) || "desktop";
  const gmailSlug = firstValue(env.ORKESTR_GMAIL_AUTH_DESKTOP_SLUG, env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG) || "gmail";
  return {
    enabled: mode !== "disabled" && !explicitlyNotProvisioned,
    provisioned: !explicitlyNotProvisioned,
    mode,
    default: defaultSlug,
    gmailAuth: gmailSlug,
    manualIntervention: firstValue(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG, defaultSlug) || "desktop",
  };
}

function defaultConnectorSettings(env = process.env) {
  const gmailAuthDesktop = firstValue(env.ORKESTR_GMAIL_AUTH_DESKTOP_SLUG, env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG) || "gmail";
  return {
    whatsapp: {
      enabled: true,
      bridgeMode: firstValue(env.WHATSAPP_BRIDGE_MODE) || "local",
      accessMode: firstValue(env.ORKESTR_WHATSAPP_ACCESS_MODE) || "relay",
      senderRole: firstValue(env.ORKESTR_WHATSAPP_SENDER_ROLE, env.WHATSAPP_SENDER_ROLE) || "sender",
      responderRole: firstValue(env.ORKESTR_WHATSAPP_RESPONDER_ROLE, env.WHATSAPP_RESPONDER_ROLE) || "responder",
    },
    gmail: {
      enabled: truthy(env.ORKESTR_GMAIL_ENABLED) || Boolean(firstValue(env.GMAIL_OAUTH_CLIENT_ID)),
      authDesktop: gmailAuthDesktop,
      needsAuthAction: "gmail.oauth.start",
    },
    outlook: {
      enabled: truthy(env.ORKESTR_OUTLOOK_ENABLED) || Boolean(firstValue(env.OUTLOOK_OAUTH_CLIENT_ID, env.MICROSOFT_OAUTH_CLIENT_ID)),
      needsAuthAction: "outlook.device.start",
    },
  };
}

function defaultInterventionSettings(env = process.env) {
  const manualDesktop = firstValue(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG, env.ORKESTR_DEFAULT_DESKTOP_SLUG) || "desktop";
  return {
    manualDesktop,
    states: {
      codex: {
        awaitingApproval: "Reply approve or deny in WhatsApp, or use the Orkestr UI approval control.",
      },
      gmail: {
        needsAuth: "Open the configured Gmail auth desktop and reconnect Gmail OAuth.",
      },
      outlook: {
        needsDeviceCode: "Start Outlook device sign-in and approve the Microsoft device code.",
      },
      desktop: {
        needsManualIntervention: `Use the ${manualDesktop} managed desktop for manual browser steps.`,
      },
    },
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      next[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

export function defaultRuntimeSettings(env = process.env) {
  return {
    schemaVersion: 1,
    generatedBy: "orkestr",
    codex: defaultCodexSettings(env),
    desktops: defaultDesktopSettings(env),
    connectors: defaultConnectorSettings(env),
    intervention: defaultInterventionSettings(env),
  };
}

export async function runtimeSettingsPath(env = process.env) {
  const paths = await ensureDataDirs(env);
  return paths.runtimeSettings;
}

export async function readRuntimeSettings(env = process.env) {
  const paths = await ensureDataDirs(env);
  const stored = await readJson(paths.runtimeSettings, {});
  return deepMerge(defaultRuntimeSettings(env), stored);
}

export async function writeRuntimeSettings(patch = {}, env = process.env) {
  const paths = await ensureDataDirs(env);
  const current = await readRuntimeSettings(env);
  const next = deepMerge(current, {
    ...patch,
    schemaVersion: 1,
    generatedBy: "orkestr",
    updatedAt: new Date().toISOString(),
  });
  await writeJson(paths.runtimeSettings, next);
  return next;
}

export function classifyApprovalReply(text = "") {
  const normalized = clean(text).toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return { action: null, scopedAlways: false };
  if (/^\/?approve always (this-thread|session)\b/.test(normalized)) return { action: "approve", scopedAlways: true };
  if (/^\/?deny always (this-thread|session)\b/.test(normalized)) return { action: "deny", scopedAlways: true };
  if (/^always\s+(approve|allow|yes)\b/.test(normalized) || /^(approve|allow|yes)\s+always\b/.test(normalized)) {
    return { action: null, scopedAlways: false, error: "always_approval_requires_scope" };
  }
  if (APPROVE_REPLIES.includes(normalized)) return { action: "approve", scopedAlways: false };
  if (DENY_REPLIES.includes(normalized)) return { action: "deny", scopedAlways: false };
  return { action: null, scopedAlways: false };
}
