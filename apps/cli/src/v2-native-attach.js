// `orkestr attach <V2 chat>`: the chat's native provider session in this
// terminal, with V2 holding off until the terminal hands back.
//
//  1. Hold: write the native-attach hold (v2-native-hold.js). From then on
//     the V2 server queues every input for the chat instead of starting work.
//  2. Drain: wait until the server reports the hold and no run or window is
//     active (an active V2 run finishes first; --interrupt stops it with the
//     guarded owner Stop). Other terminals and processes on the same native
//     session are refused unless --takeover.
//  3. Open: the provider's own TUI resume, in V2's mount namespace as V2's
//     executor (v2-native-launch.js), renewing the hold every 30 s.
//  4. Hand back: on exit the hold is released; the first V2 run afterwards is
//     told the owner worked in the session; queued inputs run on it.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { buildNativeLaunch } from "./v2-native-launch.js";
import { acquireHold, readHold, releaseHold, renewHold, RENEW_MS } from "./v2-native-hold.js";
import { groupId, nativeAttachConfig, processesNaming, readNativeSession, readSelectedPlan } from "./v2-native-target.js";
import { v2AttachError } from "./v2-owner-session.js";

export const NATIVE_FEATURE = "native_attach_hold_v1";
const activePhases = new Set(["queued", "starting", "running", "cancel_requested", "stopping"]);
const drainPollMs = 3000;
const defaultDrainTimeoutMs = 15 * 60_000;

function clean(value) {
  return String(value ?? "").trim();
}

function servicePid(unit, execFile = execFileSync) {
  if (!unit) return 0;
  try {
    return Number(String(execFile("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8" })).trim()) || 0;
  } catch {
    return 0;
  }
}

async function readJson(session, path) {
  const response = await session.call("GET", path).catch(() => null);
  return response ? { status: response.status, json: response.json } : { status: 0, json: null };
}

// Whether V2 currently does anything on the conversation, as the server sees it.
async function v2Activity(session, target) {
  const base = `/api/v2/conversations/${target.conversationId}`;
  const [execution, window, hold] = await Promise.all([readJson(session, `${base}/execution`), readJson(session, `${base}/window`), readJson(session, `${base}/native-attach`)]);
  const phase = execution.status === 200 ? clean(execution.json?.phase) || "idle" : "idle";
  const windowState = window.status === 200 ? clean(window.json?.state) : "none";
  return {
    phase,
    runId: execution.json?.run_id || null,
    execution: execution.json || {},
    windowState,
    held: hold.status === 200 && hold.json?.held === true,
    busy: activePhases.has(phase) || !["none", "closed"].includes(windowState),
  };
}

async function guardedStop(session, target, activity, emit) {
  const status = activity.execution;
  if (!status.run_id) return;
  const body = { run_id: status.run_id, expected_revision: status.revision ?? status.conversation_revision, request_key: `cli-attach-interrupt-${randomUUID()}` };
  if (status.control_revision !== undefined) body.expected_control_revision = status.control_revision;
  const response = await session.call("POST", `/api/v2/conversations/${target.conversationId}/stop`, body).catch(() => null);
  emit(response && response.status < 300
    ? `Stopping V2 run ${status.run_id} (owner Stop). Inputs queued behind it are held by V2's Stop rule; resend or admit them in the chat afterwards.\n`
    : `Owner Stop refused (HTTP ${response?.status || 0}); waiting for the run to finish instead.\n`);
}

export async function runNativeAttach(target, session, agent, ctx, { takeover = false, interrupt = false, timeoutMs = 0, sourceCommit = "" } = {}) {
  const emit = (text) => ctx.stderr.write(text);
  const sleep = ctx.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = ctx.nowImpl || Date.now;
  const readFile = ctx.readFileImpl || fs.readFileSync;
  const fsImpl = ctx.fsImpl || fs;
  if ((ctx.uid ?? process.getuid?.()) !== 0) throw v2AttachError("v2_attach_root_required", "opening a V2 native session needs root: sudo orkestr attach ...");
  if (!ctx.stdin?.isTTY) throw v2AttachError("v2_attach_tty_required", "opening the native session needs an interactive terminal; use --print to inspect");
  const config = nativeAttachConfig(ctx.env, readFile);
  if (config.error || !config.coreDb || !config.holdDir || !config.plan) throw v2AttachError("v2_native_attach_unavailable", `native attach is not configured (${config.file})`);
  const native = (ctx.readNativeSessionImpl || readNativeSession)(config.coreDb, target.conversationId, { spawnSyncImpl: ctx.spawnSyncImpl });
  if (!native?.nativeSessionId) throw v2AttachError("v2_native_attach_unavailable", "V2 has no native Deep session for this chat yet");
  const plan = (ctx.readSelectedPlanImpl || readSelectedPlan)(config, sourceCommit, readFile);
  const launch = buildNativeLaunch({ plan, native, conversationId: target.conversationId, settings: agent.settings || { model: agent.model, reasoning_effort: agent.reasoningEffort }, namespacePid: (ctx.servicePidImpl || servicePid)(config.namespaceUnit), env: ctx.env, readFile });
  const gid = groupId(config.holdGroup, readFile);
  const record = await acquireHold({ dir: config.holdDir, gid, native, conversationId: target.conversationId, fsImpl, now, kill: ctx.killImpl || process.kill, sleep, takeover });
  let released = false;
  let opened = false;
  const release = (reason, extra = {}) => {
    if (released) return;
    released = true;
    releaseHold(config.holdDir, record, { fsImpl, now, gid, auditLog: config.auditLog, reason, opened, extra: { thread_id: target.threadId || null, ...extra } });
  };
  let renewTimer = null;
  try {
    // Drain: from here on V2 queues the chat's inputs.
    const deadline = now() + (timeoutMs || defaultDrainTimeoutMs);
    let stopped = false;
    let last = "";
    for (;;) {
      const activity = await (ctx.v2ActivityImpl || v2Activity)(session, target);
      if (activity.held && !activity.busy) break;
      const line = activity.held ? `V2 is still working on this chat (${activity.phase}, window ${activity.windowState}); waiting for it to finish...` : "Waiting for V2 to confirm the hold...";
      if (line !== last) emit(`${line}\n`);
      last = line;
      if (interrupt && activity.held && activity.runId && !stopped) {
        stopped = true;
        await guardedStop(session, target, activity, emit);
      }
      if (now() >= deadline) throw v2AttachError("v2_native_attach_timeout", "V2 did not become idle in time; nothing was opened, the hold is released");
      renewHold(config.holdDir, record, { fsImpl, now, gid });
      await sleep(drainPollMs);
    }
    // V2 is idle now, so any process still naming the session (after a short
    // grace for a finished run's provider to exit) is another terminal.
    let strangers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      strangers = (ctx.processesNamingImpl || processesNaming)(native.nativeSessionId, { fsImpl });
      if (!strangers.length) break;
      await sleep(1000);
    }
    if (strangers.length && !takeover) {
      throw v2AttachError("v2_native_open_elsewhere", `the ${native.provider} session ${native.nativeSessionId} is open in another process (${strangers.map((p) => `pid ${p.pid} ${p.command}`).join(", ")}); rerun with --takeover to close it`);
    }
    for (const stranger of strangers) {
      try {
        (ctx.killImpl || process.kill)(stranger.pid, "SIGTERM");
      } catch {}
    }
    const hold = readHold(config.holdDir, target.conversationId, { fsImpl, now: now() });
    if (!hold?.live || hold.holder_pid !== record.holder_pid) throw v2AttachError("v2_native_hold_lost", "the hold was taken over before the session opened");
    emit(`Opening the ${native.provider} session ${native.nativeSessionId} of ${target.name ? `"${target.name}"` : target.conversationId}: V2's own native session, as V2's executor in V2's file namespace, without the orkestr_managed tools. V2 queues the chat's messages until you leave; exit the session to hand back.\n`);
    let child = null;
    renewTimer = setInterval(() => {
      let ok = false;
      try {
        ok = renewHold(config.holdDir, record, { fsImpl, now, gid });
      } catch {}
      // A lost hold means V2 may resume the session: never keep a second writer.
      if (!ok && child) {
        emit("\nThe hold was lost (taken over or expired); closing this terminal session so V2 is the only writer.\n");
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }, ctx.renewMs || RENEW_MS);
    renewTimer.unref?.();
    const startedAt = now();
    const code = await new Promise((resolve, reject) => {
      child = (ctx.spawnImpl)(launch.command, launch.args, { stdio: "inherit" });
      opened = true;
      const forward = (signal) => {
        try {
          child.kill(signal);
        } catch {}
      };
      process.on("SIGHUP", forward);
      process.on("SIGTERM", forward);
      child.on("error", (error) => {
        process.off("SIGHUP", forward);
        process.off("SIGTERM", forward);
        reject(error);
      });
      child.on("exit", (exitCode, signal) => {
        process.off("SIGHUP", forward);
        process.off("SIGTERM", forward);
        resolve(exitCode ?? (signal ? 128 : 1));
      });
    });
    clearInterval(renewTimer);
    renewTimer = null;
    release("exited", { exit_code: code, opened_at_ms: startedAt });
    emit(`Handed back to V2 at ${new Date(now()).toISOString()}. Queued messages for this chat now run on the same session.\n`);
    return 0;
  } catch (error) {
    if (renewTimer) clearInterval(renewTimer);
    release(error?.code || "failed");
    throw error;
  }
}
