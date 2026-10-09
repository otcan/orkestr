import path from "node:path";
import fs from "node:fs/promises";
import { dataPaths } from "../../storage/src/paths.js";

// After a thread is deleted, remove the default runtime workspace directory
// Orkestr created for it (<workspace root>/<thread id>) when it is effectively
// empty: no entries, or only the Orkestr-generated AGENTS.md. Explicit
// thread cwd/workspace paths and anything with user content are never touched.

const AGENTS_MARKER = "orkestr-runtime-agents-md:";

function safeName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function workspaceRoots(env) {
  const roots = [env.ORKESTR_RUNTIME_WORKSPACE_ROOT, dataPaths(env).workspaces];
  return [...new Set(roots.map((root) => String(root || "").trim()).filter(Boolean).map((root) => path.resolve(root)))];
}

function threadWorkspacePaths(thread = {}, roots = []) {
  const explicit = String(thread.cwd || thread.workspace || thread.executor?.metadata?.cwd || "").trim();
  if (explicit) return roots.map((root) => path.resolve(path.isAbsolute(explicit) ? explicit : path.join(root, explicit)));
  return roots.map((root) => path.join(root, safeName(thread.id)));
}

async function onlyOrkestrEntries(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (!entries.length) return true;
  if (entries.length !== 1 || entries[0].name !== "AGENTS.md" || !entries[0].isFile()) return false;
  const text = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8").catch(() => "");
  return text.includes(AGENTS_MARKER);
}

async function removeIfEffectivelyEmpty(dir) {
  const stats = await fs.lstat(dir).catch(() => null);
  if (!stats?.isDirectory()) return false;
  if (!await onlyOrkestrEntries(dir)) return false;
  await fs.rm(path.join(dir, "AGENTS.md"), { force: true });
  // rmdir is non-recursive: it fails if anything appeared in the meantime.
  return fs.rmdir(dir).then(() => true, () => false);
}

export async function removeEmptyThreadWorkspaces(deletedIds = [], remainingThreads = [], env = process.env) {
  const roots = workspaceRoots(env);
  const inUse = new Set(remainingThreads.flatMap((thread) => threadWorkspacePaths(thread, roots)));
  const removed = [];
  for (const id of deletedIds) {
    const name = safeName(id);
    if (name === "." || name === "..") continue;
    for (const root of roots) {
      const dir = path.join(root, name);
      if (path.dirname(dir) !== root || inUse.has(dir)) continue;
      if (await removeIfEffectivelyEmpty(dir).catch(() => false)) removed.push(dir);
    }
  }
  return removed;
}
