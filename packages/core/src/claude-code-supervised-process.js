import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// On POSIX, spawn with detached:true calls setsid() in the child.
// The child becomes a new session leader whose PGID equals its own PID.
// Grandchildren inherit this PGID, so SIGTERM/-pgid terminates all descendants
// and prevents orphaned readline/app-server handles from keeping Node alive
// past the Claude turn timeout.
const POSIX = process.platform !== "win32";

function cleanStr(value = "") {
  return String(value || "").trim();
}

function killGroup(pgid, signal) {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function pgroupAlive(pgid) {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifiedProcessGroupMember(pgid, attemptId) {
  if (process.platform !== "linux") return null;
  const expectedAttempt = cleanStr(attemptId);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!expectedAttempt) return null;
  let entries = [];
  try { entries = await fs.readdir("/proc", { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const [stat, status, environ] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile(`/proc/${pid}/status`, "utf8"),
        fs.readFile(`/proc/${pid}/environ`),
      ]);
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) continue;
      const statFields = stat.slice(closeParen + 2).trim().split(/\s+/);
      if (Number(statFields[2]) !== pgid) continue; // field 5: process group id
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (expectedUid !== null && uid !== expectedUid) continue;
      const marker = Buffer.from(`ORKESTR_CLAUDE_SUPERVISION_ATTEMPT_ID=${expectedAttempt}`);
      const values = environ.toString("utf8").split("\0");
      if (values.includes(marker.toString("utf8"))) return { pid, uid };
    } catch {
      // A process may exit while /proc is being scanned; continue safely.
    }
  }
  return null;
}

async function writeIdentityFile(filePath, identity) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, JSON.stringify(identity) + "\n", { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function readIdentityFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Kill an orphaned process group left by a previous (crashed/abandoned) attempt.
// Call this at the start of a new turn, before writing the new identity.
// Returns { recovered: true, pgid, attemptId } or { recovered: false, reason }.
export async function recoverOrphanedAttempt(identityFilePath) {
  const identity = await readIdentityFile(identityFilePath);
  if (!identity) return { recovered: false, reason: "no_identity" };
  const pgid = Number(identity.pgid);
  if (!Number.isInteger(pgid) || pgid <= 0) return { recovered: false, reason: "invalid_pgid" };
  if (!POSIX || process.platform !== "linux") return { recovered: false, reason: "unsupported_platform" };
  if (!pgroupAlive(pgid)) return { recovered: false, reason: "already_dead" };
  // A numeric PGID can be reused. Kill only when a live member still carries
  // the private attempt marker inherited from the supervised process.
  const member = await verifiedProcessGroupMember(pgid, identity.attemptId);
  if (!member) return { recovered: false, blocked: true, reason: "identity_unverified", pgid };
  killGroup(pgid, "SIGKILL");
  return { recovered: true, pgid, attemptId: cleanStr(identity.attemptId), verifiedPid: member.pid };
}

// Read env-based tuning with safe defaults.
export function supervisedProcessDefaults(env = process.env) {
  function posMs(key, fallback) {
    const v = Number(env[key] ?? fallback);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }
  return {
    gracePeriodMs: posMs("ORKESTR_CLAUDE_GRACE_PERIOD_MS", 5_000),
    semanticInactivityMs: posMs("ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS", 10 * 60_000),
    staleWorkingMs: posMs("ORKESTR_CLAUDE_STALE_WORKING_MS", 2 * 60_000),
    toolDeadlineMs: posMs("ORKESTR_CLAUDE_TOOL_DEADLINE_MS", 10 * 60_000),
    heartbeatIntervalMs: posMs("ORKESTR_CLAUDE_HEARTBEAT_INTERVAL_MS", 60_000),
    heartbeatThresholdMs: posMs("ORKESTR_CLAUDE_HEARTBEAT_THRESHOLD_MS", 30_000),
  };
}

// Spawn a Claude child with POSIX process-group isolation and supervision.
//
// Options:
//   command, args, cwd, env       — passed to spawn
//   attemptId                     — unique string identity for this run
//   identityFilePath              — persist { attemptId, pid, pgid } for orphan recovery
//   gracePeriodMs                 — SIGTERM → SIGKILL gap (default 5 s)
//   semanticInactivityMs          — terminate if no semantic output seen for this long
//   staleWorkingMs                — mark staleWorking after this much semantic silence
//   toolDeadlineMs                — terminate if a single tool call exceeds this duration
//   heartbeatIntervalMs           — interval between onHeartbeat calls while tool is active
//   heartbeatThresholdMs          — minimum tool elapsed time before heartbeats start
//   onSemanticStall()             — callback when semantic inactivity triggers termination
//   onToolTimeout({ toolName, elapsedMs })              — callback on per-tool deadline
//   onHeartbeat({ phase, toolElapsedMs, totalElapsedMs }) — rate-limited progress callback
//
// Returns a supervisor handle.
export function spawnSupervised(options = {}) {
  const {
    command, args, cwd, env: childEnv,
    attemptId, identityFilePath,
    gracePeriodMs = 5_000,
    semanticInactivityMs = 10 * 60_000,
    staleWorkingMs = 2 * 60_000,
    toolDeadlineMs = 10 * 60_000,
    heartbeatIntervalMs = 60_000,
    heartbeatThresholdMs = 30_000,
    onSemanticStall = null,
    onToolTimeout = null,
    onHeartbeat = null,
  } = options;

  const proc = spawn(command, args, {
    cwd,
    env: {
      ...childEnv,
      ORKESTR_CLAUDE_SUPERVISION_ATTEMPT_ID: cleanStr(attemptId),
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: POSIX,
  });

  const pid = proc.pid;
  // With detached:true on POSIX the child calls setsid() → PGID = PID.
  const pgid = POSIX ? pid : null;
  const startedAt = Date.now();

  let _settled = false;
  let _interrupted = false;
  let _failureCode = null;
  let _staleWorkingSince = null;

  let lastSemanticEvidenceAt = startedAt;
  const activeTools = new Map();
  let anonymousToolSequence = 0;

  function currentTool() {
    return [...activeTools.values()].sort((a, b) => a.startedAt - b.startedAt)[0] || null;
  }

  let forceKillTimer = null;
  let semanticInactivityTimer = null;
  let toolDeadlineTimer = null;
  let heartbeatTimer = null;

  // Persist identity for orphan recovery (fire-and-forget; errors are non-fatal).
  const identityWritten = identityFilePath
    ? writeIdentityFile(identityFilePath, {
        attemptId: cleanStr(attemptId),
        pid,
        pgid,
        startedAt: new Date().toISOString(),
      }).catch(() => {})
    : Promise.resolve();

  function sendSignalToGroup(signal) {
    if (POSIX && pgid) return killGroup(pgid, signal);
    try { proc.kill(signal); return true; } catch { return false; }
  }

  function doTerminate(code) {
    if (code && !_failureCode) _failureCode = code;
    if (!forceKillTimer) {
      sendSignalToGroup("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!_settled) sendSignalToGroup("SIGKILL");
      }, gracePeriodMs);
      forceKillTimer.unref?.();
    }
  }

  function resetSemanticInactivityTimer() {
    if (semanticInactivityTimer) { clearTimeout(semanticInactivityTimer); semanticInactivityTimer = null; }
    if (_settled || semanticInactivityMs <= 0) return;
    semanticInactivityTimer = setTimeout(() => {
      if (!_settled) {
        doTerminate("claude_code_semantic_stall");
        onSemanticStall?.();
      }
    }, semanticInactivityMs);
    semanticInactivityTimer.unref?.();
  }

  function resetToolDeadlineTimer() {
    if (toolDeadlineTimer) { clearTimeout(toolDeadlineTimer); toolDeadlineTimer = null; }
    const tool = currentTool();
    if (_settled || !tool || toolDeadlineMs <= 0) return;
    const remainingMs = Math.max(1, toolDeadlineMs - (Date.now() - tool.startedAt));
    toolDeadlineTimer = setTimeout(() => {
      const overdueTool = currentTool();
      if (!_settled && overdueTool) {
        const elapsedMs = Date.now() - overdueTool.startedAt;
        doTerminate("claude_code_tool_timeout");
        onToolTimeout?.({ toolName: overdueTool.name, elapsedMs });
      }
    }, remainingMs);
    toolDeadlineTimer.unref?.();
  }

  function resetHeartbeatTimer() {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    if (_settled || !onHeartbeat || !currentTool() || heartbeatIntervalMs <= 0) return;
    function beat() {
      const tool = currentTool();
      if (_settled || !tool) return;
      const toolElapsedMs = Date.now() - tool.startedAt;
      const totalElapsedMs = Date.now() - startedAt;
      if (toolElapsedMs >= heartbeatThresholdMs) {
        onHeartbeat({ phase: "tool_active", toolElapsedMs, totalElapsedMs });
      }
      if (!_settled) {
        heartbeatTimer = setTimeout(beat, heartbeatIntervalMs);
        heartbeatTimer.unref?.();
      }
    }
    heartbeatTimer = setTimeout(beat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  // Begin semantic inactivity countdown from spawn time.
  resetSemanticInactivityTimer();

  const supervisor = {
    proc,
    pid,
    pgid,
    attemptId: cleanStr(attemptId),
    identityWritten,

    get settled() { return _settled; },
    get interrupted() { return _interrupted; },
    get failureCode() { return _failureCode; },
    set failureCode(v) { if (v && !_failureCode) _failureCode = v; },

    // True when time since last semantic evidence exceeds staleWorkingMs.
    get staleWorking() {
      if (_settled || staleWorkingMs <= 0) return false;
      return Date.now() - lastSemanticEvidenceAt > staleWorkingMs;
    },

    // ISO timestamp when staleWorking first became true (set lazily by tickStaleWorking).
    get staleWorkingSince() { return _staleWorkingSince; },
    get lastSemanticEvidenceAt() { return lastSemanticEvidenceAt; },
    get currentToolName() { return currentTool()?.name || null; },
    get toolElapsedMs() { const tool = currentTool(); return tool ? Date.now() - tool.startedAt : null; },

    // Call with each JSON event line emitted by the Claude process.
    observeEvent(event = {}) {
      if (_settled) return;
      const type = cleanStr(event.type).toLowerCase();
      const subtype = cleanStr(event.subtype).toLowerCase();

      // Transport-only: system init and rate-limit housekeeping are not semantic progress.
      const isTransportOnly = (type === "system" && subtype === "init") ||
        type === "rate_limit_event" || type === "";
      if (!isTransportOnly) {
        lastSemanticEvidenceAt = Date.now();
        if (_staleWorkingSince) _staleWorkingSince = null;
        resetSemanticInactivityTimer();
      }

      // Claude stream-json nests tool_use/tool_result blocks in message.content.
      // Track every outstanding tool id so one completed tool cannot hide a
      // different stuck tool.
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of content) {
        const blockType = cleanStr(block?.type).toLowerCase();
        if (blockType === "tool_use") {
          const id = cleanStr(block.id) || `anonymous-${++anonymousToolSequence}`;
          activeTools.set(id, { id, name: cleanStr(block.name) || "unknown", startedAt: Date.now() });
        } else if (blockType === "tool_result") {
          const id = cleanStr(block.tool_use_id || block.toolUseId);
          if (id) activeTools.delete(id);
          else activeTools.clear();
        }
      }
      if (type === "tool_result") {
        const id = cleanStr(event.tool_use_id || event.toolUseId);
        if (id) activeTools.delete(id);
        else activeTools.clear();
      } else if (type === "result") {
        activeTools.clear();
      }
      if (activeTools.size === 0) {
        if (toolDeadlineTimer) { clearTimeout(toolDeadlineTimer); toolDeadlineTimer = null; }
        if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      } else {
        resetToolDeadlineTimer();
        resetHeartbeatTimer();
      }
    },

    // Update staleWorkingSince lazily (call from status polling).
    tickStaleWorking() {
      const stale = supervisor.staleWorking;
      if (stale && !_staleWorkingSince) _staleWorkingSince = new Date().toISOString();
      else if (!stale && _staleWorkingSince) _staleWorkingSince = null;
      return stale;
    },

    // SIGTERM the process group; schedule SIGKILL after grace.
    terminate(code) { doTerminate(code); },

    // Mark as user-interrupted and terminate the process group.
    interrupt() {
      _interrupted = true;
      doTerminate(null);
    },

    // Called exactly once when the child process exits and the promise settles.
    markSettled(code = null) {
      _settled = true;
      if (code && !_failureCode) _failureCode = code;
      if (semanticInactivityTimer) { clearTimeout(semanticInactivityTimer); semanticInactivityTimer = null; }
      if (toolDeadlineTimer) { clearTimeout(toolDeadlineTimer); toolDeadlineTimer = null; }
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      if (forceKillTimer) { clearTimeout(forceKillTimer); forceKillTimer = null; }
    },

    // Verify the identity file still names this attempt before any PGID cleanup.
    // Returns { ok: true } to proceed, or { ok: false, reason } if fenced by a newer attempt.
    async verifyCurrentAttempt() {
      if (!identityFilePath) return { ok: true, reason: "no_identity_file" };
      const identity = await readIdentityFile(identityFilePath).catch(() => null);
      if (!identity) return { ok: true, reason: "identity_file_missing" };
      if (cleanStr(identity.attemptId) !== cleanStr(attemptId)) {
        return { ok: false, reason: "superseded_by_newer_attempt" };
      }
      return { ok: true };
    },

    // Remove the identity file only when it still belongs to this attempt.
    async removeIdentityFile() {
      if (!identityFilePath) return;
      // Fence the write/remove race for very short-lived child processes.
      await identityWritten;
      const check = await supervisor.verifyCurrentAttempt().catch(() => ({ ok: false }));
      if (check.ok) await fs.rm(identityFilePath, { force: true }).catch(() => {});
    },
  };

  return supervisor;
}
