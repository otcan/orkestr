// The native provider session behind a V2 conversation, read-only.
//
// V2 runs a conversation's Deep agent as one native provider session (Claude
// Code session or Codex thread), resumed by every Deep run. This reads which
// one it is from Core (the Deep session binding and its latest run) and, when
// the deployment's selected plan is configured, how V2 launches it (user, cwd,
// binary, config dir). It also reports whether the session is in use now: a
// running V2 run, or any local process naming the session id.
//
// Nothing here writes. Opening the session interactively (v2-native-attach.js)
// needs the V2 server's native-attach hold, so V2 never resumes it at the
// same time.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readPrivateJson } from "./v2-owner-session.js";
import { readHold } from "./v2-native-hold.js";

export const defaultNativeAttachConfigPath = "/etc/orkestr/v2-native-attach.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeRunStates = new Set(["starting", "running", "cancel_requested"]);

function clean(value) {
  return String(value ?? "").trim();
}

// Host config: {"core_db": "<core.sqlite3>", "plan": "<selected plan path, {source12} = live V2 build>",
// "hold_dir": "<dir the V2 server reads holds from>", "hold_group": "<group the server reads through>",
// "namespace_unit": "<systemd unit whose mount namespace V2 runs providers in>", "audit_log": "<jsonl>"}.
export function nativeAttachConfig(env = process.env, readFile = fs.readFileSync) {
  const file = clean(env.ORKESTR_V2_NATIVE_ATTACH_CONFIG) || defaultNativeAttachConfigPath;
  try {
    const value = readPrivateJson(file, "V2 native attach config", readFile);
    return {
      file,
      coreDb: clean(value.core_db),
      plan: clean(value.plan),
      holdDir: clean(value.hold_dir),
      holdGroup: clean(value.hold_group),
      namespaceUnit: clean(value.namespace_unit),
      auditLog: clean(value.audit_log),
    };
  } catch (error) {
    return { file, error: error.code || error.message };
  }
}

export function groupId(name, readFile = fs.readFileSync) {
  if (!name) return null;
  try {
    const line = readFile("/etc/group", "utf8").split("\n").find((entry) => entry.split(":")[0] === name);
    const gid = line ? Number(line.split(":")[2]) : NaN;
    return Number.isInteger(gid) ? gid : null;
  } catch {
    return null;
  }
}

// The selected plan for the live V2 build, or null.
export function readSelectedPlan(config, sourceCommit, readFile = fs.readFileSync) {
  if (!config?.plan || !clean(sourceCommit)) return null;
  try {
    return readPrivateJson(config.plan.replace("{source12}", clean(sourceCommit).slice(0, 12)), "V2 selected plan", readFile);
  } catch {
    return null;
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
      argv: [c.executable, "--resume", native.nativeSessionId, "--dangerously-skip-permissions"],
    };
  }
  if (native.provider === "codex") {
    const environment = plan.managed_host?.environment || {};
    const workspace = plan.conversation_workspaces?.[conversationId]?.path || plan.workspace;
    return {
      user,
      cwd: workspace,
      env: { HOME: environment.HOME, CODEX_HOME: environment.CODEX_HOME },
      argv: [plan.output ? `${String(plan.output).replace(/\/+$/, "")}/package/native` : plan.native, "--dangerously-bypass-approvals-and-sandbox", "resume", native.nativeSessionId],
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
  const plan = readSelectedPlan(config, sourceCommit, ctx.readFileImpl || fs.readFileSync);
  if (plan) {
    try {
      launch = nativeLaunch(plan, target.conversationId, native, ctx.readFileImpl || fs.readFileSync);
    } catch {}
  }
  const processes = (ctx.processesNamingImpl || processesNaming)(native.nativeSessionId, { fsImpl: ctx.fsImpl || fs });
  let hold = null;
  if (config.holdDir) {
    const record = (ctx.readHoldImpl || readHold)(config.holdDir, target.conversationId, { fsImpl: ctx.fsImpl || fs });
    if (record?.live) hold = { holderPid: record.holder_pid, acquiredAtMs: record.acquired_at_ms, expiresAtMs: record.expires_at_ms };
  }
  const inUse = [
    ...native.activeRuns.map((run) => `v2-run ${run.id} (${run.state})`),
    ...processes.map((p) => `pid ${p.pid} (${p.command})`),
    ...(hold ? [`terminal hold pid ${hold.holderPid}`] : []),
  ];
  return { available: true, ...native, launch, inUse, hold };
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
    native.holdSupported === undefined ? "" : `native_attach=${native.holdSupported ? "available" : "needs-v2-hold"}`,
  ];
  return `${fields.filter(Boolean).join(" ")}\n`;
}
