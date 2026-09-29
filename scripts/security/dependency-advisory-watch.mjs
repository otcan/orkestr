#!/usr/bin/env node
// Scheduled dependency advisory watch for origin/main.
//
// Scans the current origin/main lockfile in a temporary worktree with that
// commit's own advisory scanner and exits non-zero with a short summary when
// the scan is blocked or new high/critical advisories appeared since the last
// run. `--fix-branch [name]` creates a LOCAL branch with lockfile-only updates
// for the affected packages (exact direct pins only within the same major),
// rescans it and reports whether that clears the block. Nothing is pushed.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../main-module.mjs";

const HIGH = new Set(["high", "critical"]);
const BLOCKING = new Set(["high", "critical", "unknown"]);

export function defaultExec(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export function watchStateDir(env = process.env) {
  const explicit = String(env.ORKESTR_ADVISORY_WATCH_STATE_DIR || "").trim();
  return path.resolve(explicit || path.join(env.ORKESTR_HOME || path.join(os.homedir(), ".orkestr"), "advisory-watch"));
}

// Default scanner: the scanned commit's own scripts/security/dependency-advisories.mjs.
export async function defaultScan({ root, commit, exec }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-advisory-report-"));
  const report = path.join(dir, "report.json");
  try {
    const run = await exec("node", [path.join(root, "scripts/security/dependency-advisories.mjs"), "--root", root, "--commit", commit, "--policy-commit", commit, "--report", report], { cwd: root });
    if (![0, 2].includes(run.code) || !fs.existsSync(report)) throw new Error("dependency_scan_failed_no_coverage_claim");
    return JSON.parse(fs.readFileSync(report, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const findingKey = (row) => `${row.package}@${row.version} ${row.advisoryId}`;

export function highCriticalKeys(report) {
  return (report.findings || []).filter((row) => row.status === "open" && HIGH.has(row.severity)).map(findingKey).sort();
}

function semver(value = "") {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function semverLess(a, b) {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
}

// Plans lockfile-only updates for blocking findings. Exact direct pins are
// bumped to the smallest fixed version in the same major; everything else
// goes through `npm update --package-lock-only`.
export function planFix(report, packageJson) {
  const direct = { ...(packageJson.dependencies || {}), ...(packageJson.optionalDependencies || {}), ...(packageJson.devDependencies || {}) };
  const pins = {};
  const update = new Set();
  const skipped = [];
  for (const row of (report.findings || []).filter((item) => item.status === "open" && BLOCKING.has(item.severity))) {
    const current = semver(row.version);
    const spec = direct[row.package];
    if (spec !== undefined && semver(spec)) {
      const fixed = String(row.fixedVersion || "").split(",").map(semver).filter((version) => version && current && version[0] === current[0] && semverLess(current, version))
        .sort((a, b) => (semverLess(a, b) ? -1 : 1))[0];
      if (fixed) pins[row.package] = fixed.join(".");
      else skipped.push({ package: row.package, reason: "no_fix_within_major" });
    } else {
      update.add(row.package);
    }
  }
  return { pins, update: [...update].sort(), skipped };
}

function setPin(packageJson, name, version) {
  for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
    if (packageJson[section]?.[name] !== undefined) packageJson[section][name] = version;
  }
}

async function applyFix({ git, exec, worktree, branch, report, scan, env }) {
  const fix = { branch, ...planFix(report, JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8"))) };
  await git(["switch", "--quiet", "-c", branch], worktree);
  const npmEnv = { ...env };
  if (Object.keys(fix.pins).length) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(fix.pins)) setPin(packageJson, name, version);
    fs.writeFileSync(path.join(worktree, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    const install = await exec("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: worktree, env: npmEnv });
    if (install.code !== 0) return { ...fix, error: "npm_install_failed" };
  }
  if (fix.update.length) {
    const update = await exec("npm", ["update", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", ...fix.update], { cwd: worktree, env: npmEnv });
    if (update.code !== 0) return { ...fix, error: "npm_update_failed" };
  }
  const status = await git(["status", "--porcelain", "--", "package.json", "package-lock.json"], worktree);
  if (!status) return { ...fix, changed: false, cleared: false };
  await git(["add", "package.json", "package-lock.json"], worktree);
  await git(["-c", "user.name=Orkestr advisory watch", "-c", "user.email=advisory-watch@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", `Update dependencies for open advisories\n\n${[...Object.entries(fix.pins).map(([name, version]) => `${name} -> ${version}`), ...fix.update].join("\n")}`], worktree);
  const commit = await git(["rev-parse", "HEAD"], worktree);
  const rescan = await scan({ root: worktree, commit, exec });
  return { ...fix, changed: true, commit, rescanStatus: rescan.status, blockingAfter: rescan.counts?.blocking ?? null, cleared: rescan.status === "passed" };
}

export async function runAdvisoryWatch({ repo, ref = "origin/main", stateDir, fixBranch = null, exec = defaultExec, scan = defaultScan, env = process.env, now = () => new Date() }) {
  const git = async (args, cwd = repo) => {
    const result = await exec("git", ["-C", cwd, ...args]);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().split("\n").at(-1) || result.code}`);
    return result.stdout.trim();
  };
  await exec("git", ["-C", repo, "fetch", "--quiet", "origin"]);
  const sha = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-advisory-watch-"));
  const worktree = path.join(base, "wt");
  const statePath = path.join(stateDir, "last.json");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  const result = { ok: false, sha, ref, checkedAt: now().toISOString() };
  try {
    await git(["worktree", "add", "--quiet", "--detach", worktree, sha]);
    const report = await scan({ root: worktree, commit: sha, exec });
    const keys = highCriticalKeys(report);
    const known = new Set(previous?.highCritical || []);
    result.status = report.status;
    result.counts = report.counts || {};
    result.newHighCritical = keys.filter((key) => !known.has(key));
    result.highCritical = keys;
    result.alert = report.status === "blocked" || result.newHighCritical.length > 0;
    if (fixBranch && result.alert) {
      const branch = typeof fixBranch === "string" && fixBranch ? fixBranch : `deps/advisory-fix-${sha.slice(0, 12)}`;
      result.fix = await applyFix({ git, exec, worktree, branch, report, scan, env });
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, `${JSON.stringify({ sha, status: report.status, highCritical: keys, checkedAt: result.checkedAt }, null, 2)}\n`, { mode: 0o600 });
    result.ok = !result.alert;
  } finally {
    await exec("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    fs.rmSync(base, { recursive: true, force: true });
    await exec("git", ["-C", repo, "worktree", "prune"]);
  }
  return result;
}

export function formatWatch(result) {
  const lines = [`Dependency advisories for ${result.ref} ${result.sha.slice(0, 12)}: ${result.status} (${result.counts?.blocking ?? 0} blocking, ${result.counts?.advisories ?? 0} total)`];
  if (result.newHighCritical?.length) lines.push(`New high/critical: ${result.newHighCritical.join("; ")}`);
  if (result.fix) {
    const fix = result.fix;
    if (fix.error) lines.push(`Fix branch ${fix.branch}: ${fix.error}`);
    else if (!fix.changed) lines.push(`Fix branch ${fix.branch}: lockfile-only updates changed nothing; a manual upgrade is needed.`);
    else lines.push(`Fix branch ${fix.branch} (${fix.commit.slice(0, 12)}, local only): rescan ${fix.rescanStatus}; ${fix.cleared ? "clears the block" : "does NOT clear the block"}.`);
    if (fix.skipped?.length) lines.push(`Not auto-fixed: ${fix.skipped.map((row) => `${row.package} (${row.reason})`).join(", ")}`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { repo: { type: "string" }, ref: { type: "string" }, "state-dir": { type: "string" }, "fix-branch": { type: "boolean" }, "branch-name": { type: "string" }, json: { type: "boolean" } }, allowPositionals: false });
  try {
    const result = await runAdvisoryWatch({
      repo: path.resolve(values.repo || process.cwd()),
      ref: values.ref || "origin/main",
      stateDir: path.resolve(values["state-dir"] || watchStateDir()),
      fixBranch: values["fix-branch"] ? values["branch-name"] || true : null,
    });
    process.stdout.write(`${values.json ? JSON.stringify(result, null, 2) : formatWatch(result)}\n`);
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`dependency advisory watch failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
