import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConnectorConfig } from "../../storage/src/config.js";
import { dataPaths } from "../../storage/src/paths.js";
import { readOverlay } from "../../core/src/overlay.js";
import { defaultCodexHome } from "./codex.js";
import { getWhatsAppStatus } from "./whatsapp.js";

const execFileAsync = promisify(execFile);

export const connectorOrder = ["openai", "codex", "gmail", "linkedin", "whatsapp", "browsers", "timers"];

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

function status(id, label, state, summary, details = {}) {
  return { id, label, state, summary, details };
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
  const [openaiConfig, gmailConfig] = await Promise.all([
    readConnectorConfig("openai", env),
    readConnectorConfig("gmail", env),
  ]);
  const codexHome = defaultCodexHome(env, home);
  const codexAuthPath = path.join(codexHome, "auth.json");
  const chrome = await firstCommandVersion(["google-chrome", "chrome", "chromium", "chromium-browser"]);
  const codex = await firstCommandVersion(["codex"]);
  const timersExist = await pathExists(paths.timers);
  const linkedinProfileExists = await pathExists(path.join(paths.browsers, "linkedin"));
  const gmailProfileExists = await pathExists(path.join(paths.browsers, "gmail"));
  const gmailOAuthExists = await pathExists(path.join(paths.secrets, "gmail-token.json"));
  const gmailOAuthError = await readJsonIfExists(path.join(paths.secrets, "gmail-error.json"));
  const openaiKey = env.OPENAI_API_KEY || openaiConfig.openaiApiKey || "";
  const codexAuthExists = await pathExists(codexAuthPath);
  const codexEnvKey = Boolean(env.OPENAI_API_KEY);
  const whatsapp = await getWhatsAppStatus(env);
  const overlay = await readOverlay(env);

  const connectors = {
    openai: openaiKey
      ? status("openai", "OpenAI", "connected", "OpenAI key is configured locally.")
      : status("openai", "OpenAI", "not_connected", "Add an OpenAI API key or connect Codex auth."),
    codex:
      codex.command && (codexAuthExists || codexEnvKey)
        ? status("codex", "Codex", "connected", codexAuthExists ? "Codex runtime is installed and signed in." : "Codex runtime is installed and will use OPENAI_API_KEY from the runtime env.", {
            command: codex.command,
            version: codex.version,
            codexHome,
            authMode: codexAuthExists ? "device_auth" : "api_key",
            dockerRuntime: String(env.ORKESTR_DOCKER || "").trim() === "1",
          })
        : codex.command
          ? status("codex", "Codex", "partial", "Codex runtime is installed. Sign in from this setup page.", {
              command: codex.command,
              version: codex.version,
              codexHome,
              dockerRuntime: String(env.ORKESTR_DOCKER || "").trim() === "1",
            })
          : status("codex", "Codex", "not_connected", "Codex runtime is missing. Use the Docker image or install Codex in the Orkestr runtime.", {
              codexHome,
              dockerRuntime: String(env.ORKESTR_DOCKER || "").trim() === "1",
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
    linkedin: linkedinProfileExists
      ? status("linkedin", "LinkedIn", "partial", "LinkedIn browser profile exists. Log in through the virtual browser.")
      : status("linkedin", "LinkedIn", "not_connected", "Prepare a LinkedIn virtual browser profile."),
    whatsapp:
      whatsapp.state === "paired"
        ? status("whatsapp", "WhatsApp", "connected", whatsapp.summary, whatsapp)
        : whatsapp.state === "qr_needed"
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

  const overlayStatuses = await Promise.all(connectorOrder.map((id) => overlayConnectorStatus(id, overlay)));
  for (const override of overlayStatuses.filter(Boolean)) {
    connectors[override.id] = override;
  }

  return connectorOrder.map((id) => connectors[id]);
}
