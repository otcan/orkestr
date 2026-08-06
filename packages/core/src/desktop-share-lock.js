import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const queues = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(filePath, { timeoutMs = 5_000, staleMs = 30_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        const moved = await fs.rename(lockPath, stalePath).then(() => true, () => false);
        if (moved) await fs.rm(stalePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const lockError = new Error("desktop_share_store_locked");
        lockError.statusCode = 503;
        throw lockError;
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

export async function withDesktopShareLock(filePath, operation) {
  const previous = queues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const release = await acquireFileLock(filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  queues.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}
