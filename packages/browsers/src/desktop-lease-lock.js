// Linux local-filesystem gate. The Node-owned FD, not a helper PID or mtime,
// retains flock ownership. Never unlink this persistent lock inode.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const INITIALIZED = "desktop-lease-lock-v1\n";
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n]);

export function leaseStoreError(code, statusCode = 503) {
  return Object.assign(new Error(code), { statusCode });
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export async function withDesktopLeaseLock(filePath, timeoutMs, operation) {
  if (process.platform !== "linux") throw leaseStoreError("desktop_lease_lock_unsupported");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw leaseStoreError("desktop_lease_lock_timeout_invalid");
  }
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  const parent = await fs.realpath(path.dirname(path.resolve(filePath)));
  const parentStat = await fs.stat(parent, { bigint: true });
  if (!LOCAL_FILESYSTEMS.has((await fs.statfs(parent, { bigint: true })).type)) {
    throw leaseStoreError("desktop_lease_lock_filesystem_unsupported");
  }
  const canonicalFile = path.join(parent, path.basename(filePath));
  const lockPath = `${canonicalFile}.lock`;
  let lock;
  try {
    // A legacy mkdir lock, symlink, or special file is an operator migration
    // requirement, never evidence that an old writer can be displaced.
    lock = await fs.open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch {
    throw leaseStoreError("desktop_lease_lock_path_invalid");
  }
  try {
    const stat = await lock.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw leaseStoreError("desktop_lease_lock_path_invalid");
    const expected = identity(stat);
    const assertCurrent = async () => {
      const [current, directory] = await Promise.all([
        fs.lstat(lockPath, { bigint: true }), fs.stat(parent, { bigint: true }),
      ]);
      if (!current.isFile() || current.nlink !== 1n || identity(current) !== expected || identity(directory) !== identity(parentStat)) {
        throw leaseStoreError("desktop_lease_lock_identity_changed");
      }
    };
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (performance.now() >= deadline) throw leaseStoreError("desktop_lease_store_locked");
      // util-linux flock acts on inherited FD 3 and exits immediately. Both FDs
      // share the open file description, so Node retains the kernel lock after
      // helper exit. No shell, command execution under flock, or inherited env.
      const child = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
        stdio: ["ignore", "ignore", "pipe", lock.fd], env: { LANG: "C" },
        timeout: 1000, killSignal: "SIGKILL", maxBuffer: 4096,
      });
      if (child.error || child.signal || ![0, 75].includes(child.status)) {
        throw leaseStoreError("desktop_lease_lock_unavailable");
      }
      if (child.status === 0 && performance.now() < deadline) break;
      if (performance.now() >= deadline) throw leaseStoreError("desktop_lease_store_locked");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assertCurrent();
    const markerStat = await lock.stat();
    if (![0, Buffer.byteLength(INITIALIZED)].includes(markerStat.size)) {
      throw leaseStoreError("desktop_lease_lock_marker_invalid");
    }
    const marker = Buffer.alloc(Buffer.byteLength(INITIALIZED));
    const { bytesRead } = await lock.read(marker, 0, marker.length, 0);
    if (bytesRead && marker.toString("utf8", 0, bytesRead) !== INITIALIZED) {
      throw leaseStoreError("desktop_lease_lock_marker_invalid");
    }
    return await operation({
      filePath: canonicalFile, identity: expected, initialized: bytesRead > 0, assertCurrent,
      async markInitialized() {
        await assertCurrent();
        const { bytesWritten } = await lock.write(INITIALIZED, 0, "utf8");
        if (bytesWritten !== Buffer.byteLength(INITIALIZED)) throw leaseStoreError("desktop_lease_lock_marker_invalid");
        await lock.sync();
      },
    });
  } finally {
    // Closing the only surviving copy releases ownership on success/error.
    // Kernel close also releases it if the Node process is killed.
    await lock.close();
  }
}
