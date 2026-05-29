import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConnectorConfig } from "../../storage/src/config.js";
import { dataPaths } from "../../storage/src/paths.js";
import { activeCodexRuntimeAuthInvalid } from "../../core/src/codex-auth-health.js";
import { readOverlay } from "../../core/src/overlay.js";
import { CODEX_DISABLED_ON_MACOS, codexAppServerProbe, codexLoginStatus, defaultCodexHome } from "./codex.js";
import { getWhatsAppStatus } from "./whatsapp.js";

const execFileAsync = promisify(execFile);

export const connectorOrder = ["openai", "codex", "gmail", "outlook", "linkedin", "whatsapp", "browsers", "timers"];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function commandVersion(command, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 2500 });
    return String(stdout || stderr || "").trim();
  } catch {
    return "";
  }
}

async function firstCommandVersion(commands, args = ["--version"]) {
  for (const command of commands) {
    const version = await commandVersion(command, args);
    if (version) return { command, version };
  }
  return { command: null, version: "" };
}

function codexBinaryStatus(env = process.env) {
  const command = String(env.ORKESTR_CODEX_BIN || "codex").trim() || "codex";
  if (command === CODEX_DISABLED_ON_MACOS) return { command: null, version: "", disabled: true };
  return null;
}

function status(id, label, state, summary, details = {}) {
  return { id, label, state, summary, details };
}

function codexRuntimeKind(env = process.env) {
  return "app-server";
}

function orderedConnectorIds(overlay) {
  const overlayIds = Object.keys(overlay?.connectors || {}).filter(Boolean).sort();
  return [...connectorOrder, ...overlayIds.filter((id) => !connectorOrder.includes(id))];
}

async function overlayConnectorStatus(id, overlay) {
  const connector = overlay?.connectors?.[id];
  if (!connector || typeof connector !== "object" || Array.isArray(connector)) return null;
  const requiredPaths = Array.isArray(connector.requiredPaths) ? connector.requiredPaths.map(String).filter(Boolean) : [];
  const missingPaths = [];
  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) missingPaths.push(requiredPath);
  }
  const requestedState = String(connector.state || "connected").trim() || "connected";
  const state = missingPaths.length ? String(connector.missingState || "partial").trim() || "partial" : requestedState;
  return status(
    id,
    String(connector.label || id).trim() || id,
    state,
    String(
      missingPaths.length
        ? connector.missingSummary || `Overlay connector is configured but ${missingPaths.length} required path(s) are missing.`
        : connector.summary || "Configured by private overlay.",
    ),
    {
      ...(connector.details && typeof connector.details === "object" ? connector.details : {}),
      overlay: true,
      requiredPaths,
      missingPaths,
    },
  );
}

export async function getConnectorStatuses({ env = process.env, home = os.homedir() } = {}) {
  const paths = dataPaths(env);
  const [openaiConfig, gmailConfig, outlookConfig] = await Promise.all([
    readConnectorConfig("openai", env),
    readConnectorConfig("gmail", env),
    readConnectorConfig("outlook", env),
  ]);
  const codexHome = defaultCodexHome(env, home);
  const codexAuthPath = path.join(codexHome, "auth.json");
  const chrome = await firstCommandVersion(["google-chrome", "chrome", "chromium", "chromium-browser"]);
  const codex = codexBinaryStatus(env) || await firstCommandVersion([String(env.ORKESTR_CODEX_BIN || "codex").trim() || "codex"]);
  const codexAuth = codex.command ? await codexLoginStatus({ env, home, timeoutMs: 2500 }) : null;
  const codexRuntime = codexRuntimeKind(env);
  const codexAppServerHelp = codex.command ? await commandVersion(codex.command, ["app-server", "--help"]) : "";
  const codexAppServerAvailable = Boolean(codexAppServerHelp);
  const codexAppServerProbeResult = codex.command && codexAuth?.connected && codexAppServerAvailable
    ? await codexAppServerProbe({ env, home, command: codex.command })
    : null;
  const codexRuntimeAuthInvalid = codex.command && codexAuth?.connected
    ? await activeCodexRuntimeAuthInvalid({ env, codexAuthPath })
    : null;
  const timersExist = await pathExists(paths.timers);
  const linkedinProfileExists = await pathExists(path.join(paths.browsers, "linkedin"));
  const gmailProfileExists = await pathExists(path.join(paths.browsers, "gmail"));
  const gmailOAuthExists = await pathExists(path.join(paths.secrets, "gmail-token.json"));
  const gmailOAuthError = await readJsonIfExists(path.join(paths.secrets, "gmail-error.json"));
  const outlookOAuthExists = await pathExists(path.join(paths.secrets, "outlook-token.json"));
  const outlookOAuthError = await readJsonIfExists(path.join(paths.secrets, "outlook-error.json"));
  const openaiKey = env.OPENAI_API_KEY || openaiConfig.openaiApiKey || "";
  const codexAuthExists = await pathExists(codexAuthPath);
  const codexEnvKey = Boolean(env.OPENAI_API_KEY);
  const codexAuthInvalid = Boolean(codex.command && codexAuthExists && codexAuth && !codexAuth.connected);
  const codexAppServerInvalid = Boolean(codex.command && codexAuth?.connected && codexAppServerAvailable && codexAppServerProbeResult && !codexAppServerProbeResult.ok);
  const codexRuntimeInvalid = Boolean(codexRuntimeAuthInvalid);
  const whatsapp = await getWhatsAppStatus(env);
  const overlay = await readOverlay(env);

  const connectors = {
    openai: openaiKey
      ? status("openai", "OpenAI API", "connected", "OpenAI API key is configured for direct API connectors and skills.")
      : status("openai", "OpenAI API", "not_connected", "Optional for coding agents. Add an OpenAI API key only for connectors or skills that call OpenAI directly."),
    codex:
      codexAuthInvalid
        ? status("codex", "Codex Agent", "broken", "Stored Codex sign-in is no longer valid. Reconnect Codex before running coding agents.", {
            command: codex.command,
            version: codex.version,
            codexHome,
            runtime: codexRuntime,
            appServer: codexAppServerAvailable ? "available" : "missing",
            authMode: null,
            statusText: codexAuth?.statusText || "",
            reason: "codex_auth_invalid",
          })
        : codexRuntimeInvalid
          ? status("codex", "Codex Agent", "broken", "Codex login status succeeds, but a live Codex session reported an invalidated auth token. Run Codex login again before running coding agents.", {
              command: codex.command,
              version: codex.version,
              codexHome,
              runtime: codexRuntime,
              appServer: codexAppServerAvailable ? "available" : "missing",
              authMode: codexAuth?.authMode || null,
              statusText: codexAuth?.statusText || "",
              reason: codexRuntimeAuthInvalid.reason || "codex_runtime_auth_invalid",
              detectedAt: codexRuntimeAuthInvalid.detectedAt || null,
              threadId: codexRuntimeAuthInvalid.threadId || null,
              threadName: codexRuntimeAuthInvalid.threadName || null,
              tailHash: codexRuntimeAuthInvalid.tailHash || null,
              error: codexRuntimeAuthInvalid.summary || "",
            })
        : codexAppServerInvalid
          ? status("codex", "Codex Agent", "broken", "Codex login status succeeds, but the app-server cannot authenticate. Run Codex login again before running coding agents.", {
              command: codex.command,
              version: codex.version,
              codexHome,
              runtime: codexRuntime,
              appServer: "auth_invalid",
              authMode: codexAuth?.authMode || null,
              statusText: codexAuth?.statusText || "",
              reason: codexAppServerProbeResult.reason || "codex_app_server_unavailable",
              error: codexAppServerProbeResult.error || codexAppServerProbeResult.stderr || "",
            })
          : codex.command && codexAuth?.connected && codexAppServerAvailable
        ? status("codex", "Codex Agent", "connected", "Codex Agent runtime is installed, signed in, and app-server ready.", {
            command: codex.command,
            version: codex.version,
            codexHome,
            runtime: codexRuntime,
            appServer: "available",
            appServerProbe: codexAppServerProbeResult || null,
            authMode: codexAuth.authMode || (codexAuthExists ? "device_auth" : "codex_auth"),
            statusText: codexAuth.statusText,
          })
        : codex.command
          ? status("codex", "Codex Agent", "partial", codexAuth?.connected && !codexAppServerAvailable
              ? "Codex is signed in, but this Codex CLI does not expose app-server. Update Codex before creating coding agents."
              : codexEnvKey ? "OpenAI API key exists, but Codex Agent is not signed in yet. Connect Codex here before running coding agents." : "Codex Agent runtime is installed. Sign in here before running coding agents.", {
              command: codex.command,
              version: codex.version,
              codexHome,
              runtime: codexRuntime,
              appServer: codexAppServerAvailable ? "available" : "missing",
              authMode: null,
              statusText: codexAuth?.statusText || "",
              openaiKeyConfigured: codexEnvKey,
            })
          : status("codex", "Codex Agent", "not_connected", codex.disabled
            ? "Codex host binary is disabled for this macOS local install. Verify Codex manually, then rerun the installer with ORKESTR_ENABLE_HOST_CODEX=1."
            : "Codex Agent runtime is missing. Install Codex in the Orkestr runtime.", {
              codexHome,
              disabled: Boolean(codex.disabled),
              reason: codex.disabled ? "codex_disabled_on_macos" : "codex_missing",
            }),
    gmail:
      gmailOAuthExists
        ? status("gmail", "Gmail", "connected", "Gmail OAuth token is stored locally.")
        : gmailOAuthError.message
          ? status("gmail", "Gmail", "broken", "Gmail OAuth failed. Recheck credentials and restart OAuth.", {
              error: gmailOAuthError.message,
              updatedAt: gmailOAuthError.updatedAt,
            })
        : gmailConfig.clientId || env.GMAIL_OAUTH_CLIENT_ID
          ? status("gmail", "Gmail", "partial", "Gmail OAuth client is configured. Complete OAuth next.")
        : gmailProfileExists
          ? status("gmail", "Gmail", "partial", "Gmail browser profile exists. OAuth can be added later.")
          : status("gmail", "Gmail", "not_connected", "Connect Gmail OAuth or prepare the Gmail browser."),
    outlook:
      outlookOAuthExists
        ? status("outlook", "Outlook", "connected", "Outlook OAuth token is stored locally.")
        : outlookOAuthError.message
          ? status("outlook", "Outlook", "broken", "Outlook OAuth failed. Recheck the Microsoft app registration and restart sign-in.", {
              error: outlookOAuthError.message,
              updatedAt: outlookOAuthError.updatedAt,
            })
        : outlookConfig.clientId || env.OUTLOOK_OAUTH_CLIENT_ID || env.MICROSOFT_OAUTH_CLIENT_ID
          ? status("outlook", "Outlook", "partial", "Outlook app registration is configured. Complete Microsoft device sign-in next.")
          : status("outlook", "Outlook", "not_connected", "Create a Microsoft app registration, paste its client ID, then start Outlook sign-in."),
    linkedin: linkedinProfileExists
      ? status("linkedin", "LinkedIn", "partial", "LinkedIn browser profile exists. Log in through the virtual browser.")
      : status("linkedin", "LinkedIn", "not_connected", "Prepare a LinkedIn virtual browser profile."),
    whatsapp:
      whatsapp.state === "paired"
        ? status("whatsapp", "WhatsApp", "connected", whatsapp.summary, whatsapp)
        : whatsapp.state === "qr_needed" || whatsapp.state === "pairing_code" || whatsapp.state === "authenticating"
          ? status("whatsapp", "WhatsApp", "partial", whatsapp.summary, whatsapp)
          : ["not_configured", "unpaired"].includes(whatsapp.state)
            ? status("whatsapp", "WhatsApp", "not_connected", whatsapp.summary, whatsapp)
            : status("whatsapp", "WhatsApp", "broken", whatsapp.summary, whatsapp),
    browsers: chrome.command
      ? status("browsers", "Desktops", "connected", "Chrome-compatible browser is available.", {
          command: chrome.command,
          version: chrome.version,
        })
      : status("browsers", "Desktops", "broken", "No Chrome-compatible browser command found."),
    timers: timersExist
      ? status("timers", "Timers", "connected", "Timer store is initialized.")
      : status("timers", "Timers", "not_connected", "Create the first recurring timer."),
  };

  const orderedIds = orderedConnectorIds(overlay);
  const overlayStatuses = await Promise.all(orderedIds.map((id) => overlayConnectorStatus(id, overlay)));
  for (const override of overlayStatuses.filter(Boolean)) {
    connectors[override.id] = override;
  }

  return orderedIds.map((id) => connectors[id]).filter(Boolean);
}

function overlayActionError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function expandOverlayActionValue(value, input) {
  return String(value || "").replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key) => {
    const replacement = input?.[key];
    return replacement === undefined || replacement === null ? "" : String(replacement);
  });
}

function overlayActionCommand(action, input) {
  const command = Array.isArray(action?.command) ? action.command : [];
  const expanded = command.map((part) => expandOverlayActionValue(part, input)).filter((part) => part !== "");
  if (!expanded.length) throw overlayActionError("overlay_connector_action_command_missing", 400);
  return expanded;
}

export async function runOverlayConnectorAction(id, actionName, { env = process.env, input = {} } = {}) {
  const connectorId = String(id || "").trim();
  const actionId = String(actionName || "").trim();
  if (!connectorId || !actionId) throw overlayActionError("connector_action_required", 400);

  const overlay = await readOverlay(env);
  const connector = overlay?.connectors?.[connectorId];
  const action = connector?.actions?.[actionId];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw overlayActionError("overlay_connector_action_not_found", 404);
  }
  if (action.type && String(action.type) !== "command-json") {
    throw overlayActionError("unsupported_overlay_connector_action", 400);
  }

  const [command, ...args] = overlayActionCommand(action, input);
  const cwd = action.cwd
    ? path.resolve(path.dirname(overlay.path), expandOverlayActionValue(action.cwd, input))
    : path.dirname(overlay.path);
  const timeout = Math.min(Math.max(Number(action.timeoutMs || 30000), 1000), 120000);
  let result;
  try {
    result = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      timeout,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || "overlay action failed").trim();
    throw overlayActionError(detail || "overlay_action_failed", 500);
  }

  const raw = String(result.stdout || "").trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  return {
    ok: true,
    connector: connectorId,
    action: actionId,
    ...payload,
  };
}
