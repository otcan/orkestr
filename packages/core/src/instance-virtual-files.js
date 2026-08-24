import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { fileBrowserRootsForPrincipal } from "./workspace-files.js";

const PREVIEW_MAX_BYTES = 512 * 1024;
const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const ENTRY_LIMIT = 500;
const FORBIDDEN_NAMES = new Set([
  ".git", ".ssh", ".gnupg", ".aws", ".npmrc", ".pypirc", ".netrc",
  "credentials.json", "service-account.json", "secrets",
]);

function vfsError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode, code });
}

function clean(value = "") {
  return String(value || "").trim();
}

function forbiddenName(value = "") {
  const name = clean(value).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || FORBIDDEN_NAMES.has(name) || name.endsWith(".pem") || name.endsWith(".key");
}

function relativePath(value = "") {
  const raw = clean(value).replaceAll("\\", "/");
  if (!raw) return "";
  if (raw.includes("\0") || path.posix.isAbsolute(raw)) throw vfsError("instance_file_path_invalid");
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw vfsError("instance_file_path_forbidden", 403);
  if (segments.some(forbiddenName)) throw vfsError("instance_file_sensitive_path_forbidden", 403);
  return segments.join("/");
}

function specialFile(stats) {
  return stats.isSymbolicLink() || stats.isBlockDevice() || stats.isCharacterDevice() || stats.isFIFO() || stats.isSocket();
}

function mountId(index, root = {}) {
  const label = clean(root.name).toLowerCase();
  if (index === 0 && label.includes("file")) return "files";
  if (label.includes("workspace")) return index === 0 ? "workspaces" : `workspaces-${index}`;
  return `root-${index + 1}`;
}

async function mountsForPrincipal(principal = {}, env = process.env) {
  const roots = await fileBrowserRootsForPrincipal(principal, env);
  return roots.map((root, index) => ({
    id: mountId(index, root),
    name: clean(root.name) || `Files ${index + 1}`,
    rootPath: path.resolve(root.path),
    permissions: { read: true, upload: true, createFolder: true, delete: false },
  }));
}

async function resolveMount(id, principal = {}, env = process.env) {
  const mounts = await mountsForPrincipal(principal, env);
  const requested = clean(id) || mounts[0]?.id || "";
  const mount = mounts.find((entry) => entry.id === requested);
  if (!mount) throw vfsError("instance_file_mount_not_found", 404);
  const rootStats = await fs.lstat(mount.rootPath).catch(() => null);
  if (!rootStats?.isDirectory() || specialFile(rootStats)) throw vfsError("instance_file_mount_unavailable", 503);
  const realRoot = await fs.realpath(mount.rootPath);
  return { ...mount, realRoot, mounts };
}

async function resolveContainedPath(mount, rawRelativePath = "", { allowMissingLeaf = false } = {}) {
  const relative = relativePath(rawRelativePath);
  const segments = relative ? relative.split("/") : [];
  let current = mount.realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) {
      if (allowMissingLeaf && index === segments.length - 1) return { absolutePath: current, relativePath: relative, stats: null };
      throw vfsError("instance_file_not_found", 404);
    }
    if (specialFile(stats)) throw vfsError("instance_file_special_type_forbidden", 403);
    if (stats.isFile() && stats.nlink > 1) throw vfsError("instance_file_hard_link_forbidden", 403);
    if (index < segments.length - 1 && !stats.isDirectory()) throw vfsError("instance_file_not_directory", 400);
  }
  const real = await fs.realpath(current);
  const rel = path.relative(mount.realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw vfsError("instance_file_path_forbidden", 403);
  return { absolutePath: real, relativePath: relative, stats: await fs.lstat(real) };
}

function publicMount(mount) {
  return { id: mount.id, name: mount.name, permissions: mount.permissions };
}

function joinRelative(parent, name) {
  return [relativePath(parent), name].filter(Boolean).join("/");
}

function mimeType(name = "") {
  const extension = path.extname(name).toLowerCase();
  return new Map([
    [".txt", "text/plain; charset=utf-8"], [".md", "text/markdown; charset=utf-8"],
    [".json", "application/json; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"], [".ts", "text/plain; charset=utf-8"],
    [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
    [".yaml", "text/yaml; charset=utf-8"], [".yml", "text/yaml; charset=utf-8"],
    [".csv", "text/csv; charset=utf-8"], [".pdf", "application/pdf"],
    [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  ]).get(extension) || "application/octet-stream";
}

export async function listInstanceFiles({ mountId: requestedMount = "", path: requestedPath = "" } = {}, principal = {}, env = process.env) {
  const mount = await resolveMount(requestedMount, principal, env);
  const resolved = await resolveContainedPath(mount, requestedPath);
  if (!resolved.stats.isDirectory()) throw vfsError("instance_file_not_directory", 400);
  const rows = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  const entries = [];
  for (const entry of rows) {
    if (forbiddenName(entry.name)) continue;
    const absolutePath = path.join(resolved.absolutePath, entry.name);
    const stats = await fs.lstat(absolutePath).catch(() => null);
    if (!stats || specialFile(stats) || (stats.isFile() && stats.nlink > 1)) continue;
    entries.push({
      name: entry.name,
      path: joinRelative(resolved.relativePath, entry.name),
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "unsupported",
      directory: stats.isDirectory(),
      hidden: entry.name.startsWith("."),
      size: stats.isFile() ? stats.size : null,
      modifiedAt: stats.mtime.toISOString(),
      previewable: stats.isFile() && stats.size <= PREVIEW_MAX_BYTES,
      downloadable: stats.isFile() && stats.size <= DOWNLOAD_MAX_BYTES,
    });
  }
  entries.sort((left, right) => Number(left.hidden) - Number(right.hidden) || Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
  const relative = resolved.relativePath;
  return {
    ok: true,
    mount: publicMount(mount),
    mounts: mount.mounts.map(publicMount),
    path: relative,
    parent: relative ? relative.split("/").slice(0, -1).join("/") : null,
    entries: entries.slice(0, ENTRY_LIMIT),
    truncated: entries.length > ENTRY_LIMIT,
  };
}

async function readRegularFile(mount, requestedPath, maxBytes) {
  const resolved = await resolveContainedPath(mount, requestedPath);
  if (!resolved.stats.isFile()) throw vfsError("instance_file_not_regular", 400);
  if (resolved.stats.size > maxBytes) throw vfsError("instance_file_too_large", 413);
  const handle = await fs.open(resolved.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink > 1) throw vfsError("instance_file_not_regular", 403);
    return { resolved, buffer: await handle.readFile(), stats };
  } finally {
    await handle.close();
  }
}

export async function previewInstanceFile({ mountId: requestedMount = "", path: requestedPath = "" } = {}, principal = {}, env = process.env) {
  const mount = await resolveMount(requestedMount, principal, env);
  const { resolved, buffer, stats } = await readRegularFile(mount, requestedPath, PREVIEW_MAX_BYTES);
  if (buffer.includes(0)) throw vfsError("instance_file_preview_binary", 415);
  return {
    ok: true,
    mount: publicMount(mount),
    path: resolved.relativePath,
    name: path.basename(resolved.relativePath),
    size: stats.size,
    contentType: mimeType(resolved.relativePath),
    content: buffer.toString("utf8"),
  };
}

export async function downloadInstanceFile({ mountId: requestedMount = "", path: requestedPath = "" } = {}, principal = {}, env = process.env) {
  const mount = await resolveMount(requestedMount, principal, env);
  const { resolved, buffer, stats } = await readRegularFile(mount, requestedPath, DOWNLOAD_MAX_BYTES);
  return {
    name: path.basename(resolved.relativePath),
    size: stats.size,
    contentType: mimeType(resolved.relativePath),
    buffer,
  };
}

function safeFileName(value = "", fallback = "upload") {
  const name = path.basename(clean(value)).replace(/[^\w .@()+\-=]/g, "_").replace(/^\.+$/, "");
  return name || fallback;
}

async function uniqueTarget(directory, originalName) {
  const parsed = path.parse(safeFileName(originalName));
  for (let index = 0; index < 1000; index += 1) {
    const name = index ? `${parsed.name}-${index}${parsed.ext}` : `${parsed.name}${parsed.ext}`;
    const target = path.join(directory, name);
    const exists = await fs.lstat(target).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
    if (!exists) return { name, target };
  }
  throw vfsError("instance_file_name_exhausted", 409);
}

export async function uploadInstanceFiles({ mountId: requestedMount = "", path: requestedPath = "", files = /** @type {any[]} */ ([]) } = {}, principal = {}, env = process.env) {
  const mount = await resolveMount(requestedMount, principal, env);
  const directory = await resolveContainedPath(mount, requestedPath);
  if (!directory.stats.isDirectory()) throw vfsError("instance_file_not_directory", 400);
  const saved = [];
  for (const [index, file] of Array.from(files).slice(0, 5).entries()) {
    const originalName = file.originalname || file.name || `upload-${index + 1}`;
    if (forbiddenName(path.basename(clean(originalName)))) throw vfsError("instance_file_sensitive_path_forbidden", 403);
    const { name, target } = await uniqueTarget(directory.absolutePath, originalName);
    const buffer = file.buffer || file.data || Buffer.from(String(file.content || ""), "utf8");
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(buffer); } finally { await handle.close(); }
    saved.push({ name, path: joinRelative(directory.relativePath, name), size: Buffer.byteLength(buffer) });
  }
  return { ...(await listInstanceFiles({ mountId: mount.id, path: directory.relativePath }, principal, env)), files: saved };
}

export async function createInstanceFolder({ mountId: requestedMount = "", path: requestedPath = "", name = "" } = {}, principal = {}, env = process.env) {
  const mount = await resolveMount(requestedMount, principal, env);
  const directory = await resolveContainedPath(mount, requestedPath);
  if (!directory.stats.isDirectory()) throw vfsError("instance_file_not_directory", 400);
  const folderName = clean(name);
  if (!folderName) throw vfsError("instance_folder_name_required");
  if (folderName.length > 128 || folderName === "." || folderName === ".." || /[\\/\0]/.test(folderName)) {
    throw vfsError("instance_folder_name_invalid");
  }
  if (forbiddenName(folderName)) throw vfsError("instance_file_sensitive_path_forbidden", 403);
  const target = await resolveContainedPath(mount, joinRelative(directory.relativePath, folderName), { allowMissingLeaf: true });
  if (target.stats) throw vfsError("instance_file_exists", 409);
  await fs.mkdir(target.absolutePath, { mode: 0o700 });
  return listInstanceFiles({ mountId: mount.id, path: directory.relativePath }, principal, env);
}

export const instanceFileLimits = { previewBytes: PREVIEW_MAX_BYTES, downloadBytes: DOWNLOAD_MAX_BYTES, entries: ENTRY_LIMIT };
