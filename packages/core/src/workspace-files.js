import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { isAdminPrincipal, policyError } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

function uniqueResolvedPaths(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

async function directoryExists(candidate) {
  return Boolean(await fs.stat(candidate).then((stats) => stats.isDirectory()).catch(() => false));
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function insideAnyRoot(candidate, roots = []) {
  return roots.some((root) => pathInside(root.path || root, candidate));
}

function ownerUserIdForPrincipal(principal = {}, env = process.env) {
  if (isAdminPrincipal(principal)) return normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  return normalizeUserId(principal?.userId || "");
}

export function workspacePrincipalForOwner(principal = {}, ownerUserId = "", env = process.env) {
  const owner = normalizeUserId(ownerUserId || "");
  const adminId = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  if (isAdminPrincipal(principal) && owner && owner !== adminId) {
    return {
      kind: "user",
      userId: owner,
      role: "user",
      source: "owner-scope",
      displayName: owner,
    };
  }
  return principal;
}

async function ensureUserRoots(userId, env = process.env) {
  await ensureDataDirs(env);
  const paths = userDataPaths(userId, env);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.files, { recursive: true });
  await fs.mkdir(paths.workspaces, { recursive: true });
  return paths;
}

function defaultRuntimeWorkspaceRoot(paths, env = process.env) {
  return path.resolve(String(env.ORKESTR_RUNTIME_WORKSPACE_ROOT || env.ORKESTR_CLONE_ROOT || paths.workspaces).trim());
}

function rootLabel(root, pathsHome, env = process.env) {
  if (root === path.join(pathsHome, "files")) return "Orkestr files";
  if (root === path.join(pathsHome, "workspaces")) return "Orkestr workspaces";
  if (root === env.ORKESTR_RUNTIME_WORKSPACE_ROOT) return "Runtime workspace root";
  if (root === env.ORKESTR_CLONE_ROOT) return "Clone root";
  if (root === process.cwd()) return "Orkestr checkout";
  if (root === path.dirname(process.cwd())) return "Checkout parent";
  return root;
}

export async function workspaceRootForPrincipal(principal = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) {
    const userId = ownerUserIdForPrincipal(principal, env);
    if (!userId) throw policyError("workspace_owner_required", 403);
    return (await ensureUserRoots(userId, env)).workspaces;
  }
  const paths = await ensureDataDirs(env);
  await fs.mkdir(paths.workspaces, { recursive: true });
  return defaultRuntimeWorkspaceRoot(paths, env);
}

export async function workspaceFolderRootsForPrincipal(principal = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) {
    const userId = ownerUserIdForPrincipal(principal, env);
    if (!userId) throw policyError("workspace_owner_required", 403);
    const paths = await ensureUserRoots(userId, env);
    return [{ name: "My workspaces", path: paths.workspaces }];
  }

  const paths = await ensureDataDirs(env);
  const candidates = uniqueResolvedPaths([
    env.ORKESTR_RUNTIME_WORKSPACE_ROOT || "",
    env.ORKESTR_CLONE_ROOT || "",
    paths.workspaces,
    "/workspace",
    "/workspaces",
    path.dirname(process.cwd()),
    process.cwd(),
  ]);
  const roots = [];
  for (const candidate of candidates) {
    if (await directoryExists(candidate)) roots.push({ name: rootLabel(candidate, paths.home, env), path: candidate });
  }
  return roots.length ? roots : [{ name: "Orkestr workspaces", path: paths.workspaces }];
}

export async function fileBrowserRootsForPrincipal(principal = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) {
    const userId = ownerUserIdForPrincipal(principal, env);
    if (!userId) throw policyError("file_owner_required", 403);
    const paths = await ensureUserRoots(userId, env);
    return [
      { name: "My files", path: paths.files },
      { name: "My workspaces", path: paths.workspaces },
    ];
  }

  const paths = await ensureDataDirs(env);
  await fs.mkdir(paths.files, { recursive: true });
  const candidates = uniqueResolvedPaths([
    paths.files,
    env.ORKESTR_RUNTIME_WORKSPACE_ROOT || "",
    env.ORKESTR_CLONE_ROOT || "",
    paths.workspaces,
  ]);
  const roots = [];
  for (const candidate of candidates) {
    if (await directoryExists(candidate)) roots.push({ name: rootLabel(candidate, paths.home, env), path: candidate });
  }
  return roots.length ? roots : [{ name: "Orkestr files", path: paths.files }];
}

export async function assertWorkspacePathForPrincipal(candidate, principal = {}, env = process.env) {
  const resolved = path.resolve(String(candidate || ""));
  if (isAdminPrincipal(principal)) return resolved;
  const roots = await workspaceFolderRootsForPrincipal(principal, env);
  if (insideAnyRoot(resolved, roots)) return resolved;
  throw policyError("workspace_path_forbidden", 403);
}

export async function resolveWorkspacePathForPrincipal(value, principal = {}, env = process.env, baseRoot = "") {
  const root = path.resolve(baseRoot || await workspaceRootForPrincipal(principal, env));
  const requested = String(value || "").trim();
  const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested));
  return assertWorkspacePathForPrincipal(resolved, principal, env);
}

function safeParent(currentPath, roots = []) {
  const parent = path.dirname(currentPath);
  if (!parent || parent === currentPath) return null;
  return insideAnyRoot(parent, roots) ? parent : null;
}

async function directoryEntries(currentPath, { directoriesOnly = false } = {}) {
  const rows = await fs.readdir(currentPath, { withFileTypes: true });
  const entries = [];
  for (const entry of rows) {
    if (directoriesOnly && !entry.isDirectory()) continue;
    const entryPath = path.join(currentPath, entry.name);
    const stats = await fs.stat(entryPath).catch(() => null);
    entries.push({
      name: entry.name,
      path: entryPath,
      type: entry.isDirectory() ? "directory" : "file",
      directory: entry.isDirectory(),
      hidden: entry.name.startsWith("."),
      size: stats?.isFile() ? stats.size : null,
      modifiedAt: stats?.mtime ? stats.mtime.toISOString() : null,
    });
  }
  return entries
    .sort((left, right) =>
      Number(left.hidden) - Number(right.hidden) ||
      Number(right.directory) - Number(left.directory) ||
      left.name.localeCompare(right.name)
    )
    .slice(0, 200);
}

export async function listWorkspaceFoldersForPrincipal(rawPath = "", principal = {}, env = process.env) {
  const roots = await workspaceFolderRootsForPrincipal(principal, env);
  const requestedPath = String(rawPath || "").trim();
  const currentPath = path.resolve(requestedPath || roots[0]?.path || await workspaceRootForPrincipal(principal, env));
  if (!insideAnyRoot(currentPath, roots)) {
    return { ok: false, error: "workspace_path_forbidden", path: currentPath, parent: null, roots, entries: [] };
  }
  if (!(await directoryExists(currentPath))) {
    return { ok: false, error: "directory_not_found", path: currentPath, parent: safeParent(currentPath, roots), roots, entries: [] };
  }

  try {
    const entries = await directoryEntries(currentPath, { directoriesOnly: true });
    return { ok: true, error: "", path: currentPath, parent: safeParent(currentPath, roots), roots, entries };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "directory_unreadable"),
      path: currentPath,
      parent: safeParent(currentPath, roots),
      roots,
      entries: [],
    };
  }
}

export async function listFilesForPrincipal(rawPath = "", principal = {}, env = process.env) {
  const roots = await fileBrowserRootsForPrincipal(principal, env);
  const requestedPath = String(rawPath || "").trim();
  const currentPath = path.resolve(requestedPath || roots[0]?.path || dataPaths(env).files);
  if (!insideAnyRoot(currentPath, roots)) {
    return { ok: false, error: "file_path_forbidden", path: currentPath, parent: null, roots, entries: [] };
  }
  if (!(await directoryExists(currentPath))) {
    return { ok: false, error: "directory_not_found", path: currentPath, parent: safeParent(currentPath, roots), roots, entries: [] };
  }

  try {
    const entries = await directoryEntries(currentPath);
    return { ok: true, error: "", path: currentPath, parent: safeParent(currentPath, roots), roots, entries };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "directory_unreadable"),
      path: currentPath,
      parent: safeParent(currentPath, roots),
      roots,
      entries: [],
    };
  }
}
