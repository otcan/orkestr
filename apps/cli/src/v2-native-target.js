// The native provider session behind a V2 conversation, read-only.
//
// V2 runs a conversation's Deep agent as one native provider session (Claude
// Code session or Codex thread), resumed by every Deep run. This reads which
// one it is from Core (the Deep session binding and its latest run) and, when
// the deployment's selected plan is configured, how V2 launches it (user, cwd,
// binary, config dir). It also reports whether the session is in use now: a
// running V2 run, or any local process naming the session id.
//
// Nothing here writes. Opening the session interactively needs a V2 hold so
// V2 never resumes it at the same time; until Core offers one, `orkestr
// attach` only describes the target (--print/--json).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readPrivateJson } from "./v2-owner-session.js";

export const defaultNativeAttachConfigPath = "/etc/orkestr/v2-native-attach.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeRunStates = new Set(["starting", "running", "cancel_requested"]);

function clean(value) {
  return String(value ?? "").trim();
}

// Host config: {"core_db": "<core.sqlite3>", "plan": "<selected plan path, {source12} = live V2 build>"}.
export function nativeAttachConfig(env = process.env, readFile = fs.readFileSync) {
  const file = clean(env.ORKESTR_V2_NATIVE_ATTACH_CONFIG) || defaultNativeAttachConfigPath;
  try {
    const value = readPrivateJson(file, "V2 native attach config", readFile);
    return { file, coreDb: clean(value.core_db), plan: clean(value.plan) };
  } catch (error) {
    return { file, error: error.code || error.message };
  }
}

function sqliteRows(db, sql, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl("sqlite3", ["-readonly", "-json", `file:${db}?mode=ro`, sql], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`core_read_failed: ${clean(result.stderr).split("\n")[0] || `exit ${result.status}`}`);
  const text = clean(result.stdout);
  return text ? JSON.parse(text) : [];
}

// Core's current Deep session for the conversation and its latest run.
export function readNativeSession(coreDb, conversationId, { spawnSyncImpl } = {}) {
  if (!uuidPattern.test(conversationId)) throw new Error("conversation id is not a UUID");
  const conversation = conversationId.toLowerCase();
  const [binding] = sqliteRows(coreDb, `SELECT id, provider_kind, native_session_id, generation, state FROM session_bindings WHERE conversation_id='${conversation}' AND role='deep' AND deep_slot=0 AND state<>'retired' ORDER BY rowid DESC LIMIT 1`, spawnSyncImpl);
  if (!binding) return null;
  if (!uuidPattern.test(clean(binding.id))) throw new Error("core session id is not a UUID");
  const nativeId = clean(binding.native_session_id);
  const sameNative = uuidPattern.test(nativeId) ? ` OR native_session_id='${nativeId.toLowerCase()}'` : "";
  const runs = sqliteRows(coreDb, `SELECT id, state, binding_generation, role FROM production_runs WHERE conversation_id='${conversation}' AND (session_id='${binding.id.toLowerCase()}'${sameNative}) ORDER BY rowid DESC LIMIT 5`, spawnSyncImpl);
  return {
    sessionId: binding.id,
    provider: clean(binding.provider_kind),
    nativeSessionId: clean(binding.native_session_id) || null,
    generation: Number(binding.generation),
    state: clean(binding.state),
    latestRun: runs[0] ? { id: runs[0].id, state: runs[0].state, generation: Number(runs[0].binding_generation) } : null,
    activeRuns: runs.filter((run) => activeRunStates.has(clean(run.state))).map((run) => ({ id: run.id, state: run.state, role: run.role })),
  };
}

function passwdName(uid, readFile = fs.readFileSync) {
  try {
    const line = readFile("/etc/passwd", "utf8").split("\n").find((entry) => entry.split(":")[2] === String(uid));
    return line ? line.split(":")[0] : String(uid);
  } catch {
    return String(uid);
  }
}

// How V2 launches this provider for this conversation (from the selected plan).
export function nativeLaunch(plan, conversationId, native, readFile = fs.readFileSync) {
  if (!plan || !native?.nativeSessionId) return null;
  const user = passwdName(plan.executor_uid ?? plan.uid, readFile);
  if (native.provider === "claude" && plan.claude) {
    const c = plan.claude;
    return {
      user,
      cwd: c.workspace,
      env: { HOME: c.home, TMPDIR: c.temporary, CLAUDE_CONFIG_DIR: c.account },
      argv: [c.executable, "--resume", native.nativeSessionId],
    };
  }
  if (native.provider === "codex") {
    const environment = plan.managed_host?.environment || {};
    const workspace = plan.conversation_workspaces?.[conversationId]?.path || plan.workspace;
    return {
      user,
      cwd: workspace,
      env: { HOME: environment.HOME, CODEX_HOME: environment.CODEX_HOME },
      argv: [plan.native, "resume", native.nativeSessionId],
    };
  }
  return null;
}

// Local processes naming the native session id (a V2 provider run, or a
// manual resume). A Codex app-server run names no id; Core's run state covers it.
export function processesNaming(id, { fsImpl = fs, selfPid = process.pid } = {}) {
  if (!id) return [];
  const found = [];
  let pids = [];
  try {
    pids = fsImpl.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {}
  for (const pid of pids) {
    if (Number(pid) === selfPid) continue;
    let argv = [];
    try {
      argv = fsImpl.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (argv.includes(id)) found.push({ pid: Number(pid), command: path.basename(argv[0] || "") });
  }
  return found;
}

export function describeNativeTarget(target, ctx, sourceCommit = "") {
  const config = nativeAttachConfig(ctx.env, ctx.readFileImpl || fs.readFileSync);
  if (config.error || !config.coreDb) return { available: false, reason: `native target not configured (${config.file}: ${config.error || "no core_db"})` };
  let native;
  try {
    native = (ctx.readNativeSessionImpl || readNativeSession)(config.coreDb, target.conversationId, { spawnSyncImpl: ctx.spawnSyncImpl });
  } catch (error) {
    return { available: false, reason: error.message };
  }
  if (!native) return { available: false, reason: "V2 has no Deep session for this conversation yet" };
  let launch = null;
  if (config.plan) {
    const planPath = config.plan.replace("{source12}", clean(sourceCommit).slice(0, 12));
    try {
      launch = nativeLaunch(readPrivateJson(planPath, "V2 selected plan", ctx.readFileImpl || fs.readFileSync), target.conversationId, native, ctx.readFileImpl || fs.readFileSync);
    } catch {}
  }
  const processes = (ctx.processesNamingImpl || processesNaming)(native.nativeSessionId, { fsImpl: ctx.fsImpl || fs });
  const inUse = [
    ...native.activeRuns.map((run) => `v2-run ${run.id} (${run.state})`),
    ...processes.map((p) => `pid ${p.pid} (${p.command})`),
  ];
  return { available: true, ...native, launch, inUse };
}

export function formatNativeLine(native) {
  if (!native.available) return `v2-native unavailable: ${native.reason}\n`;
  const fields = [
    `v2-native provider=${native.provider}`,
    `session=${native.nativeSessionId || "none"}`,
    `binding=${native.sessionId}/g${native.generation}`,
    `state=${native.state}`,
    native.latestRun ? `latest_run=${native.latestRun.id}(${native.latestRun.state})` : "",
    `in_use=${native.inUse.length ? JSON.stringify(native.inUse.join("; ")) : "none"}`,
    native.launch ? `user=${native.launch.user} cwd=${native.launch.cwd}` : "",
    native.launch ? `command=${JSON.stringify(native.launch.argv.join(" "))}` : "",
  ];
  return `${fields.filter(Boolean).join(" ")}\n`;
}
