import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readOverlay } from "../../core/src/overlay.js";

const defaultGogClient = "ops-health-gmail";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeEmail(value = "") {
  const text = clean(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
}

function commandVector(input = {}, env = process.env) {
  const rawJson = clean(
    input.gogCommandJson ||
      env.ORKESTR_WHATSAPP_REPAIR_GOG_COMMAND_JSON ||
      env.ORKESTR_GMAIL_GOG_COMMAND_JSON ||
      env.ORKESTR_JOBS_GOG_COMMAND_JSON ||
      env.ORKESTR_GOG_COMMAND_JSON,
  );
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(clean).filter(Boolean);
    } catch {
      return ["gog"];
    }
  }
  return [
    clean(
      input.gogCommand ||
        env.ORKESTR_WHATSAPP_REPAIR_GOG_COMMAND ||
        env.ORKESTR_GMAIL_GOG_COMMAND ||
        env.ORKESTR_JOBS_GOG_COMMAND ||
        env.ORKESTR_GOG_COMMAND,
    ) || "gog",
  ];
}

function parseEnvValue(raw = "") {
  const text = clean(raw);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

async function envValueFromFile(filePath = "", name = "") {
  if (!filePath || !name) return "";
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match?.[1] === name) return parseEnvValue(match[2]);
  }
  return "";
}

async function hostNativeGmailEnv(input = {}, env = process.env) {
  const nextEnv = { ...process.env, ...env };
  if (!nextEnv.GOG_KEYRING_PASSWORD) {
    const envFile = clean(
      input.gogEnvFile ||
        env.ORKESTR_WHATSAPP_REPAIR_GOG_ENV_FILE ||
        env.ORKESTR_GMAIL_GOG_ENV_FILE ||
        env.ORKESTR_JOBS_GOG_ENV_FILE ||
        env.ORKESTR_GOG_ENV_FILE,
    );
    const password = await envValueFromFile(envFile, "GOG_KEYRING_PASSWORD");
    if (password) nextEnv.GOG_KEYRING_PASSWORD = password;
  }
  return nextEnv;
}

async function passwdRecord(username = "") {
  const target = clean(username);
  if (!target) return null;
  const raw = await fs.readFile("/etc/passwd", "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts[0] !== target) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
    return {
      username: parts[0],
      uid,
      gid,
      home: clean(parts[5]),
      shell: clean(parts[6]),
    };
  }
  return null;
}

async function userRuntimeDir(uid) {
  const runtimeDir = `/run/user/${uid}`;
  const stat = await fs.stat(runtimeDir).catch(() => null);
  return stat?.isDirectory() ? runtimeDir : "";
}

async function userDbusAddress(uid) {
  const runtimeDir = await userRuntimeDir(uid);
  if (!runtimeDir) return "disabled:";
  const busPath = `${runtimeDir}/bus`;
  const stat = await fs.stat(busPath).catch(() => null);
  return stat?.isSocket() ? `unix:path=${busPath}` : "disabled:";
}

async function runGogJsonCommand(command = [], args = [], env = process.env, input = "", options = {}) {
  const runAsUser = clean(
    options.gogRunAsUser ||
      env.ORKESTR_WHATSAPP_REPAIR_GOG_RUN_AS_USER ||
      env.ORKESTR_GMAIL_GOG_RUN_AS_USER ||
      env.ORKESTR_JOBS_GOG_RUN_AS_USER ||
      env.ORKESTR_GOG_RUN_AS_USER,
  );
  const childEnv = { ...env };
  const spawnOptions = { env: childEnv, stdio: ["pipe", "pipe", "pipe"] };
  if (runAsUser && process.getuid?.() === 0) {
    const record = await passwdRecord(runAsUser);
    if (!record) throw Object.assign(new Error("gog_run_as_user_not_found"), { statusCode: 500 });
    spawnOptions.uid = record.uid;
    spawnOptions.gid = record.gid;
    childEnv.USER = record.username;
    childEnv.LOGNAME = record.username;
    if (record.home) childEnv.HOME = record.home;
    if (record.shell) childEnv.SHELL = record.shell;
    if (!clean(childEnv.XDG_RUNTIME_DIR)) {
      const runtimeDir = await userRuntimeDir(record.uid);
      if (runtimeDir) childEnv.XDG_RUNTIME_DIR = runtimeDir;
    }
    if (!clean(childEnv.DBUS_SESSION_BUS_ADDRESS)) childEnv.DBUS_SESSION_BUS_ADDRESS = await userDbusAddress(record.uid);
    if (!clean(childEnv.NO_AT_BRIDGE)) childEnv.NO_AT_BRIDGE = "1";
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], spawnOptions);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("gog_gmail_timeout"), { statusCode: 504 }));
    }, Math.max(1000, Number(options.gogTimeoutMs || 60_000) || 60_000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error(clean(stderr) || `gog_gmail_exit_${code}`), { statusCode: 502 }));
        return;
      }
      if (!clean(stdout)) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(Object.assign(new Error("gog_gmail_invalid_json"), { statusCode: 502 }));
      }
    });
    child.stdin.end(input);
  });
}

function hostNativeGmailAccountFromEnv(env = process.env) {
  return normalizeEmail(
    env.ORKESTR_WHATSAPP_REPAIR_GOG_ACCOUNT ||
      env.ORKESTR_GMAIL_GOG_ACCOUNT ||
      env.ORKESTR_JOBS_GOG_ACCOUNT ||
      env.GOG_ACCOUNT,
  );
}

function attachmentPaths(args = {}, options = {}) {
  const values = [
    ...(Array.isArray(args.attachments) ? args.attachments : []),
    ...(Array.isArray(options.attachments) ? options.attachments : []),
    args.attachmentPath,
    options.attachmentPath,
  ];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const filePath = clean(
      typeof value === "string"
        ? value
        : value?.path || value?.filePath || value?.localPath || value?.savedPath || value?.saved_path,
    );
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    result.push(filePath);
  }
  return result;
}

function hostNativeSourceEnabled(env = process.env, overlayConnector = null) {
  const source = lower(env.ORKESTR_WHATSAPP_REPAIR_GMAIL_SOURCE || env.ORKESTR_GMAIL_SOURCE || env.ORKESTR_JOBS_GMAIL_SOURCE);
  if (source === "gog" || source === "host-native") return true;
  return lower(overlayConnector?.details?.kind) === "host-native";
}

export async function listHostNativeGmailAccounts(env = process.env, options = {}) {
  const overlayReader = options.readOverlay || readOverlay;
  const overlay = await overlayReader(env).catch(() => null);
  const connector = overlay?.connectors?.gmail;
  const accounts = [];
  const envAccount = hostNativeGmailAccountFromEnv(env);
  if (envAccount) accounts.push({ account: envAccount, primary: true, source: "env" });
  if (connector && hostNativeSourceEnabled(env, connector)) {
    const details = connector.details && typeof connector.details === "object" ? connector.details : {};
    const primary = normalizeEmail(details.account || details.email);
    if (primary) accounts.push({ account: primary, primary: true, source: "overlay" });
    for (const item of Array.isArray(details.accounts) ? details.accounts : []) {
      const account = normalizeEmail(item?.account || item?.email);
      const state = lower(item?.state || connector.state || "connected");
      if (account && state !== "broken" && state !== "not_connected") {
        accounts.push({ account, primary: account === primary, source: "overlay" });
      }
    }
  }
  const seen = new Set();
  return accounts.filter((item) => {
    if (!item.account || seen.has(item.account)) return false;
    seen.add(item.account);
    return true;
  });
}

export async function sendHostNativeGmailMessage(args = {}, env = process.env, options = {}) {
  const to = clean(args.to);
  const subject = clean(args.subject);
  const body = clean(args.body || args.text);
  if (!to) throw Object.assign(new Error("gmail_to_required"), { statusCode: 400 });
  if (!subject) throw Object.assign(new Error("gmail_subject_required"), { statusCode: 400 });
  if (!body) throw Object.assign(new Error("gmail_message_content_required"), { statusCode: 400 });
  const account = normalizeEmail(args.account || options.account || hostNativeGmailAccountFromEnv(env));
  const client = clean(options.gogClient || env.ORKESTR_WHATSAPP_REPAIR_GOG_CLIENT || env.ORKESTR_GMAIL_GOG_CLIENT || env.ORKESTR_JOBS_GOG_CLIENT || env.GOG_CLIENT) || defaultGogClient;
  const baseArgs = [
    ...(account ? ["--account", account] : []),
    "--client", client,
    "--json",
    "--no-input",
    "gmail",
    "send",
    "--to", to,
    "--subject", subject,
    "--body-file", "-",
    ...attachmentPaths(args, options).flatMap((filePath) => ["--attach", filePath]),
  ];
  const command = commandVector(options, env);
  const commandEnv = await hostNativeGmailEnv(options, env);
  const message = await runGogJsonCommand(command, baseArgs, commandEnv, body, options);
  return { ok: true, provider: "gmail", transport: "host_native_gog", account, message };
}
