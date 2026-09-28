// Best-effort, time-bounded summary of partial work a stopped Claude Code turn
// may have left behind. It reports only repository paths, branch names, and
// changed-file counts -- never file contents or diffs.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const pathKeys = new Set(["cwd", "path", "file_path", "filePath", "notebook_path", "directory", "dir", "worktree", "worktreePath"]);
const absolutePathPattern = /(?:^|[\s"'`=(:])(\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+)/g;
const maxCandidates = 64;
const maxRepositories = 6;
const maxDirectories = 16;

function clean(value = "") {
  return String(value || "").trim();
}

function toolInputs(event = {}) {
  if (clean(event.type).toLowerCase() !== "assistant") return [];
  const content = Array.isArray(event.message?.content) ? event.message.content : Array.isArray(event.content) ? event.content : [];
  return content
    .filter((block) => clean(block?.type).toLowerCase() === "tool_use" && block.input && typeof block.input === "object")
    .map((block) => block.input);
}

// Collects absolute paths mentioned in tool inputs (including sub-agent tool
// calls) so a stopped turn can report the worktrees it was touching.
export function createClaudeCodeWorkspaceTracker() {
  const candidates = new Set();
  function add(value) {
    const candidate = path.normalize(clean(value).replace(/[.,;:]+$/, ""));
    if (candidates.size < maxCandidates && path.isAbsolute(candidate) && candidate !== "/") candidates.add(candidate);
  }
  function scan(value, key = "", depth = 0) {
    if (candidates.size >= maxCandidates || depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (pathKeys.has(key) && value.startsWith("/")) add(value);
      for (const match of value.slice(0, 20_000).matchAll(absolutePathPattern)) add(match[1]);
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) scan(item, key, depth + 1); return; }
    if (typeof value === "object") for (const [childKey, child] of Object.entries(value).slice(0, 50)) scan(child, childKey, depth + 1);
  }
  return {
    observe(event = {}) {
      for (const input of toolInputs(event)) scan(input);
    },
    get paths() { return [...candidates]; },
  };
}

function git(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
      cwd,
      timeout: Math.max(100, timeoutMs),
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "", GIT_TERMINAL_PROMPT: "0", LANG: "C" },
    }, (error, stdout = "") => resolve(error ? null : String(stdout)));
  });
}

async function nearestDirectory(candidate) {
  let current = candidate;
  for (let depth = 0; depth < 12 && current && current !== path.dirname(current); depth += 1) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current;
    } catch {}
    current = path.dirname(current);
  }
  return "";
}

// Returns { repositories: [{ path, branch, changedFiles }], timedOut }.
export async function summarizeClaudeCodePartialWork({ cwd = "", paths = [], timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 8_000);
  const remaining = () => deadline - Date.now();
  const roots = new Map();
  let timedOut = false;
  const directories = new Set();
  for (const candidate of [cwd, ...paths].map(clean).filter(Boolean)) {
    if (remaining() <= 0) { timedOut = true; break; }
    const directory = await nearestDirectory(candidate);
    if (directory) directories.add(directory);
  }
  for (const directory of [...directories].slice(0, maxDirectories)) {
    if (roots.size >= maxRepositories) break;
    if (remaining() <= 0) { timedOut = true; break; }
    const top = clean(await git(["rev-parse", "--show-toplevel"], directory, Math.min(2_000, remaining())));
    if (top && !roots.has(top)) roots.set(top, null);
  }
  for (const root of roots.keys()) {
    if (remaining() <= 0) { timedOut = true; break; }
    const status = await git(["status", "--porcelain", "--untracked-files=normal"], root, Math.min(3_000, remaining()));
    if (status === null) continue;
    const branch = clean(await git(["rev-parse", "--abbrev-ref", "HEAD"], root, Math.min(1_000, Math.max(100, remaining()))));
    roots.set(root, { path: root, branch, changedFiles: status.split("\n").filter((line) => line.trim()).length });
  }
  return { repositories: [...roots.values()].filter(Boolean), timedOut };
}
