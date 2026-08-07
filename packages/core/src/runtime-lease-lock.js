import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const queues = new Map();
const OWNER_FILE = "owner.json";
const lockContext = new AsyncLocalStorage();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizedTimeoutMs(value, fallback = 10_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function lockTimeoutError() {
  const lockError = new Error("runtime_lease_store_locked");
  lockError.statusCode = 503;
  return lockError;
}

function reentrantLockError() {
  const lockError = new Error("runtime_lease_store_reentrant");
  lockError.statusCode = 500;
  return lockError;
}

function parseLinuxProcessStartIdentity(stat) {
  const text = String(stat || "");
  const commEnd = text.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = text.slice(commEnd + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks || "") ? `linux:${startTicks}` : null;
}

async function readLinuxProcessStartIdentity(pid) {
  const ownerPid = Number(pid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return { state: "malformed", identity: null };
  if (process.platform !== "linux") return { state: "unknown", identity: null };
  try {
    const stat = await fs.readFile(`/proc/${ownerPid}/stat`, "utf8");
    const identity = parseLinuxProcessStartIdentity(stat);
    return identity ? { state: "live", identity } : { state: "unknown", identity: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return { state: "dead", identity: null };
    return { state: "unknown", identity: null };
  }
}

async function currentProcessStartIdentity() {
  const processIdentity = await readLinuxProcessStartIdentity(process.pid);
  return processIdentity.state === "live" ? processIdentity.identity : null;
}

async function readOwnerRecord(lockPath) {
  const file = path.join(lockPath, OWNER_FILE);
  try {
    const raw = await fs.readFile(file, "utf8");
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return { owner: null, ownerStat: null };
    const ownerStat = await fs.stat(file).catch(() => null);
    return { owner, ownerStat };
  } catch {
    return { owner: null, ownerStat: null };
  }
}

async function readOwner(lockPath) {
  return (await readOwnerRecord(lockPath)).owner;
}

async function writeInitialOwner(lockPath, owner) {
  const file = path.join(lockPath, OWNER_FILE);
  const temporary = path.join(lockPath, `owner.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function ownerHeartbeatMs(owner = {}, ownerStat = null, fallbackMs = 0) {
  const mtimeMs = Number(ownerStat?.mtimeMs || 0);
  if (Number.isFinite(mtimeMs) && mtimeMs > 0) return mtimeMs;
  const record = owner && typeof owner === "object" ? owner : {};
  const value = Date.parse(record.heartbeatAt || record.acquiredAt || "");
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

function staleOwner(owner = {}, ownerStat = null, fallbackMs = 0, staleMs = 30_000) {
  const heartbeatMs = ownerHeartbeatMs(owner, ownerStat, fallbackMs);
  return !heartbeatMs || Date.now() - heartbeatMs > staleMs;
}

async function reclaimableOwner(owner = {}, ownerStat = null, fallbackMs = 0, staleMs = 30_000) {
  const record = owner && typeof owner === "object" ? owner : {};
  const pid = Number(record.pid);
  const expectedIdentity = typeof record.processStartIdentity === "string" ? record.processStartIdentity : "";
  if (!Number.isInteger(pid) || pid <= 0) {
    return staleOwner(record, ownerStat, fallbackMs, staleMs);
  }
  const processIdentity = await readLinuxProcessStartIdentity(pid);
  if (!expectedIdentity) return processIdentity.state === "dead";
  if (processIdentity.state === "dead") return true;
  if (processIdentity.state === "unknown") return false;
  return processIdentity.identity !== expectedIdentity;
}

async function restoreStolenLock(stalePath, lockPath) {
  return fs.rename(stalePath, lockPath).then(() => true, () => false);
}

function startHeartbeat(lockPath, ownerHandle, owner, heartbeatMs, heartbeatHook = null) {
  const intervalMs = Number(heartbeatMs || 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  let stopped = false;
  let running = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    void (async () => {
      if (stopped || running) return;
      running = true;
      try {
        await heartbeatHook?.({ phase: "beforeTouch", lockPath, owner });
        const at = new Date();
        await ownerHandle.utimes(at, at);
        await heartbeatHook?.({ phase: "afterTouch", lockPath, owner });
      } catch {
        stop();
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return stop;
}

export async function acquireRuntimeLeaseFileLock(filePath, { timeoutMs = 10_000, staleMs = 30_000, heartbeatMs = 10_000, heartbeatHook = null } = {}) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      const owner = {
        pid: process.pid,
        processStartIdentity: await currentProcessStartIdentity(),
        token: randomUUID(),
        acquiredAt: nowIso(),
        heartbeatAt: nowIso(),
      };
      let ownerHandle = null;
      try {
        await writeInitialOwner(lockPath, owner);
        ownerHandle = await fs.open(path.join(lockPath, OWNER_FILE), "r+");
      } catch (error) {
        await ownerHandle?.close().catch(() => {});
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const stopHeartbeat = startHeartbeat(lockPath, ownerHandle, owner, heartbeatMs, heartbeatHook);
      return async () => {
        stopHeartbeat();
        const current = await readOwner(lockPath);
        if (current?.token === owner.token) {
          await ownerHandle.close().catch(() => {});
          ownerHandle = null;
          await fs.rm(lockPath, { recursive: true, force: true });
        }
        await ownerHandle?.close().catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const [record, stat] = await Promise.all([
        readOwnerRecord(lockPath),
        fs.stat(lockPath).catch(() => null),
      ]);
      const owner = record.owner;
      if (await reclaimableOwner(owner, record.ownerStat, stat?.mtimeMs || 0, staleMs)) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        const moved = await fs.rename(lockPath, stalePath).then(() => true, () => false);
        if (!moved) continue;
        const [stolenRecord, staleStat] = await Promise.all([
          readOwnerRecord(stalePath),
          fs.stat(stalePath).catch(() => null),
        ]);
        const stolenOwner = stolenRecord.owner;
        if (owner?.token && stolenOwner?.token && owner.token !== stolenOwner.token) {
          await restoreStolenLock(stalePath, lockPath);
          continue;
        }
        const stillReclaimable = await reclaimableOwner(
          stolenOwner || owner,
          stolenRecord.ownerStat || record.ownerStat,
          staleStat?.mtimeMs || stat?.mtimeMs || 0,
          staleMs,
        );
        if (!stillReclaimable) {
          await restoreStolenLock(stalePath, lockPath);
          continue;
        }
        await fs.rm(stalePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw lockTimeoutError();
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

export async function withRuntimeLeaseLock(filePath, operation, options = {}) {
  const key = path.resolve(filePath);
  const heldLocks = lockContext.getStore() || new Set();
  if (heldLocks?.has(key)) throw reentrantLockError();
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs, 10_000);
  const deadlineAt = Date.now() + timeoutMs;
  let expired = false;
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      reject(lockTimeoutError());
    }, timeoutMs);
    timeoutId.unref?.();
  });
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    if (expired) return null;
    const release = await acquireRuntimeLeaseFileLock(filePath, {
      ...options,
      timeoutMs: Math.max(0, deadlineAt - Date.now()),
    });
    clearTimeout(timeoutId);
    if (expired) {
      await release();
      return null;
    }
    heldLocks.add(key);
    try {
      return await lockContext.run(heldLocks, operation);
    } finally {
      try {
        await release();
      } finally {
        heldLocks.delete(key);
      }
    }
  });
  queues.set(key, run.then(() => undefined, () => undefined));
  return Promise.race([run, timeout]).finally(() => clearTimeout(timeoutId));
}
