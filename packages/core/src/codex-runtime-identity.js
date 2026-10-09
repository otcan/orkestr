import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

// OS identity that Codex app-server shell commands run as. A root Orkestr
// server hands per-turn files (such as vault turn tokens) to this user so the
// runtime can read them while they stay 0600/0700. Resolution order:
// ORKESTR_CODEX_RUNTIME_USER, then User= of the external app-server unit
// (ORKESTR_CODEX_APP_SERVER_SERVICE_NAME), then ORKESTR_RUN_USER. A
// self-spawned (stdio) app-server runs as the server itself: null.

const execFileAsync = promisify(execFile);
const CACHE_MS = 5 * 60 * 1000;
const defaults = { getuid: () => process.getuid?.(), execFile: execFileAsync, passwdFile: "/etc/passwd", chown: (target, uid, gid) => fs.chown(target, uid, gid) };
let hooks = { ...defaults };
let cache = null;

function clean(value) {
  return String(value ?? "").trim();
}

// Same rule as codexAppServerUsesProxy (connectors/codex-app-server-transport).
function externalAppServer(env) {
  return ["external", "proxy", "daemon"].includes(clean(env.ORKESTR_CODEX_APP_SERVER_MODE).toLowerCase()) || Boolean(clean(env.ORKESTR_CODEX_APP_SERVER_SOCKET));
}

/** Test hook: overrides getuid/execFile/passwdFile/chown; call with no args to reset. */
export function setCodexRuntimeIdentityHooksForTest(overrides = null) {
  hooks = { ...defaults, ...(overrides || {}) };
  cache = null;
}

async function unitUser(serviceName) {
  if (!serviceName) return "";
  const result = await hooks.execFile("systemctl", ["show", serviceName, "-p", "User", "--value"], { timeout: 5000 }).catch(() => null);
  return clean(result?.stdout ?? result);
}

async function passwdRecord(user) {
  const raw = await fs.readFile(hooks.passwdFile, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 4 || line.startsWith("#")) continue;
    if (parts[0] !== user && parts[2] !== user) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (Number.isSafeInteger(uid) && Number.isSafeInteger(gid)) return { user: parts[0], uid, gid };
  }
  return null;
}

async function configuredUser(env) {
  const explicit = clean(env.ORKESTR_CODEX_RUNTIME_USER);
  if (explicit) return explicit;
  if (externalAppServer(env)) {
    const fromUnit = await unitUser(clean(env.ORKESTR_CODEX_APP_SERVER_SERVICE_NAME));
    if (fromUnit) return fromUnit;
    return clean(env.ORKESTR_RUN_USER);
  }
  return "";
}

/**
 * `{ user, uid, gid }` the Codex runtime runs as when it differs from a root
 * server, else null (non-root server, self-spawned runtime, root or unknown user).
 */
export async function codexRuntimeOwner(env = process.env, nowMs = Date.now()) {
  if (hooks.getuid() !== 0) return null;
  const key = [env.ORKESTR_CODEX_RUNTIME_USER, env.ORKESTR_CODEX_APP_SERVER_MODE, env.ORKESTR_CODEX_APP_SERVER_SOCKET,
    env.ORKESTR_CODEX_APP_SERVER_SERVICE_NAME, env.ORKESTR_RUN_USER].map(clean).join("\0");
  if (cache?.key === key && cache.expiresAt > nowMs) return cache.owner;
  const user = await configuredUser(env);
  const record = user ? await passwdRecord(user) : null;
  const owner = record && record.uid !== 0 ? record : null;
  if (owner) cache = { key, owner, expiresAt: nowMs + CACHE_MS };
  return owner;
}

/** Hands `target` to the Codex runtime user; no-op without one. */
export async function chownToCodexRuntime(target, env = process.env) {
  const owner = await codexRuntimeOwner(env);
  if (owner) await hooks.chown(target, owner.uid, owner.gid);
  return owner;
}
