// `orkestr attach` for a thread whose thinking layer is a running Claude Code
// background session (bound with `orkestr api-session bind`).
//
// Claude Code supports attaching a terminal to a running background session:
// `claude attach <id>` opens that same process here (no second process writes
// its transcript); ← on an empty prompt or Ctrl+Z detach, the session keeps running.
// So attach runs exactly that, as the session's own user and config dir,
// after checking that no other terminal is attached to it already.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestJson } from "./api-client.js";

const listTimeoutMs = 20_000;

function clean(value) {
  return String(value ?? "").trim();
}

function jobError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function passwdEntries(readFile = fs.readFileSync) {
  try {
    return readFile("/etc/passwd", "utf8").split("\n").map((line) => line.split(":")).filter((f) => f.length >= 7)
      .map(([name, , uid, gid, , home]) => ({ name, uid: Number(uid), gid: Number(gid), home }));
  } catch {
    return [];
  }
}

// Claude config dirs that may hold background sessions: ORKESTR_ATTACH_CLAUDE_CONFIG_DIRS
// (colon-separated), else this user's, plus (as root) every /home/*/.claude.
export function claudeConfigDirs(env = process.env, { fsImpl = fs, uid = process.getuid?.() ?? -1 } = {}) {
  const explicit = clean(env.ORKESTR_ATTACH_CLAUDE_CONFIG_DIRS);
  const dirs = explicit ? explicit.split(":") : [clean(env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), ".claude")];
  if (!explicit && uid === 0) {
    try {
      for (const name of fsImpl.readdirSync("/home")) dirs.push(path.join("/home", name, ".claude"));
    } catch {}
  }
  return [...new Set(dirs.map(clean).filter(Boolean))].filter((dir) => {
    try {
      return fsImpl.statSync(path.join(dir, "jobs")).isDirectory();
    } catch {
      return false;
    }
  });
}

// How to run `claude` as the owner of a config dir.
export function claudeRunner(configDir, { fsImpl = fs, uid = process.getuid?.() ?? -1, env = process.env } = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(configDir);
  } catch {
    return null;
  }
  const owner = passwdEntries(fsImpl.readFileSync).find((entry) => entry.uid === stat.uid);
  if (!owner) return null;
  const local = path.join(owner.home, ".local", "bin", "claude");
  const binary = clean(env.ORKESTR_ATTACH_CLAUDE_BIN) || (fsImpl.existsSync(local) ? local : "claude");
  const vars = [`HOME=${owner.home}`, `CLAUDE_CONFIG_DIR=${configDir}`];
  if (uid === stat.uid) return { user: owner.name, home: owner.home, configDir, command: (args) => ["env", [...vars, binary, ...args]] };
  if (uid !== 0) return null;
  // As root: the session owner's identity, not root's runtime dir.
  const identity = ["-u", "XDG_RUNTIME_DIR", `USER=${owner.name}`, `LOGNAME=${owner.name}`, ...vars];
  return { user: owner.name, home: owner.home, configDir, command: (args) => ["runuser", ["-u", owner.name, "--", "env", ...identity, binary, ...args]] };
}

function listSessions(runner, spawnSyncImpl = spawnSync) {
  const [command, args] = runner.command(["agents", "--json"]);
  const result = spawnSyncImpl(command, args, { encoding: "utf8", timeout: listTimeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return [];
  try {
    const sessions = JSON.parse(String(result.stdout || ""));
    return Array.isArray(sessions) ? sessions.filter((s) => s && clean(s.id) && clean(s.sessionId)) : [];
  } catch {
    return [];
  }
}

// The background session bound to this V1 thread, or null. Several bound
// sessions: the most recently seen binding wins (as in the live map).
export async function findClaudeJobForThread(thread, ctx) {
  const threadId = clean(thread?.id);
  if (!threadId) return null;
  const matches = [];
  for (const configDir of claudeConfigDirs(ctx.env, { fsImpl: ctx.fsImpl || fs, uid: ctx.uid ?? process.getuid?.() })) {
    const runner = claudeRunner(configDir, { fsImpl: ctx.fsImpl || fs, uid: ctx.uid ?? process.getuid?.(), env: ctx.env });
    if (!runner) continue;
    for (const session of listSessions(runner, ctx.spawnSyncImpl)) {
      const payload = await requestJson(`/api/session-bindings/${encodeURIComponent(session.sessionId)}`, ctx).catch(() => null);
      const binding = payload?.binding || payload;
      if (clean(binding?.threadId) === threadId) matches.push({ runner, session, lastSeenAt: clean(binding.lastSeenAt || binding.updatedAt) });
    }
  }
  matches.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return matches[0] || null;
}

function readProc(pid, name, fsImpl) {
  try {
    return fsImpl.readFileSync(`/proc/${pid}/${name}`, "utf8");
  } catch {
    return "";
  }
}

// Other terminals on this session: `claude attach <id>` or a shell
// `claude --resume <session>` (which attaches to a running background session).
export function otherAttachments(job, { fsImpl = fs, selfPid = process.pid } = {}) {
  const keys = new Set([job.session.id, job.session.sessionId].map(clean).filter(Boolean));
  const found = [];
  let pids = [];
  try {
    pids = fsImpl.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {}
  for (const pid of pids) {
    if (Number(pid) === selfPid || Number(pid) === Number(job.session.pid)) continue;
    const argv = readProc(pid, "cmdline", fsImpl).split("\0").filter(Boolean);
    if (!argv.length || !path.basename(argv[0]).startsWith("claude")) continue;
    const attachAt = argv.indexOf("attach");
    const resumeAt = argv.findIndex((arg) => arg === "--resume" || arg === "-r");
    const named = (attachAt >= 0 && keys.has(argv[attachAt + 1])) || (resumeAt >= 0 && keys.has(argv[resumeAt + 1]));
    if (named) found.push({ pid: Number(pid), command: argv.slice(0, 4).join(" ") });
  }
  return found;
}

export function claudeJobSummary(job, thread, attachments) {
  const [command, args] = job.runner.command(["attach", job.session.id]);
  return {
    attachKind: "claude-background-session",
    threadId: clean(thread?.id) || null,
    name: clean(thread?.bindingName || thread?.name) || null,
    jobId: job.session.id,
    sessionId: job.session.sessionId,
    sessionName: clean(job.session.name) || null,
    status: clean(job.session.status) || null,
    state: clean(job.session.state) || null,
    pid: job.session.pid || null,
    user: job.runner.user,
    configDir: job.runner.configDir,
    attachedElsewhere: attachments,
    command: [command, ...args].join(" "),
  };
}

function waitGone(pid, deadlineMs, sleep) {
  return (async () => {
    while (Date.now() < deadlineMs) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await sleep(100);
    }
    return false;
  })();
}

export async function runClaudeJobAttach(job, thread, ctx, { printOnly = false, json = false, takeover = false, spawnInherited } = {}) {
  const attachments = (ctx.otherAttachmentsImpl || otherAttachments)(job, { fsImpl: ctx.fsImpl || fs });
  const summary = claudeJobSummary(job, thread, attachments);
  if (json) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
    return 0;
  }
  if (printOnly) {
    const elsewhere = attachments.length ? attachments.map((a) => `pid ${a.pid}`).join(",") : "none";
    ctx.stdout.write(`claude-job id=${summary.jobId} session=${summary.sessionId} status=${summary.status} state=${summary.state} user=${summary.user} attached_elsewhere=${elsewhere} command="${summary.command}"\n`);
    return 0;
  }
  if (attachments.length && !takeover) {
    throw jobError("claude_session_attached_elsewhere", `session ${summary.jobId} is already open in another terminal (pid ${attachments.map((a) => a.pid).join(", ")}); rerun with --takeover to detach it`);
  }
  const sleep = ctx.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (const attachment of attachments) {
    // Detaching another terminal never stops the background session.
    try {
      (ctx.killImpl || process.kill)(attachment.pid, "SIGTERM");
    } catch {}
    if (!ctx.killImpl && !(await waitGone(attachment.pid, Date.now() + 3000, sleep))) {
      throw jobError("claude_takeover_failed", `pid ${attachment.pid} did not detach`);
    }
  }
  ctx.stderr?.write?.(`Attaching to Claude Code session ${summary.jobId} (${summary.sessionName || summary.sessionId}). Detach with ← on an empty prompt or Ctrl+Z; the session keeps running.\n`);
  const [command, args] = job.runner.command(["attach", job.session.id]);
  return spawnInherited(ctx.spawnImpl, command, args);
}
