// Operator-configured retention inside the existing lease mutation gate.
// Complete history is archived durably before released records leave hot state.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { leaseStoreError } from "./desktop-lease-lock.js";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function normalizeLeaseHistoryRetention(value) {
  if (value === undefined || value === null) return null;
  const { archiveDir, keepReleased = 500, threshold = 1800 } = value;
  if (typeof archiveDir !== "string" || !path.isAbsolute(archiveDir)
      || !Number.isSafeInteger(keepReleased) || keepReleased < 1 || keepReleased > 1000
      || !Number.isSafeInteger(threshold) || threshold <= keepReleased || threshold > 2000)
    throw leaseStoreError("desktop_lease_history_config_invalid");
  return Object.freeze({ archiveDir: path.resolve(archiveDir), keepReleased, threshold });
}

export async function retainLeaseHistory(state, policy) {
  if (!policy || state.desktopLeases.length < policy.threshold) return;
  const retired = new Set(state.legacyRetiredCohort?.retiredIds || []);
  const candidates = state.desktopLeases.filter(row => row.releasedAt && !retired.has(row.id));
  if (candidates.length <= policy.keepReleased) return;
  candidates.sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt) || a.id.localeCompare(b.id));
  const retained = new Set(candidates.slice(0, policy.keepReleased).map(row => row.id));
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`), digest = sha(bytes);
  const directory = policy.archiveDir;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
      || info.mode & 0o077 || await fs.realpath(directory) !== directory)
    throw leaseStoreError("desktop_lease_history_archive_refused");
  const target = path.join(directory, `${digest}.json`);
  let file;
  try {
    file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    await file.writeFile(bytes); await file.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.lstat(target);
    if (!existing.isFile() || existing.nlink !== 1 || existing.uid !== process.getuid()
        || existing.mode & 0o277 || sha(await fs.readFile(target)) !== digest)
      throw leaseStoreError("desktop_lease_history_archive_invalid");
  } finally { await file?.close(); }
  const dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
  if (sha(await fs.readFile(target)) !== digest) throw leaseStoreError("desktop_lease_history_archive_invalid");
  // Preserve active authority, adopted payloads, counter and persistent lock identity.
  state.desktopLeases = state.desktopLeases.filter(row => !row.releasedAt || retired.has(row.id) || retained.has(row.id));
}
