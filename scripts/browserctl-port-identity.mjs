// Linux /proc-based verification that a TCP listener actually belongs to a
// specific recorded process, and that a recorded Chrome process's own
// environment still targets the expected X DISPLAY. Both checks exist to
// close the same gap: an open port or a live PID number alone is not proof
// that the *expected* desktop process is the one actually holding it --
// the port could be open because a stale or unrelated process reused it
// (including after PID reuse), and a health check that only asks "is
// something listening" would wrongly call that healthy.
//
// Every I/O primitive is an injectable dependency (defaulting to real
// node:fs/promises reads) so tests can drive exact /proc content and
// permission-error scenarios deterministically, without needing a real
// Linux /proc filesystem or real listening sockets.
//
// Fails closed by design: any ambiguous, missing, or unreadable evidence
// (dead PID, permission denied, malformed /proc content, no listener found)
// is reported as NOT owned / NOT matching -- never as healthy. Nothing here
// signals or kills any process; it only reports a verdict for the caller's
// existing readiness/repair logic (which already only ever acts on its own
// recorded PIDs, never a discovered/unrelated one).

import fs from "node:fs/promises";

const TCP_LISTEN_STATE = "0a";

function defaultReadFile(path) {
  return fs.readFile(path, "utf8");
}

function defaultListFds(pid) {
  return fs.readdir(`/proc/${pid}/fd`);
}

function defaultReadFdLink(pid, fd) {
  return fs.readlink(`/proc/${pid}/fd/${fd}`);
}

function defaultReadEnviron(pid) {
  return fs.readFile(`/proc/${pid}/environ`);
}

function defaultPidExists(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; ESRCH
    // (or anything else) means it does not.
    return error?.code === "EPERM";
  }
}

// Parses one /proc/net/tcp or /proc/net/tcp6 table and returns the socket
// inodes of every row in LISTEN state on the given port. IPv4 and IPv6
// rows share the same column layout; only the trailing ":PORT" hex suffix
// of local_address is used, so both address families parse identically
// without decoding the IP itself.
function listenInodesForPort(tableText, port) {
  const inodes = new Set();
  const lines = String(tableText || "").split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].trim().split(/\s+/);
    if (columns.length < 10) continue;
    const localAddress = columns[1] || "";
    const state = String(columns[3] || "").toLowerCase();
    const inode = columns[9];
    if (state !== TCP_LISTEN_STATE) continue;
    const portHex = localAddress.split(":")[1];
    const parsedPort = portHex ? Number.parseInt(portHex, 16) : NaN;
    if (!Number.isFinite(parsedPort) || parsedPort !== Number(port)) continue;
    if (inode) inodes.add(inode);
  }
  return inodes;
}

// Returns the set of socket inodes currently LISTENing on `port`, scanning
// both /proc/net/tcp and /proc/net/tcp6. Returns null (not an empty set) if
// neither table could be read at all, so the caller can distinguish "no
// listener" from "could not determine" and fail closed on the latter.
async function currentListenInodesForPort(port, deps) {
  const tables = ["/proc/net/tcp", "/proc/net/tcp6"];
  const inodes = new Set();
  let anyReadable = false;
  for (const tablePath of tables) {
    let text;
    try {
      text = await deps.readFile(tablePath);
    } catch {
      continue;
    }
    anyReadable = true;
    for (const inode of listenInodesForPort(text, port)) inodes.add(inode);
  }
  if (!anyReadable) return null;
  return inodes;
}

// Returns the set of socket inodes a PID currently holds open file
// descriptors to, or null if that evidence could not be obtained (process
// gone, permission denied, or any other read failure) -- callers must
// treat null as "unavailable", never as "owns nothing".
async function socketInodesHeldByPid(pid, deps) {
  let fds;
  try {
    fds = await deps.listFds(pid);
  } catch {
    return null;
  }
  const inodes = new Set();
  for (const fd of fds) {
    let target;
    try {
      target = await deps.readFdLink(pid, fd);
    } catch {
      // A single unreadable fd (raced close, permission edge case) does not
      // invalidate the rest of the table; only a wholly unreadable fd
      // directory (handled above) does.
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(String(target || ""));
    if (match) inodes.add(match[1]);
  }
  return inodes;
}

/**
 * Verifies that the TCP listener currently bound to `port` is owned by
 * `pid` (i.e. `pid` holds an open file descriptor for that exact listening
 * socket's inode), using only direct /proc inspection.
 *
 * Deterministic outcomes, always fail-closed on ambiguity:
 * - `owned`: the recorded PID holds the listening socket. Healthy.
 * - `missing_owner_pid`: the recorded PID is not running (covers "dead"
 *   and unset/invalid PIDs).
 * - `port_not_listening`: /proc shows no LISTEN row for this port at all
 *   (distinct from a reachability-level "closed"; a caller combining this
 *   with a TCP connect probe gets independent confirmation).
 * - `owner_evidence_unavailable`: /proc/net/tcp(6) or the PID's fd table
 *   could not be read (permissions, sandboxing, or any other I/O failure).
 *   Never treated as healthy.
 * - `wrong_process_on_port`: something IS listening on the port, the
 *   recorded PID IS running, but its fd table does not hold that listening
 *   socket's inode -- a different (possibly PID-reused) process owns it.
 */
export async function verifyPortOwnedByPid({ port, pid, deps: overrides = {} } = {}) {
  const deps = {
    readFile: defaultReadFile,
    listFds: defaultListFds,
    readFdLink: defaultReadFdLink,
    pidExists: defaultPidExists,
    ...overrides,
  };
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) {
    return { ok: false, status: "port_invalid" };
  }
  if (!deps.pidExists(pid)) {
    return { ok: false, status: "missing_owner_pid" };
  }
  const listenInodes = await currentListenInodesForPort(numericPort, deps);
  if (listenInodes === null) {
    return { ok: false, status: "owner_evidence_unavailable" };
  }
  if (listenInodes.size === 0) {
    return { ok: false, status: "port_not_listening" };
  }
  const heldInodes = await socketInodesHeldByPid(pid, deps);
  if (heldInodes === null) {
    return { ok: false, status: "owner_evidence_unavailable" };
  }
  for (const inode of heldInodes) {
    if (listenInodes.has(inode)) return { ok: true, status: "owned" };
  }
  return { ok: false, status: "wrong_process_on_port" };
}

// Parses a /proc/<pid>/environ buffer (NUL-separated KEY=VALUE entries)
// and returns the value of `name`, or "" if absent.
function environValue(buffer, name) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  const prefix = `${name}=`;
  for (const entry of text.split("\u0000")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return "";
}

/**
 * Verifies that the recorded Chrome PID's own process environment still
 * targets `expectedDisplay` (the DISPLAY value Orkestr launched it with),
 * as a narrow identity signal distinct from the RFB black/white-frame
 * pixel probe. Reads only /proc/<pid>/environ, which is a stable,
 * exec-time snapshot (never mutated post-launch), so this is not
 * susceptible to timing or environment-specific false positives -- only
 * to the same permission constraints as the port-ownership check above,
 * which this fails closed on identically.
 *
 * Outcomes: `matches` (healthy), `missing_owner_pid`, `mismatched_display`,
 * `owner_evidence_unavailable`.
 */
export async function verifyChromeDisplayIdentity({ pid, expectedDisplay, deps: overrides = {} } = {}) {
  const deps = {
    readEnviron: defaultReadEnviron,
    pidExists: defaultPidExists,
    ...overrides,
  };
  const expected = String(expectedDisplay || "").trim();
  if (!expected) return { ok: false, status: "expected_display_required" };
  if (!deps.pidExists(pid)) {
    return { ok: false, status: "missing_owner_pid" };
  }
  let buffer;
  try {
    buffer = await deps.readEnviron(pid);
  } catch {
    return { ok: false, status: "owner_evidence_unavailable" };
  }
  const actual = environValue(buffer, "DISPLAY").trim();
  if (!actual) return { ok: false, status: "owner_evidence_unavailable" };
  if (actual !== expected) return { ok: false, status: "mismatched_display" };
  return { ok: true, status: "matches" };
}
