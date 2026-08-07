import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownerPrefix = "owner-";
const ownerSuffix = ".json";

function clean(value = "") {
  return String(value || "").trim();
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockWaitMs(env = process.env, options = {}) {
  return clampInteger(
    options.waitMs ?? env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_LOCK_WAIT_MS,
    5_000,
    100,
    60_000,
  );
}

function lockRetryMs(env = process.env, options = {}) {
  return clampInteger(
    options.retryMs ?? env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_LOCK_RETRY_MS,
    25,
    5,
    1_000,
  );
}

function lockStaleMs(env = process.env, options = {}) {
  return clampInteger(
    options.staleMs ?? env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_LOCK_STALE_MS,
    30_000,
    1_000,
    10 * 60_000,
  );
}

function tokenFilePart(token = "") {
  return clean(token).replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 160) || "unknown";
}

export function sidecarLockPath(filePath = "") {
  const resolved = clean(filePath);
  if (!resolved) throw new Error("lock_file_path_required");
  return `${resolved}.lock`;
}

export function sidecarLockOwnerPath(lockPath = "", token = "") {
  const resolved = clean(lockPath);
  if (!resolved) throw new Error("lock_path_required");
  return path.join(resolved, `${ownerPrefix}${tokenFilePart(token)}${ownerSuffix}`);
}

async function bootId() {
  return clean(await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => ""));
}

async function processStartTicks(pid = process.pid) {
  const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (!raw) return "";
  const closeParen = raw.lastIndexOf(")");
  if (closeParen < 0) return "";
  const fieldsAfterCommand = raw.slice(closeParen + 1).trim().split(/\s+/);
  return clean(fieldsAfterCommand[19]);
}

async function currentOwnerMetadata(token = "") {
  return {
    version: 2,
    token: clean(token),
    pid: process.pid,
    processStartTicks: await processStartTicks(process.pid),
    bootId: await bootId(),
    hostname: os.hostname(),
    acquiredAtMs: Date.now(),
    acquiredAt: new Date().toISOString(),
  };
}

async function readOwnerSnapshot(lockPath = "") {
  const dirStat = await fs.stat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!dirStat) return { state: "missing" };
  if (!dirStat.isDirectory()) return { state: "unknown", reason: "not_directory", dirStat };
  const entries = await fs.readdir(lockPath, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const owners = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(ownerPrefix) && entry.name.endsWith(ownerSuffix))
    .map((entry) => entry.name);
  if (!owners.length) return { state: "empty", dirStat };
  if (owners.length !== 1) return { state: "unknown", reason: "multiple_owners", dirStat };
  const ownerFileName = owners[0];
  const ownerPath = path.join(lockPath, ownerFileName);
  const [ownerStat, raw] = await Promise.all([
    fs.stat(ownerPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
    fs.readFile(ownerPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    }),
  ]);
  if (!ownerStat || !raw) return { state: "missing" };
  try {
    const owner = JSON.parse(raw);
    if (!clean(owner?.token)) return { state: "unknown", reason: "missing_owner_token", dirStat, ownerStat };
    return { state: "owner", dirStat, ownerStat, owner, ownerPath, ownerFileName };
  } catch {
    return { state: "unknown", reason: "invalid_owner_json", dirStat, ownerStat };
  }
}

function snapshotStale(snapshot = {}, staleMs = 30_000) {
  const stat = snapshot.ownerStat || snapshot.dirStat;
  return Boolean(stat?.mtimeMs) && Date.now() - stat.mtimeMs >= staleMs;
}

async function ownerLiveness(owner = {}) {
  const ownerHost = clean(owner.hostname);
  if (ownerHost && ownerHost !== os.hostname()) return { live: null, reason: "different_host" };
  const localBootId = await bootId();
  const ownerBootId = clean(owner.bootId);
  if (ownerBootId && localBootId && ownerBootId !== localBootId) return { live: false, reason: "old_boot" };
  if (ownerBootId && !localBootId) return { live: null, reason: "boot_id_unavailable" };
  const pid = Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { live: null, reason: "missing_pid" };
  const ownerStart = clean(owner.processStartTicks);
  if (!ownerStart) return { live: null, reason: "missing_process_start_identity" };
  const currentStart = await processStartTicks(pid).catch(() => null);
  if (currentStart === "") return { live: false, reason: "pid_not_running" };
  if (!currentStart) return { live: null, reason: "process_liveness_uncertain" };
  return currentStart === ownerStart
    ? { live: true, reason: "pid_start_identity_live" }
    : { live: false, reason: "pid_reused_or_exited" };
}

async function rmdirIfEmpty(lockPath = "") {
  try {
    await fs.rmdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (["ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }
}

async function removeStaleLock(lockPath, staleMs, options = {}) {
  const snapshot = await readOwnerSnapshot(lockPath);
  if (snapshot.state === "missing") return true;
  if (!snapshotStale(snapshot, staleMs)) return false;
  if (snapshot.state === "empty") {
    await options.hooks?.beforeStaleOwnerUnlink?.({ lockPath, owner: null, ownerPath: "" });
    return rmdirIfEmpty(lockPath);
  }
  if (snapshot.state !== "owner") return false;
  const liveness = await ownerLiveness(snapshot.owner);
  if (liveness.live !== false) return false;
  await options.hooks?.beforeStaleOwnerUnlink?.({
    lockPath,
    owner: snapshot.owner,
    ownerPath: snapshot.ownerPath,
    liveness,
  });
  await fs.unlink(snapshot.ownerPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return rmdirIfEmpty(lockPath);
}

export async function acquireFileLock(filePath = "", env = process.env, options = {}) {
  const resolved = clean(filePath);
  if (!resolved) throw new Error("lock_file_path_required");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const lockPath = sidecarLockPath(resolved);
  const token = clean(options.token) || crypto.randomUUID();
  const ownerPath = sidecarLockOwnerPath(lockPath, token);
  const deadline = Date.now() + lockWaitMs(env, options);
  const retryMs = lockRetryMs(env, options);
  const staleMs = lockStaleMs(env, options);

  for (;;) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(ownerPath, JSON.stringify(await currentOwnerMetadata(token)), { flag: "wx" });
      let released = false;
      return {
        lockPath,
        ownerPath,
        token,
        async release() {
          if (released) return;
          released = true;
          await options.hooks?.beforeReleaseOwnerUnlink?.({ lockPath, ownerPath, token });
          await fs.unlink(ownerPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          await rmdirIfEmpty(lockPath);
        },
      };
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error?.code)) throw error;
      if (error?.code === "EEXIST") await removeStaleLock(lockPath, staleMs, options);
      if (Date.now() >= deadline) {
        const timeout = new Error("transformed_media_echo_ledger_lock_timeout");
        timeout.code = "TRANSFORMED_MEDIA_ECHO_LEDGER_LOCK_TIMEOUT";
        throw timeout;
      }
      await sleep(retryMs + Math.floor(Math.random() * retryMs));
    }
  }
}

export async function withFileLock(filePath = "", env = process.env, work = async () => undefined) {
  const lock = await acquireFileLock(filePath, env);
  try {
    return await work(filePath);
  } finally {
    await lock.release();
  }
}
