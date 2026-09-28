// Owner-aware Git execution for privileged control planes.
//
// When the service runs as root but a checkout (and all of its Git metadata)
// belongs to a single allowlisted non-root executor user, Git runs as that
// user's uid/gid so refs, index and objects stay owned by the executor. Every
// other case falls back to the same-uid guard in worker-git-ownership.js, so
// mixed ownership and non-allowlisted owners still fail closed.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { assertWorkerGitOwnership, inspectWorkerGitOwnership } from "./worker-git-ownership.js";

const execFileAsync = promisify(execFile);
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

function setting(env, key) {
  const value = env?.[key] ?? process.env[key];
  return String(value ?? "").trim();
}

export function gitOwnerExecEnabled(env = process.env) {
  return !DISABLED_VALUES.has(setting(env, "ORKESTR_GIT_OWNER_EXEC").toLowerCase());
}

export function gitOwnerAllowlist(env = process.env) {
  const explicit = setting(env, "ORKESTR_GIT_OWNER_ALLOWLIST");
  const fallback = setting(env, "ORKESTR_EXECUTOR_RUN_USER") || setting(env, "ORKESTR_RUN_USER") || "orkestr";
  return new Set((explicit || fallback).split(",").map((name) => name.trim()).filter(Boolean));
}

export function parsePasswd(text) {
  const users = [];
  for (const line of String(text || "").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [name, , uid, gid, , home] = line.split(":");
    const entry = { name, uid: Number(uid), gid: Number(gid), home: home || "/" };
    if (name && Number.isInteger(entry.uid) && Number.isInteger(entry.gid)) users.push(entry);
  }
  return users;
}

export function createPasswdResolver(file = "/etc/passwd") {
  return async (uid) => {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    return parsePasswd(text).find((entry) => entry.uid === uid) || null;
  };
}

const defaultDeps = {
  geteuid: () => process.geteuid?.(),
  realpath: (target) => fs.realpath(target),
  lstat: (target) => fs.lstat(target),
  resolveUser: createPasswdResolver(),
  inspect: inspectWorkerGitOwnership,
  assertSameUid: assertWorkerGitOwnership,
  execFile: execFileAsync,
};

function withDefaults(deps) {
  return { ...defaultDeps, ...(deps || {}) };
}

// Returns the owner identity to run Git as, or null when owner execution does
// not apply (not root, kill switch, root-owned or non-allowlisted checkout).
// Throws the worker-git-ownership blocker when the owner is allowlisted but
// metadata ownership is mixed or cannot be proven.
export async function ownerGitExecIdentity(checkout, env = process.env, deps = undefined) {
  const d = withDefaults(deps);
  if (!gitOwnerExecEnabled(env) || d.geteuid() !== 0 || !checkout) return null;
  let stat;
  try { stat = await d.lstat(await d.realpath(checkout)); } catch { return null; }
  if (!Number.isInteger(stat?.uid) || stat.uid === 0) return null;
  const user = await d.resolveUser(stat.uid);
  if (!user || user.uid !== stat.uid || user.uid === 0 || !gitOwnerAllowlist(env).has(user.name)) return null;
  const ownership = await d.inspect(checkout);
  if (ownership?.ownerUid !== user.uid) return null;
  return {
    uid: user.uid,
    gid: user.gid,
    user: user.name,
    home: user.home,
    ownership,
    execOptions: {
      uid: user.uid,
      // Only the primary gid is applied; Node clears supplementary groups.
      gid: user.gid,
      env: {
        HOME: user.home,
        USER: user.name,
        LOGNAME: user.name,
        XDG_CONFIG_HOME: path.join(user.home, ".config"),
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  };
}

// Strict resolution used immediately before a mutation.
export async function resolveGitExec(checkout, env = process.env, deps = undefined) {
  const d = withDefaults(deps);
  const identity = await ownerGitExecIdentity(checkout, env, d);
  if (identity) return { execOptions: identity.execOptions, executedAsUid: identity.uid, ownership: identity.ownership };
  const ownership = await d.assertSameUid(checkout);
  return { execOptions: {}, executedAsUid: d.geteuid() ?? null, ownership };
}

// Re-checks ownership and runs one Git command under the resolved identity.
export async function runOwnerAwareGit(repoPath, args, env = process.env, deps = undefined) {
  const d = withDefaults(deps);
  const { execOptions, executedAsUid } = await resolveGitExec(repoPath, env, d);
  const { stdout, stderr } = await d.execFile("git", ["-C", repoPath, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    ...execOptions,
    env: { ...process.env, ...execOptions.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), executedAsUid };
}

// Read-only state refresh scope: Git helpers resolve an owner identity per
// repository path lazily. Resolution failures fall back to the caller's uid.
const scopeStorage = new AsyncLocalStorage();

export function withGitOwnerScope(env, fn, deps = undefined) {
  return scopeStorage.run({ env, deps, cache: new Map() }, fn);
}

export async function scopedGitExecOptions(repoPath) {
  const scope = scopeStorage.getStore();
  if (!scope || !repoPath) return {};
  const key = path.resolve(String(repoPath));
  if (!scope.cache.has(key)) {
    scope.cache.set(key, ownerGitExecIdentity(key, scope.env, scope.deps)
      .then((identity) => identity?.execOptions || {})
      .catch(() => ({})));
  }
  return scope.cache.get(key);
}
