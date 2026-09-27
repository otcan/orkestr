import fs, { constants } from "node:fs/promises";
import path from "node:path";

export function specialFile(stats) {
  return stats.isSymbolicLink() || stats.isBlockDevice() || stats.isCharacterDevice() || stats.isFIFO() || stats.isSocket();
}

export function containmentError(code, statusCode = 403) {
  return Object.assign(new Error(code), { statusCode, code });
}

export function sanitizeRelativeSegments(rawRelativePath = "", { errorPrefix = "path" } = {}) {
  const raw = String(rawRelativePath || "").trim().replaceAll("\\", "/");
  if (!raw) return [];
  if (raw.includes("\0") || path.posix.isAbsolute(raw)) throw containmentError(`${errorPrefix}_invalid`, 400);
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw containmentError(`${errorPrefix}_forbidden`, 403);
  return segments;
}

export async function resolveContainmentRoot(rootPath, { errorPrefix = "path" } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  const rootStats = await fs.lstat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory() || specialFile(rootStats)) throw containmentError(`${errorPrefix}_root_unavailable`, 503);
  return fs.realpath(resolvedRoot);
}

/**
 * Walks a relative path one real segment at a time from a pinned real root,
 * rejecting symlinks/special files/hard-linked regular files at every
 * traversed component. This is the sole containment primitive shared by
 * every scoped-file surface (legacy /api/files, /api/system/files, and
 * /api/instance/files) so they fail closed identically.
 */
export async function resolveContainedPath(realRoot, rawRelativePath = "", { allowMissingLeaf = false, errorPrefix = "path" } = {}) {
  const segments = sanitizeRelativeSegments(rawRelativePath, { errorPrefix });
  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) {
      if (allowMissingLeaf && index === segments.length - 1) {
        return { absolutePath: current, relativePath: segments.join("/"), stats: null };
      }
      throw containmentError(`${errorPrefix}_not_found`, 404);
    }
    if (specialFile(stats)) throw containmentError(`${errorPrefix}_special_type_forbidden`, 403);
    if (stats.isFile() && stats.nlink > 1) throw containmentError(`${errorPrefix}_hard_link_forbidden`, 403);
    if (index < segments.length - 1 && !stats.isDirectory()) throw containmentError(`${errorPrefix}_not_directory`, 400);
  }
  const real = segments.length === 0 ? realRoot : await fs.realpath(current);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw containmentError(`${errorPrefix}_forbidden`, 403);
  const stats = segments.length === 0 ? await fs.lstat(realRoot) : await fs.lstat(real);
  return { absolutePath: real, relativePath: segments.join("/"), stats };
}

export function openContainedFileNoFollow(absolutePath) {
  return fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
}

export function createContainedFileExclusive(absolutePath, mode = 0o600) {
  return fs.open(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
}

/**
 * Opens an existing-or-new leaf for a contained overwrite: O_NOFOLLOW makes
 * the open fail (ELOOP) instead of writing through a symlink, and the
 * caller must verify the descriptor's nlink before truncating so a
 * pre-existing hard link is never overwritten in place.
 */
export async function openContainedFileForOverwrite(absolutePath, mode = 0o600, { errorPrefix = "path" } = {}) {
  try {
    return await fs.open(absolutePath, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), mode);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw containmentError(`${errorPrefix}_special_type_forbidden`, 403);
    throw error;
  }
}
