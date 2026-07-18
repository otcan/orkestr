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

function titleFromSlug(value = "") {
  const text = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Desktop";
}

function safeSlug(value = "") {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return /^[a-z0-9][a-z0-9_.-]*$/.test(slug) ? slug : "";
}

function safeHttpUrl(value = "", { allowAboutBlank = false, localOnly = false } = {}) {
  const text = clean(value);
  if (!text) return "";
  if (allowAboutBlank && text === "about:blank") return text;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password) return "";
  if (localOnly) {
    const host = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return "";
  }
  return parsed.toString();
}

function safeAbsolutePath(value = "") {
  const text = clean(value);
  if (!text || text.includes("\0") || !text.startsWith("/")) return "";
  return text.replace(/\/+$/g, "") || "/";
}

function jsonDesktopRows(value = "") {
  const text = clean(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.desktops)) return parsed.desktops;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.catalog)) return parsed.catalog;
    if (Array.isArray(parsed?.desks)) return parsed.desks;
    return [];
  } catch {
    return [];
  }
}

function normalizeDesktopCatalogRows(rows = []) {
  const output = [];
  const input = Array.isArray(rows) ? rows : String(rows || "").split(/[\s,]+/g);
  for (const item of input) {
    const source = typeof item === "string" ? { slug: item } : item && typeof item === "object" ? item : {};
    const slug = safeSlug(source.slug || source.id || source.name);
    if (!slug) continue;
    output.push({
      slug,
      id: slug,
      label: clean(source.label || source.title) || titleFromSlug(slug),
      type: clean(source.type || "desktop") || "desktop",
      connector: safeSlug(source.connector || source.service || (slug === "gmail" ? "gmail" : slug === "linkedin" ? "linkedin" : "desktop")) || "desktop",
      purpose: clean(source.purpose || source.notes || source.description).slice(0, 1000),
      startUrl: safeHttpUrl(source.startUrl || source.start_url || source.url, { allowAboutBlank: true }),
      url: safeHttpUrl(source.deskUrl || source.desk_url || source.publicUrl || source.public_url),
      cdpUrl: safeHttpUrl(source.cdpUrl || source.cdp_url || source.localCdpUrl || source.local_cdp_url, { localOnly: true }),
      workspacePath: safeAbsolutePath(source.workspacePath || source.workspace || source.runtimeWorkspace),
      enabled: source.enabled !== false,
    });
  }
  return output;
}

function visibleDesktopSlugs(env = process.env) {
  const raw = firstValue(env.ORKESTR_BROWSER_VISIBLE_SLUGS, env.ORKESTR_OPS_DESKTOP_SLUGS);
  if (!raw) return null;
  const slugs = raw
    .split(/[\s,]+/g)
    .map((slug) => safeSlug(slug))
    .filter(Boolean);
  return slugs.length ? new Set(slugs) : new Set();
}

export function desktopCatalogFromEnv(env = process.env, defaults = {}, options = {}) {
  const defaultSlug = defaults.defaultSlug || firstValue(env.ORKESTR_DEFAULT_DESKTOP_SLUG, env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG) || "desktop";
  const gmailSlug = defaults.gmailSlug || firstValue(env.ORKESTR_GMAIL_AUTH_DESKTOP_SLUG, env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG) || "gmail";
  const manualSlug = defaults.manualSlug || firstValue(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG, defaultSlug) || "desktop";
  const baseRows = [
    {
      slug: defaultSlug,
      label: "Desktop",
      connector: "desktop",
      purpose: "General-purpose managed browser desktop for agent-driven web tasks.",
      startUrl: "about:blank",
    },
    {
      slug: "linkedin",
      label: "LinkedIn",
      connector: "linkedin",
      purpose: "LinkedIn browser profile.",
      startUrl: "https://www.linkedin.com/",
    },
    {
      slug: gmailSlug,
      label: "Gmail",
      connector: "gmail",
      purpose: "Gmail browser profile for accounts that need browser access.",
      startUrl: "https://mail.google.com/",
    },
  ];
  if (manualSlug && manualSlug !== defaultSlug) {
    baseRows.push({
      slug: manualSlug,
      label: titleFromSlug(manualSlug),
      connector: "desktop",
      purpose: "Manual intervention managed browser desktop.",
      startUrl: "about:blank",
    });
  }
  const configuredRows = [
    ...jsonDesktopRows(env.ORKESTR_DESKTOP_CATALOG_JSON),
    ...jsonDesktopRows(env.ORKESTR_MANAGED_DESKTOPS_JSON),
    ...jsonDesktopRows(env.ORKESTR_DESKTOPS_JSON),
  ];
  const visible = options.includeHidden === true ? null : visibleDesktopSlugs(env);
  const visibleRows = visible ? [...visible].map((slug) => ({ slug, label: titleFromSlug(slug) })) : [];
  const merged = new Map();
  for (const row of normalizeDesktopCatalogRows([...baseRows, ...visibleRows, ...configuredRows])) {
    if (visible && !visible.has(row.slug)) continue;
    merged.set(row.slug, { ...(merged.get(row.slug) || {}), ...row });
  }
  return [...merged.values()];
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
  const manualSlug = firstValue(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG, defaultSlug) || "desktop";
  return {
    enabled: mode !== "disabled" && !explicitlyNotProvisioned,
    provisioned: !explicitlyNotProvisioned,
    mode,
    default: defaultSlug,
    gmailAuth: gmailSlug,
    manualIntervention: manualSlug,
    items: desktopCatalogFromEnv(env, { defaultSlug, gmailSlug, manualSlug }),
  };
}

function defaultConnectorSettings(env = process.env) {
  const gmailAuthDesktop = firstValue(env.ORKESTR_GMAIL_AUTH_DESKTOP_SLUG, env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG) || "gmail";
  return {
    mcp: {
      enabled: Boolean(firstValue(env.ORKESTR_CONNECTORS_MCP_URL, env.ORKESTR_CONNECTORS_MCP_TOKEN, env.ORKESTR_CONNECTORS_MCP_BEARER_TOKEN)),
      transport: "streamable-http",
      url: firstValue(env.ORKESTR_CONNECTORS_MCP_URL) || "http://127.0.0.1:18914/mcp",
      tools: ["orkestr_auth", "orkestr_messaging", "orkestr_conversation", "orkestr_routing", "orkestr_runtime"],
      authority: "bearer_scope",
    },
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
      googleWorkspaceConnectCommand: "orkestr connect google --json",
      whatsappConnectCommand: "/connect google",
    },
    googleWorkspace: {
      enabled: truthy(env.ORKESTR_GMAIL_ENABLED) || Boolean(firstValue(env.GMAIL_OAUTH_CLIENT_ID)) || Boolean(firstValue(env.ORKESTR_TENANT_VM_ID)),
      provider: "google_workspace",
      service: "gmail",
      authMode: "brokered_whatsapp_command",
      connectCommand: "orkestr connect google --json",
      chatCommand: "/connect google",
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
