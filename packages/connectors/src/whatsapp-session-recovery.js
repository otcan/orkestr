// Recovery helpers for the local WhatsApp bridge's Chrome profile.
import fs from "node:fs/promises";
import os from "node:os";

// Chrome's SingletonLock is a symlink to "<hostname>-<pid>". A lock written
// by another host (for example a previous Docker container on the same data
// volume) is stale even when a process with that pid exists here: containers
// reuse low pids, and Chrome then refuses to start ("Target closed").
export async function chromeLockHost(filePath) {
  const stats = await fs.lstat(filePath).catch(() => null);
  if (!stats?.isSymbolicLink()) return "";
  const target = String(await fs.readlink(filePath).catch(() => ""));
  const dash = target.lastIndexOf("-");
  return dash > 0 && /^\d+$/.test(target.slice(dash + 1)) ? target.slice(0, dash) : "";
}

export function chromeLockFromOtherHost(host = "", hostname = os.hostname()) {
  return Boolean(host) && host !== hostname;
}

// After WhatsApp verified a logout, the saved session can only fail again.
// Move it aside (keeping the last one) so the next start shows a fresh QR.
export async function retireLoggedOutSession(sessionDir = "") {
  if (!sessionDir) return "";
  const stats = await fs.stat(sessionDir).catch(() => null);
  if (!stats?.isDirectory()) return "";
  const destination = `${sessionDir}.logged-out`;
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(sessionDir, destination);
  return destination;
}
