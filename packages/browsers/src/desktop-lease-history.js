// Operator-configured retention inside the existing lease mutation gate.
// Complete history is archived durably before released records leave hot state.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

async function pinnedDirectory(directory, io) {
  const ancestors = [], uid = process.getuid();
  for (let cursor = directory;; cursor = path.dirname(cursor)) {
    const info = await io.lstat(cursor, {bigint:true});
    const stickyRoot = ["/tmp", "/var/tmp"].includes(cursor) && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    if (!info.isDirectory() || info.isSymbolicLink() || ![0n,BigInt(uid)].includes(info.uid)
        || ((info.mode & 0o022n) !== 0n && !stickyRoot))
      throw leaseStoreError("desktop_lease_history_archive_refused");
    ancestors.push({cursor, dev:info.dev, ino:info.ino});
    if (cursor === path.dirname(cursor)) break;
  }
  const dir = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const assertCurrent = async () => {
    for (const item of ancestors) {
      const current = await io.lstat(item.cursor, {bigint:true});
      const stickyRoot = ["/tmp", "/var/tmp"].includes(item.cursor) && current.uid === 0n && (current.mode & 0o1000n) !== 0n;
      if (current.dev !== item.dev || current.ino !== item.ino || !current.isDirectory()
          || current.isSymbolicLink() || ![0n,BigInt(uid)].includes(current.uid)
          || ((current.mode & 0o022n) !== 0n && !stickyRoot))
        throw leaseStoreError("desktop_lease_history_archive_changed");
    }
    const current = await dir.stat({bigint:true});
    if (current.dev !== ancestors[0].dev || current.ino !== ancestors[0].ino
        || current.uid !== BigInt(uid) || (current.mode & 0o777n) !== 0o700n)
      throw leaseStoreError("desktop_lease_history_archive_refused");
  };
  try { await assertCurrent(); } catch (error) { await dir.close(); throw error; }
  return {dir, assertCurrent, prefix:`/proc/self/fd/${dir.fd}`};
}

// The injected I/O seam allows partial-write and custody-race failure tests.
export async function retainLeaseHistory(state, policy, io = fs) {
  if (!policy || state.desktopLeases.length < policy.threshold) return;
  const retired = new Set(state.legacyRetiredCohort?.retiredIds || []);
  const candidates = state.desktopLeases.filter(row => row.releasedAt && !retired.has(row.id));
  if (candidates.length <= policy.keepReleased) return;
  candidates.sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt) || a.id.localeCompare(b.id));
  const retained = new Set(candidates.slice(0, policy.keepReleased).map(row => row.id));
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`), digest = sha(bytes);
  const directory = policy.archiveDir;
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const custody = await pinnedDirectory(directory, io);
  const target = `${custody.prefix}/${digest}.json`;
  const temporary = `${custody.prefix}/.pending-${process.pid}-${randomUUID()}`;
  let file, created = false;
  try {
    file = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    created = true;
    await file.writeFile(bytes); await file.sync();
    await file.close(); file = null;
    if (sha(await io.readFile(temporary)) !== digest) throw leaseStoreError("desktop_lease_history_archive_invalid");
    await custody.assertCurrent();
    // link is atomic and refuses an existing digest name; incomplete staging
    // files never occupy a final name or poison future retries.
    try { await io.link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await io.unlink(temporary); created = false;
    const final = await io.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await final.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
          || (info.mode & 0o777) !== 0o400 || sha(await final.readFile()) !== digest)
        throw leaseStoreError("desktop_lease_history_archive_invalid");
    } finally { await final.close(); }
    await custody.dir.sync();
    await custody.assertCurrent();
  } finally {
    await file?.close();
    if (created) await io.unlink(temporary).catch(() => {});
    await custody.dir.close();
  }
  // Preserve active authority, adopted payloads, counter and persistent lock identity.
  state.desktopLeases = state.desktopLeases.filter(row => !row.releasedAt || retired.has(row.id) || retained.has(row.id));
}
