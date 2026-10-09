import fs from "node:fs/promises";
import path from "node:path";
import { appHome, dataPaths } from "./paths.js";

// Bounded cleanup of leftovers in ORKESTR_HOME:
// - `.<name>.json.<pid>.<ms>.<hex>.tmp` files left by interrupted writeJsonAtomic
//   calls (store.js), removed once older than the temp max age;
// - `<name>.json.pre-<label>-<YYYYMMDDTHHMMSS><Z|+hhmm>` copies taken before
//   manual migrations/scrubs, keeping only the newest few per source file.
// Only the ORKESTR_HOME root and thread-messages/ are scanned (not recursive),
// only regular files matching these exact patterns are touched, and anything
// whose source is not a .json file (sqlite databases, WAL/SHM files) is kept.
const atomicTempPattern = /^\.(.+\.json)\.\d+\.\d+\.[0-9a-f]+\.tmp$/;
const preBackupPattern = /^(.+\.json)\.pre-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}T\d{6}(?:Z|[+-]\d{4})$/;

export const staleTempMaxAgeMs = 60 * 60 * 1000;
export const preBackupKeepPerFile = 3;
export const preBackupMinAgeMs = 24 * 60 * 60 * 1000;

export function classifyStateFile(name) {
  const temp = atomicTempPattern.exec(name);
  if (temp) return { kind: "temp", source: temp[1] };
  const backup = preBackupPattern.exec(name);
  if (backup) return { kind: "pre-backup", source: backup[1] };
  return null;
}

export async function cleanupStaleStateFiles(env = process.env, options = {}) {
  const now = options.now ?? Date.now();
  const tempMaxAgeMs = options.tempMaxAgeMs ?? staleTempMaxAgeMs;
  const keep = Math.max(1, options.keepPerFile ?? preBackupKeepPerFile);
  const backupMinAgeMs = options.backupMinAgeMs ?? preBackupMinAgeMs;
  const dryRun = Boolean(options.dryRun);
  const directories = [appHome(env), dataPaths(env).threadMessages];
  const removed = [];
  const errors = [];

  for (const directory of directories) {
    const backups = new Map();
    for (const entry of await listFiles(directory)) {
      const match = classifyStateFile(entry.name);
      if (!match) continue;
      const filePath = path.join(directory, entry.name);
      const stat = await fs.lstat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;
      const candidate = { path: filePath, kind: match.kind, size: stat.size, mtimeMs: stat.mtimeMs };
      if (match.kind === "temp") {
        if (now - stat.mtimeMs >= tempMaxAgeMs) await remove(candidate);
        continue;
      }
      const group = backups.get(match.source) || [];
      group.push(candidate);
      backups.set(match.source, group);
    }
    for (const group of backups.values()) {
      group.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const candidate of group.slice(keep)) {
        if (now - candidate.mtimeMs >= backupMinAgeMs) await remove(candidate);
      }
    }
  }

  return {
    dryRun,
    removed,
    errors,
    removedBytes: removed.reduce((sum, item) => sum + item.size, 0),
  };

  async function remove(candidate) {
    if (!dryRun) {
      try {
        await fs.unlink(candidate.path);
      } catch (error) {
        if (error?.code !== "ENOENT") errors.push({ path: candidate.path, code: error?.code || "unlink_failed" });
        return;
      }
    }
    removed.push(candidate);
  }
}

async function listFiles(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile());
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}
