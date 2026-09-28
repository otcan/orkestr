// Detached Claude Code turn transport.
//
// A legacy Claude turn is a child of the Orkestr server whose stream-json
// output flows over a stdio pipe. Restarting the server (for example during a
// deploy) breaks that pipe and loses the turn. A detached turn instead runs
// under a tiny POSIX shell wrapper in its own session (setsid) whose stdin,
// stdout and stderr are files in a per-turn directory under ORKESTR_HOME:
//
//   runtimes/claude-code/turns/<threadId>/<attemptId>/
//     turn.json    pid/pgid/start-time identity and turn metadata
//     prompt.txt   the prompt (stdin of the Claude process)
//     events.jsonl stream-json output (stdout)
//     stderr.log   stderr
//     exit.json    written by the wrapper once the Claude process exits
//
// The server tails events.jsonl and persists the byte offset it has already
// forwarded, so a restarted server can reattach to a still-running turn (or
// replay one that finished while it was down) without duplicating progress.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { appHome } from "../../storage/src/paths.js";

const POSIX = process.platform !== "win32";
const STDERR_TAIL_BYTES = 8192;
const READ_CHUNK_BYTES = 256 * 1024;

// The wrapper keeps running while Claude runs so it can record the exit code.
// It ignores SIGHUP (inherited by Claude, like nohup) and traps INT/TERM with a
// no-op handler so a group signal stops Claude while the wrapper survives long
// enough to write exit.json. Trapped (not ignored) signals reset to default in
// the exec'd Claude process, so Ctrl-C style interrupts still reach it.
const WRAPPER_SCRIPT = [
  "trap '' HUP",
  "trap ':' INT TERM",
  "p=$1; o=$2; e=$3; x=$4; shift 4",
  "\"$@\" <\"$p\" >>\"$o\" 2>>\"$e\"",
  "c=$?",
  "printf '{\"code\":%s}\\n' \"$c\" >\"$x.tmp\" && mv \"$x.tmp\" \"$x\"",
  "exit \"$c\"",
].join("\n");

function clean(value = "") {
  return String(value || "").trim();
}

function falsy(value) {
  return ["0", "false", "no", "off"].includes(clean(value).toLowerCase());
}

// Default ON for POSIX hosts; ORKESTR_CLAUDE_DETACHED_TURNS=0 restores the
// legacy in-process stdio pipe transport.
export function claudeCodeDetachedTurnsEnabled(env = process.env) {
  if (!POSIX) return false;
  return !falsy(env.ORKESTR_CLAUDE_DETACHED_TURNS);
}

// A detached turn still lives in the Orkestr service's cgroup. Hosts whose
// service uses KillMode=control-group kill it on every restart, so when
// Orkestr runs as root under systemd each turn is moved into its own transient
// scope. `systemd-run --scope` execs the command itself, so the recorded pid is
// still the wrapper's. ORKESTR_CLAUDE_DETACHED_SCOPE=0 disables it, =1 forces
// it; the default is automatic.
function systemdRunBinary(env = process.env) {
  const explicit = clean(env.ORKESTR_SYSTEMD_RUN_BIN);
  if (explicit) return explicit;
  return ["/usr/bin/systemd-run", "/bin/systemd-run"].find((candidate) => fsSync.existsSync(candidate)) || "";
}

export function claudeCodeDetachedScope(env = process.env) {
  const mode = clean(env.ORKESTR_CLAUDE_DETACHED_SCOPE).toLowerCase();
  if (falsy(mode)) return null;
  const forced = ["1", "true", "yes", "on"].includes(mode);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (!forced && (process.platform !== "linux" || !root || !fsSync.existsSync("/run/systemd/system"))) return null;
  const binary = systemdRunBinary(env);
  return binary ? { binary } : null;
}

// "detached" turns survive a service restart (own scope); "detached-unscoped"
// turns only survive when the service does not kill its whole cgroup.
export function claudeCodeDetachedTransport(env = process.env) {
  if (!claudeCodeDetachedTurnsEnabled(env)) return "pipe";
  return claudeCodeDetachedScope(env) ? "detached" : "detached-unscoped";
}

export function claudeCodeDetachedPollMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_DETACHED_POLL_MS || 50);
  return Number.isFinite(parsed) && parsed >= 5 ? Math.min(parsed, 5_000) : 50;
}

function safeSegment(value = "") {
  return clean(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

export function detachedTurnsRoot(env = process.env) {
  return path.join(appHome(env), "runtimes", "claude-code", "turns");
}

export function detachedTurnDir(threadId, attemptId, env = process.env) {
  return path.join(detachedTurnsRoot(env), safeSegment(threadId), safeSegment(attemptId));
}

export function detachedTurnPaths(dir) {
  return {
    dir,
    record: path.join(dir, "turn.json"),
    prompt: path.join(dir, "prompt.txt"),
    events: path.join(dir, "events.jsonl"),
    stderr: path.join(dir, "stderr.log"),
    exit: path.join(dir, "exit.json"),
  };
}

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function readJson(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readDetachedTurnRecord(threadId, attemptId, env = process.env) {
  const paths = detachedTurnPaths(detachedTurnDir(threadId, attemptId, env));
  const record = await readJson(paths.record);
  if (!record || clean(record.attemptId) !== clean(attemptId)) return null;
  return { ...record, paths };
}

export async function updateDetachedTurnRecord(record, patch = {}) {
  if (!record?.paths?.record) return record;
  const { paths, ...stored } = { ...record, ...patch };
  await writeJsonAtomic(record.paths.record, stored).catch(() => {});
  return { ...stored, paths };
}

export async function removeDetachedTurn(record) {
  if (!record?.paths?.dir) return;
  await fs.rm(record.paths.dir, { recursive: true, force: true }).catch(() => {});
  await fs.rmdir(path.dirname(record.paths.dir)).catch(() => {});
}

function readBootIdSync() {
  try { return fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; }
}

// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. Together
// with the boot id it identifies one process instance, so a recycled pid is
// never mistaken for the turn's wrapper.
export function processStartTimeSync(pid) {
  if (process.platform !== "linux") return "";
  try {
    const stat = fsSync.readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return clean(fields[19]);
  } catch {
    return "";
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// True only when the recorded wrapper process is still the same process
// instance. Without /proc (non-Linux) the pid check is the best available.
export function detachedTurnProcessAlive(record = {}) {
  const pid = Number(record.pid);
  if (!pidAlive(pid)) return false;
  if (process.platform !== "linux") return true;
  const startTime = processStartTimeSync(pid);
  if (!startTime || startTime !== clean(record.procStartTime)) return false;
  const bootId = readBootIdSync();
  if (record.bootId && bootId && bootId !== clean(record.bootId)) return false;
  // Zombies keep their pid until reaped; they no longer run the turn.
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).trim().startsWith("Z")) return false;
  } catch {
    return false;
  }
  return true;
}

export async function readDetachedTurnExit(record = {}) {
  const exit = await readJson(record.paths?.exit || "");
  if (!exit) return null;
  const code = Number(exit.code);
  return Number.isInteger(code) ? { code } : null;
}

async function readStderrTail(filePath) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, STDERR_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function exitStatusFromShellCode(code) {
  if (!Number.isInteger(code)) return { code: null, signal: "SIGKILL" };
  if (code > 128 && code < 128 + 65) {
    const name = Object.entries(os.constants.signals).find(([, number]) => number === code - 128)?.[0];
    if (name) return { code: null, signal: name };
  }
  return { code, signal: null };
}

// A child-process-like facade over a detached turn. The supervisor and the
// turn runner use `pid`, `onLine`, `stderr` ('data'), `stdin`, and the
// 'error'/'close' events exactly like a piped ChildProcess.
function createTailFacade({ record, child = null, resumeOffset = 0, pollMs = 50, persistEveryMs = 500 }) {
  const facade = new EventEmitter();
  const stderr = new EventEmitter();
  let lineHandler = null;
  let offset = 0;
  let partial = Buffer.alloc(0);
  let childExit = null;
  let closed = false;
  let timer = null;
  let lastPersistAt = 0;
  let persistedOffset = Number(resumeOffset) || 0;
  let reading = false;
  let currentRecord = record;

  facade.pid = Number(record.pid);
  facade.stdin = { on() {}, end() {}, write() { return true; } };
  facade.stderr = stderr;
  facade.record = () => currentRecord;
  facade.onLine = (handler) => { lineHandler = handler; schedule(0); };

  async function persistOffset(force = false) {
    if (offset <= persistedOffset && !force) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < persistEveryMs) return;
    lastPersistAt = now;
    persistedOffset = Math.max(persistedOffset, offset);
    currentRecord = await updateDetachedTurnRecord(currentRecord, { forwardedOffset: persistedOffset });
  }

  async function drain() {
    let handle;
    try { handle = await fs.open(record.paths.events, "r"); } catch { return; }
    try {
      for (;;) {
        const buffer = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + partial.length);
        if (!bytesRead) break;
        let data = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
        let newline = data.indexOf(10);
        while (newline >= 0) {
          const line = data.subarray(0, newline).toString("utf8");
          offset += newline + 1;
          data = data.subarray(newline + 1);
          if (closed) return;
          lineHandler?.(line, { replay: offset <= persistedOffset, offset });
          newline = data.indexOf(10);
        }
        partial = Buffer.from(data);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function finish(status) {
    if (closed) return;
    await drain();
    if (partial.length) {
      const line = partial.toString("utf8");
      offset += partial.length;
      partial = Buffer.alloc(0);
      lineHandler?.(line, { replay: offset <= persistedOffset, offset });
    }
    if (closed) return;
    await persistOffset(true);
    const tail = await readStderrTail(record.paths.stderr);
    if (tail) stderr.emit("data", Buffer.from(tail));
    closed = true;
    facade.emit("exit", status.code, status.signal);
    facade.emit("close", status.code, status.signal);
  }

  async function tick() {
    timer = null;
    if (closed || reading || !lineHandler) return;
    reading = true;
    try {
      await drain();
      await persistOffset();
      const exit = await readDetachedTurnExit(record);
      if (exit) return await finish(exitStatusFromShellCode(exit.code));
      if (childExit) {
        return await finish(childExit.code !== null ? exitStatusFromShellCode(childExit.code) : { code: null, signal: childExit.signal });
      }
      if (!child && !detachedTurnProcessAlive(record)) return await finish({ code: null, signal: "SIGKILL" });
    } catch (error) {
      if (!closed) {
        closed = true;
        facade.emit("error", error);
      }
      return;
    } finally {
      reading = false;
    }
    schedule(pollMs);
  }

  function schedule(delay) {
    if (closed || timer) return;
    timer = setTimeout(() => { void tick(); }, delay);
  }

  if (child) {
    child.on("exit", (code, signal) => {
      childExit = { code, signal };
      if (timer) { clearTimeout(timer); timer = null; }
      schedule(0);
    });
    child.on("error", (error) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      facade.emit("error", error);
    });
  }
  return facade;
}

// Spawn a detached turn. Returns a facade usable as `proc` by spawnSupervised.
export function spawnDetachedClaudeTurn({ command, args = [], cwd, childEnv = {}, prompt = "", threadId, attemptId, meta = {}, env = process.env }) {
  const dir = detachedTurnDir(threadId, attemptId, env);
  const paths = detachedTurnPaths(dir);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(paths.prompt, `${String(prompt || "").replace(/\n*$/g, "")}\n`, { mode: 0o600 });
  fsSync.writeFileSync(paths.events, "", { mode: 0o600 });
  fsSync.writeFileSync(paths.stderr, "", { mode: 0o600 });
  const scope = claudeCodeDetachedScope(env);
  const scopeUnit = scope ? `orkestr-claude-${safeSegment(attemptId)}-${process.pid}.scope`.replace(/_/g, "-") : "";
  const wrapperArgv = ["/bin/sh", "-c", WRAPPER_SCRIPT, "orkestr-claude-turn", paths.prompt, paths.events, paths.stderr, paths.exit, command, ...args];
  const launch = scope
    ? [scope.binary, ["--scope", "--quiet", "--collect", `--unit=${scopeUnit}`, `--description=Orkestr Claude turn ${clean(attemptId)}`, ...wrapperArgv]]
    : [wrapperArgv[0], wrapperArgv.slice(1)];
  const child = spawn(launch[0], launch[1], {
    cwd,
    env: childEnv,
    stdio: "ignore",
    detached: true,
  });
  const record = {
    version: 1,
    transport: "detached",
    scopeUnit: scopeUnit || null,
    threadId: clean(threadId),
    attemptId: clean(attemptId),
    pid: child.pid || null,
    pgid: child.pid || null,
    procStartTime: child.pid ? processStartTimeSync(child.pid) : "",
    bootId: readBootIdSync(),
    startedAt: new Date().toISOString(),
    serverPid: process.pid,
    forwardedOffset: 0,
    ...meta,
    paths,
  };
  if (child.pid) {
    const { paths: _paths, ...stored } = record;
    fsSync.writeFileSync(paths.record, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  }
  const facade = createTailFacade({ record, child, pollMs: claudeCodeDetachedPollMs(env) });
  facade.detached = true;
  return facade;
}

// Attach to an existing detached turn (after a server restart). Lines up to
// the persisted forwarded offset are replayed with `replay: true` so the
// caller can rebuild parser state without re-emitting side effects.
export function attachDetachedClaudeTurn(record, env = process.env) {
  const facade = createTailFacade({ record, child: null, resumeOffset: Number(record.forwardedOffset) || 0, pollMs: claudeCodeDetachedPollMs(env) });
  facade.detached = true;
  facade.reattached = true;
  return facade;
}

// Classify a persisted turn: "running" (verified live process), "exited"
// (exit record present), or "gone" (no live process and no exit record).
export async function detachedTurnState(record) {
  if (await readDetachedTurnExit(record)) return "exited";
  if (detachedTurnProcessAlive(record)) return "running";
  if (await readDetachedTurnExit(record)) return "exited";
  return "gone";
}

// True when the event log already contains a successful terminal result.
export async function detachedTurnHasSuccessfulResult(record) {
  let text = "";
  try { text = await fs.readFile(record.paths.events, "utf8"); } catch { return false; }
  for (const line of text.split("\n")) {
    if (!line.includes("\"result\"")) continue;
    try {
      const event = JSON.parse(line);
      if (clean(event.type).toLowerCase() === "result" && event.is_error !== true && event.isError !== true) return true;
    } catch {}
  }
  return false;
}

export async function listDetachedTurnRecords(threadId, env = process.env) {
  const threadDir = path.join(detachedTurnsRoot(env), safeSegment(threadId));
  let entries = [];
  try { entries = await fs.readdir(threadDir, { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paths = detachedTurnPaths(path.join(threadDir, entry.name));
    const record = await readJson(paths.record);
    if (record) records.push({ ...record, paths });
  }
  return records;
}
