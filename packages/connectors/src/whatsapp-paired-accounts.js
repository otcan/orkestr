// Remembers which local WhatsApp accounts finished pairing on this instance,
// so a self-hosted install (for example a Docker container with a /data
// volume) reconnects them after a restart without ORKESTR_WHATSAPP_AUTOSTART
// and without scanning a QR code again.
//
// The marker holds no credentials: the WhatsApp session itself stays in the
// bridge's LocalAuth directory. Auto-start from markers only runs when the
// built-in bridge is the active transport, never next to a dedicated worker
// or an external/relay bridge, so two clients never share one session.
import fs from "node:fs/promises";
import path from "node:path";
import { readConnectorConfig } from "../../storage/src/config.js";
import { dataPaths } from "../../storage/src/paths.js";
import { writeSecretJson } from "../../storage/src/store.js";

const MARKER_VERSION = 1;

export function pairedAccountsPath(env = process.env) {
  return path.join(dataPaths(env).home, "whatsapp-bridge", "paired-accounts.json");
}

function cleanAccountId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(text) ? text : "";
}

export async function readPairedWhatsAppAccounts(env = process.env) {
  try {
    const parsed = JSON.parse(await fs.readFile(pairedAccountsPath(env), "utf8"));
    const accounts = parsed && typeof parsed.accounts === "object" && parsed.accounts ? parsed.accounts : {};
    return Object.fromEntries(Object.entries(accounts).filter(([id]) => cleanAccountId(id)));
  } catch {
    return {};
  }
}

async function writePaired(accounts, env) {
  await writeSecretJson(pairedAccountsPath(env), { version: MARKER_VERSION, accounts });
}

// Serialize marker updates in this process so concurrent ready/logout events
// cannot drop each other's changes.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export function markWhatsAppAccountPaired(accountId, env = process.env, now = new Date()) {
  const id = cleanAccountId(accountId);
  if (!id) return Promise.resolve(false);
  return serialized(async () => {
    const accounts = await readPairedWhatsAppAccounts(env);
    accounts[id] = { pairedAt: accounts[id]?.pairedAt || now.toISOString(), lastReadyAt: now.toISOString() };
    await writePaired(accounts, env);
    return true;
  });
}

export function clearWhatsAppAccountPaired(accountId, env = process.env) {
  const id = cleanAccountId(accountId);
  if (!id) return Promise.resolve(false);
  return serialized(async () => {
    const accounts = await readPairedWhatsAppAccounts(env);
    if (!accounts[id]) return false;
    delete accounts[id];
    await writePaired(accounts, env);
    return true;
  });
}

function falsy(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// Why paired-marker auto-start is (not) allowed in this environment.
export async function pairedAutostartBlocker(env = process.env, { readConfig = readConnectorConfig } = {}) {
  const autostart = env.ORKESTR_WHATSAPP_AUTOSTART ?? env.WHATSAPP_LOCAL_AUTOSTART;
  if (falsy(autostart)) return "autostart_disabled";
  if (truthy(autostart)) return "explicit_autostart_configured";
  if (String(env.ORKESTR_WA_WORKER_SOCKET || env.ORKESTR_WA_WORKER_URL || "").trim()) return "dedicated_worker_configured";
  if (truthy(env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED) || truthy(env.WHATSAPP_EXTERNAL_BRIDGE_ENABLED)) return "external_bridge_configured";
  const config = await readConfig("whatsapp", env).catch(() => ({}));
  const mode = String(env.WHATSAPP_BRIDGE_MODE || config?.bridgeMode || "local").trim().toLowerCase();
  if (mode !== "local") return "bridge_not_local";
  return "";
}

// Called once at server start. Starts each paired account through the normal
// bridge start path; failures are reported per account and never thrown.
export async function startPairedLocalWhatsAppAccounts(env = process.env, { startAccount, readConfig } = {}) {
  const blocker = await pairedAutostartBlocker(env, { readConfig });
  if (blocker) return { enabled: false, reason: blocker, accounts: [] };
  const paired = Object.keys(await readPairedWhatsAppAccounts(env));
  if (!paired.length || typeof startAccount !== "function") return { enabled: true, accounts: [] };
  const accounts = [];
  for (const accountId of paired) {
    try {
      const result = await startAccount(accountId, env);
      accounts.push({ accountId, state: result?.state || "starting" });
    } catch (error) {
      accounts.push({ accountId, state: "failed", error: error?.message || String(error) });
    }
  }
  return { enabled: true, accounts };
}
