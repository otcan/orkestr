import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConnectorConfig } from "../../storage/src/config.js";
import { dataPaths } from "../../storage/src/paths.js";

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

async function whatsappBridgeStatus(url) {
  if (!url) return null;
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ok: false, state: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { ok: false, state: "unreachable", error: error.message };
  }
}

export async function getConnectorStatuses({ env = process.env, home = os.homedir() } = {}) {
  const paths = dataPaths(env);
  const [openaiConfig, gmailConfig, whatsappConfig] = await Promise.all([
    readConnectorConfig("openai", env),
    readConnectorConfig("gmail", env),
    readConnectorConfig("whatsapp", env),
  ]);
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const codexAuthPath = path.join(codexHome, "auth.json");
  const chrome = await firstCommandVersion(["google-chrome", "chrome", "chromium", "chromium-browser"]);
  const codex = await firstCommandVersion(["codex"]);
  const timersExist = await pathExists(paths.timers);
  const linkedinProfileExists = await pathExists(path.join(paths.browsers, "linkedin"));
  const gmailProfileExists = await pathExists(path.join(paths.browsers, "gmail"));
  const gmailOAuthExists = await pathExists(path.join(paths.secrets, "gmail-token.json"));
  const openaiKey = env.OPENAI_API_KEY || openaiConfig.openaiApiKey || "";
  const bridgeUrl = env.WHATSAPP_BRIDGE_URL || whatsappConfig.bridgeUrl || "";
  const bridge = await whatsappBridgeStatus(bridgeUrl);

  const connectors = {
    openai: openaiKey
      ? status("openai", "OpenAI", "connected", "OpenAI key is configured locally.")
      : status("openai", "OpenAI", "not_connected", "Add an OpenAI API key or connect Codex auth."),
    codex:
      codex.command && (await pathExists(codexAuthPath))
        ? status("codex", "Codex", "connected", "Codex CLI and auth file are present.", {
            command: codex.command,
            version: codex.version,
            codexHome,
          })
        : codex.command
          ? status("codex", "Codex", "partial", "Codex CLI is installed, but auth is not connected.", {
              command: codex.command,
              version: codex.version,
              codexHome,
            })
          : status("codex", "Codex", "not_connected", "Install and authenticate Codex CLI."),
    gmail:
      gmailOAuthExists
        ? status("gmail", "Gmail", "connected", "Gmail OAuth token is stored locally.")
        : gmailConfig.clientId || env.GMAIL_OAUTH_CLIENT_ID
          ? status("gmail", "Gmail", "partial", "Gmail OAuth client is configured. Complete OAuth next.")
        : gmailProfileExists
          ? status("gmail", "Gmail", "partial", "Gmail browser profile exists. OAuth can be added later.")
          : status("gmail", "Gmail", "not_connected", "Connect Gmail OAuth or prepare the Gmail browser."),
    linkedin: linkedinProfileExists
      ? status("linkedin", "LinkedIn", "partial", "LinkedIn browser profile exists. Log in through the virtual browser.")
      : status("linkedin", "LinkedIn", "not_connected", "Prepare a LinkedIn virtual browser profile."),
    whatsapp: bridge?.ok || bridge?.ready
      ? status("whatsapp", "WhatsApp", "connected", "WhatsApp bridge is reachable and ready.", { bridgeUrl, bridge })
      : bridgeUrl
        ? status("whatsapp", "WhatsApp", "partial", "WhatsApp bridge URL is configured but not ready.", {
            bridgeUrl,
            bridge,
          })
        : status("whatsapp", "WhatsApp", "not_connected", "Configure a local WhatsApp bridge URL."),
    browsers: chrome.command
      ? status("browsers", "Virtual Browsers", "connected", "Chrome-compatible browser is available.", {
          command: chrome.command,
          version: chrome.version,
        })
      : status("browsers", "Virtual Browsers", "broken", "No Chrome-compatible browser command found."),
    timers: timersExist
      ? status("timers", "Timers", "connected", "Timer store is initialized.")
      : status("timers", "Timers", "not_connected", "Create the first recurring timer."),
  };

  return connectorOrder.map((id) => connectors[id]);
}
