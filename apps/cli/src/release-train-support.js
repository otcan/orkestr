// Shared plumbing for `orkestr release-train`: an injectable process runner,
// the per-commit result store, and small git helpers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appHome } from "../../../packages/storage/src/paths.js";
import { parseGithubRepository } from "../../../scripts/release-provenance/github-api.mjs";

const OUTPUT_TAIL_BYTES = 256 * 1024;

export function isFullSha(value = "") {
  return /^[a-f0-9]{40}$/.test(String(value || ""));
}

// Runs a command without a shell and resolves { code, stdout, stderr } with
// bounded output tails. Optional logFile receives the full output.
export function createExec({ spawnImpl = spawn } = {}) {
  return (command, args = [], { cwd, env, logFile, timeoutMs = 0 } = {}) => new Promise((resolve) => {
    let child;
    const out = [];
    const err = [];
    const log = logFile ? fs.createWriteStream(logFile, { flags: "a", mode: 0o600 }) : null;
    const keep = (bucket, chunk) => {
      bucket.push(chunk);
      let size = bucket.reduce((sum, item) => sum + item.length, 0);
      while (size > OUTPUT_TAIL_BYTES && bucket.length > 1) size -= bucket.shift().length;
      log?.write(chunk);
    };
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;
    child.stdout?.on("data", (chunk) => keep(out, chunk));
    child.stderr?.on("data", (chunk) => keep(err, chunk));
    child.on("error", (error) => err.push(Buffer.from(String(error?.message || error))));
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      log?.end();
      resolve({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out.map((c) => Buffer.from(c))).toString("utf8"), stderr: Buffer.concat(err.map((c) => Buffer.from(c))).toString("utf8") });
    });
  });
}

export function createGit(exec, repo) {
  const git = async (args, { cwd = repo, allowFailure = false } = {}) => {
    const result = await exec("git", ["-C", cwd, ...args]);
    if (result.code !== 0 && !allowFailure) {
      const error = new Error(`git ${args[0]} failed: ${String(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
      error.result = result;
      throw error;
    }
    return allowFailure ? result : result.stdout.trim();
  };
  return git;
}

export async function repoRootFrom(exec, cwd) {
  const result = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new Error(`Not a git repository: ${cwd}. Pass --repo <path>.`);
  return result.stdout.trim();
}

// Resolves a ref to a full sha, preferring origin/<ref>.
export async function resolveRef(git, ref) {
  for (const candidate of [`origin/${ref}`, ref]) {
    const result = await git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { allowFailure: true });
    if (result.code === 0 && isFullSha(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error(`Cannot resolve ref ${ref}.`);
}

export async function onOrigin(git, sha) {
  const result = await git(["branch", "-r", "--contains", sha], { allowFailure: true });
  return result.code === 0 && result.stdout.split("\n").some((line) => line.trim().startsWith("origin/"));
}

export async function originRepository(git, env = {}) {
  if (env.ORKESTR_DEPLOY_PROVENANCE_REPO) return parseGithubRepository(env.ORKESTR_DEPLOY_PROVENANCE_REPO);
  const url = await git(["remote", "get-url", "origin"], { allowFailure: true });
  return url.code === 0 ? parseGithubRepository(url.stdout.trim()) : null;
}

export function releaseTrainStateDir(env = process.env) {
  return path.resolve(String(env.ORKESTR_RELEASE_TRAIN_STATE_DIR || "").trim() || path.join(appHome(env), "release-train"));
}

export function readShaRecord(stateDir, sha) {
  if (!isFullSha(sha)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, `${sha}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Merges `patch` into the per-sha record ({ sha, check, ci, deploy }).
export function writeShaRecord(stateDir, sha, patch) {
  if (!isFullSha(sha)) throw new Error("A full 40-character commit sha is required.");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const next = { ...(readShaRecord(stateDir, sha) || { sha }), ...patch, sha, updatedAt: new Date().toISOString() };
  const file = path.join(stateDir, `${sha}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return next;
}

export function tail(text = "", lines = 20) {
  return String(text).trimEnd().split("\n").slice(-lines).join("\n");
}
