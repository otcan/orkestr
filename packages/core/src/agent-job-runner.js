// Durable Agent Job runner (docs/spec/agent-job.md §3, runtime-guarantees.md).
// driveRun() takes the run lease, recovers an interrupted attempt (mark it
// `interrupted`, reconcile dispatched effects), then runs attempts until the
// run is terminal or parked (awaiting approval, or backing off). Everything it
// needs to continue lives in the store, so any process can pick a run up again.
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { classifyAdapterError, getAgentJobAdapter } from "./agent-job-adapters.js";
import { finalizeRunSync, recordNotificationsSync } from "./agent-job-audit.js";
import { LeaseLost, ensureUnknownEffectApprovals, executeToolCall, reconcileDispatchedEffects } from "./agent-job-effects.js";
import { faultsFrom, injectFault } from "./agent-job-faults.js";
import { agentJobProviderStatus } from "./agent-job-providers.js";
import { expireApprovalSync, failEffectSync, listEffectsSync, pendingApprovalForRunSync, redactValue } from "./agent-job-ledger.js";
import { validateOutput } from "./agent-job-output.js";
import {
  RUN_ACTIVE_STATES,
  acquireLeaseSync,
  appendCheckpointSync,
  getPinnedSpecSync,
  getRunSync,
  insertAttemptSync,
  isTerminalRunState,
  listAttemptsSync,
  listCheckpointsSync,
  nowMs,
  openAgentJobDb,
  processHolderId,
  releaseLease,
  renewLease,
  tx,
  updateAttemptSync,
  updateRunSync,
} from "./agent-job-store.js";
import { runNativeAttempt } from "./agent-job-native-attempt.js";
import "./agent-job-claude-code.js";
import "./agent-job-tools.js";

const defaultHolder = processHolderId();
const MAX_STEPS = 200;

export function agentJobLeaseMs(env = process.env) {
  const value = Number(env.ORKESTR_AGENT_JOB_LEASE_MS || 30_000);
  return Number.isFinite(value) && value >= 20 ? Math.floor(value) : 30_000;
}

export function backoffDelayMs(retry, retryIndex) {
  const base = retry.backoff === "fixed" ? retry.initialDelayMs : retry.initialDelayMs * 2 ** Math.max(0, retryIndex);
  return Math.min(retry.maxDelayMs, base);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function withDeadline(promise, deadline) {
  const remaining = deadline - nowMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("attempt_timeout"), { kind: "timeout", retryable: true })), Math.max(0, remaining));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function snapshot(db, runId, extra = {}) {
  const run = getRunSync(db, runId);
  return { runId, state: run?.state || null, reason: run?.reason || null, output: run?.output ?? null, ...extra };
}

function counted(attempts) {
  return attempts.filter((attempt) => attempt.endReason !== "approval_wait");
}

// Interrupted repeatedly at the same journal point -> recovery_loop (G5).
function exhaustedReason(attempts) {
  const interrupted = counted(attempts).filter((attempt) => attempt.endReason === "interrupted");
  if (interrupted.length >= 2 && counted(attempts).at(-1)?.endReason === "interrupted") {
    const points = new Set(interrupted.map((attempt) => attempt.error || ""));
    if (points.size === 1) return "recovery_loop";
  }
  return "max_attempts_exhausted";
}

function interruptionPoint(db, runId, attempt) {
  const last = listCheckpointsSync(db, runId).filter((entry) => entry.attempt === attempt.n).at(-1);
  return last ? `${last.kind}:${last.data?.stepIndex ?? last.data?.tool ?? ""}` : "attempt_started";
}

async function finalize(rc, fields) {
  tx(rc.db, () => finalizeRunSync(rc.db, rc.run.id, fields, rc.secretValues, { spec: rc.spec, env: rc.env }));
  return snapshot(rc.db, rc.run.id);
}

async function park(rc, approval) {
  tx(rc.db, () => {
    updateRunSync(rc.db, rc.run.id, { state: "awaiting_approval", reason: approval.reason });
    recordNotificationsSync(rc.db, rc.run.id, rc.spec, "approval_required", {
      eventId: `approval_required:${approval.approvalId}`, detail: { approvalId: approval.approvalId, tool: approval.tool }, env: rc.env,
    });
  });
  return snapshot(rc.db, rc.run.id, { approvalId: approval.approvalId });
}

async function expire(rc, approval) {
  tx(rc.db, () => {
    expireApprovalSync(rc.db, approval.approvalId);
    failEffectSync(rc.db, approval.effectKey, { outcome: "expired" });
    recordNotificationsSync(rc.db, rc.run.id, rc.spec, "approval_expired", { eventId: `approval_expired:${approval.approvalId}`, env: rc.env });
  });
  return finalize(rc, { state: "failed", reason: "approval_expired" });
}

// One attempt with the Orkestr tool loop (or one native turn).
async function runAttempt(rc, adapter, providerRef) {
  const input = {
    prompt: rc.spec.task.prompt,
    inputs: rc.spec.task.inputs,
    triggerEvent: rc.run.trigger.event ?? null,
    outputSchema: rc.spec.task.outputSchema,
    model: providerRef.model,
    tools: rc.spec.permissions.tools,
  };
  const ctx = { runId: rc.run.id, job: rc.run.job, attempt: rc.attempt, provider: providerRef.provider, env: rc.env };
  const deadline = nowMs() + rc.spec.runtime.timeoutMs;
  if (typeof adapter.run === "function" && adapter.capabilities?.toolLoop === "native") {
    return runNativeAttempt(rc, adapter, providerRef, input, deadline);
  }
  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    const run = getRunSync(rc.db, rc.run.id);
    if (run.cancelRequestedAt) return { type: "cancelled" };
    const transcript = listCheckpointsSync(rc.db, rc.run.id, ["message", "tool_result"]).map((entry) => entry.data);
    const step = await withDeadline(adapter.step(ctx, { input, transcript }), deadline);
    if (step.type === "final") return step;
    if (step.type === "message") {
      tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "message", { stepIndex: step.stepIndex, text: redactValue(String(step.text || ""), rc.secretValues).slice(0, 4000) }));
      continue;
    }
    tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "tool_requested", { stepIndex: step.stepIndex, tool: step.tool }));
    injectFault(rc.faults, "tool_requested", { attempt: rc.attempt, tool: step.tool });
    const result = await executeToolCall(rc, step);
    if (["park", "expired", "cancelled"].includes(result.status)) return { type: result.status, approval: result.approval };
    tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "tool_result", {
      stepIndex: step.stepIndex, tool: step.tool, status: result.status, ref: result.ref ?? null, error: result.error ?? null,
    }));
  }
  throw Object.assign(new Error("max_steps_exceeded"), { kind: "task", retryable: false });
}

async function recover(rc, attempts) {
  const last = attempts.at(-1);
  if (!last || !["starting", "running"].includes(last.state)) return;
  tx(rc.db, () => {
    const point = interruptionPoint(rc.db, rc.run.id, last);
    updateAttemptSync(rc.db, rc.run.id, last.n, { state: "interrupted", endReason: "interrupted", error: point });
    appendCheckpointSync(rc.db, rc.run.id, last.n, "attempt_interrupted", { n: last.n, at: point });
  });
  await reconcileDispatchedEffects({ ...rc, attempt: last.n }, listEffectsSync(rc.db, rc.run.id));
}

async function driveLeased(rc, options) {
  for (;;) {
    const run = getRunSync(rc.db, rc.run.id);
    rc.run = run;
    if (isTerminalRunState(run.state)) return snapshot(rc.db, run.id);
    rc.spec = getPinnedSpecSync(rc.db, run.specHash); // G8: the pinned spec, never the current file
    if (run.cancelRequestedAt) return finalize(rc, { state: "cancelled", reason: "cancel_requested" });
    let attempts = listAttemptsSync(rc.db, run.id);
    await recover(rc, attempts);
    attempts = listAttemptsSync(rc.db, run.id);

    const unknown = ensureUnknownEffectApprovals({ ...rc, attempt: attempts.at(-1)?.n ?? null }).filter((approval) => approval.state === "pending");
    const pending = unknown[0] || pendingApprovalForRunSync(rc.db, run.id);
    if (pending) {
      if (pending.expiresAtMs <= nowMs()) return expire(rc, pending);
      return park(rc, pending);
    }
    if (run.state === "retrying" && Number(run.nextAttemptAt || 0) > nowMs()) {
      const wait = Number(run.nextAttemptAt) - nowMs();
      if (!options.waitForBackoff || wait > (options.maxBackoffWaitMs ?? 60_000)) return snapshot(rc.db, run.id, { nextAttemptAt: run.nextAttemptAt });
      await sleep(wait);
      continue;
    }
    if (rc.spec.runtime.concurrency === "queue") {
      const older = rc.db.prepare(`select id from runs where job = ? and id != ? and created_at < ? and state in (${RUN_ACTIVE_STATES.map(() => "?").join(",")}) limit 1`)
        .get(run.job, run.id, run.createdAt, ...RUN_ACTIVE_STATES);
      if (older) return snapshot(rc.db, run.id, { queuedBehind: older.id });
    }
    if (counted(attempts).length >= rc.spec.runtime.maxAttempts) {
      return finalize(rc, { state: "failed", reason: exhaustedReason(attempts) });
    }

    const chain = [{ provider: rc.spec.agent.provider, model: rc.spec.agent.model }, ...rc.spec.agent.fallback];
    const providerIndex = Math.min(run.providerIndex, chain.length - 1);
    const providerRef = chain[providerIndex];
    const n = (attempts.at(-1)?.n || 0) + 1;
    rc.attempt = n;
    tx(rc.db, () => {
      insertAttemptSync(rc.db, run.id, n, { provider: providerRef.provider, model: providerRef.model, resumedFromSeq: attempts.at(-1)?.lastSeq ?? null });
      updateAttemptSync(rc.db, run.id, n, { state: "running" });
      updateRunSync(rc.db, run.id, { state: "running", reason: null, attemptCount: counted(attempts).length + 1, nextAttemptAt: null });
      appendCheckpointSync(rc.db, run.id, n, "attempt_started", { n, provider: providerRef.provider });
    });
    injectFault(rc.faults, "attempt_started", { attempt: n });

    let outcome;
    try {
      // Never start an attempt on a provider that is not connected.
      const status = await agentJobProviderStatus(providerRef.provider, rc.env);
      if (!status.runnable) throw Object.assign(new Error(`provider_not_connected:${providerRef.provider}:${status.reason}`), { kind: "provider", retryable: false });
      const adapter = getAgentJobAdapter(providerRef.provider, rc.env);
      if (!adapter) throw Object.assign(new Error(`provider_not_available:${providerRef.provider}`), { kind: "provider", retryable: false });
      outcome = await runAttempt(rc, adapter, providerRef);
    } catch (error) {
      if (error?.injectedCrash || error?.leaseLost) throw error;
      outcome = { type: "error", error: classifyAdapterError(error) };
    }

    if (outcome.type === "final") {
      const invalid = validateOutput(rc.spec.task.outputSchema, outcome.output);
      tx(rc.db, () => {
        updateAttemptSync(rc.db, run.id, n, { state: "completed", endReason: "completed" });
        appendCheckpointSync(rc.db, run.id, n, "final_output", { valid: !invalid });
      });
      injectFault(rc.faults, "final_output", { attempt: n });
      if (invalid) return finalize(rc, { state: "failed", reason: "output_invalid", output: outcome.output, error: invalid });
      return finalize(rc, { state: "succeeded", output: outcome.output });
    }
    if (outcome.type === "park") {
      tx(rc.db, () => updateAttemptSync(rc.db, run.id, n, { state: "completed", endReason: "approval_wait" }));
      injectFault(rc.faults, "approval_requested", { attempt: n });
      return park(rc, outcome.approval);
    }
    if (outcome.type === "expired") {
      tx(rc.db, () => updateAttemptSync(rc.db, run.id, n, { state: "failed", endReason: "approval_wait" }));
      return expire(rc, outcome.approval);
    }
    if (outcome.type === "cancelled") {
      tx(rc.db, () => updateAttemptSync(rc.db, run.id, n, { state: "failed", endReason: "cancelled" }));
      return finalize(rc, { state: "cancelled", reason: "cancel_requested" });
    }

    const { kind, retryable, message } = outcome.error;
    const safeMessage = redactValue(message, rc.secretValues);
    const endReason = kind === "provider" ? "provider_error" : kind === "timeout" ? "timeout" : "task_error";
    tx(rc.db, () => updateAttemptSync(rc.db, run.id, n, { state: kind === "timeout" ? "timed_out" : "failed", endReason, error: safeMessage }));
    const hasFallback = kind === "provider" && providerIndex + 1 < chain.length;
    const used = counted(listAttemptsSync(rc.db, run.id)).length;
    if ((!retryable && !hasFallback) || used >= rc.spec.runtime.maxAttempts) {
      return finalize(rc, { state: "failed", reason: used >= rc.spec.runtime.maxAttempts && retryable ? "max_attempts_exhausted" : endReason, error: safeMessage });
    }
    const delay = backoffDelayMs(rc.spec.runtime.retry, used - 1);
    tx(rc.db, () => {
      updateRunSync(rc.db, run.id, { state: "retrying", reason: endReason, providerIndex: hasFallback ? providerIndex + 1 : providerIndex, nextAttemptAt: nowMs() + delay });
      appendCheckpointSync(rc.db, run.id, n, "retry_scheduled", { delayMs: delay, fallback: hasFallback, kind });
      recordNotificationsSync(rc.db, run.id, rc.spec, "retrying", { eventId: `retrying:${n}`, detail: { attempt: n }, env: rc.env });
    });
  }
}

/**
 * Drive one run until it is terminal or parked. Returns a snapshot
 * { runId, state, reason, output, approvalId?, nextAttemptAt?, leased? }.
 * options: holder, leaseMs, faults, waitForBackoff, secretValues, baseDir.
 */
export async function driveRun(runId, options = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  const holder = options.holder || defaultHolder;
  const leaseMs = options.leaseMs ?? agentJobLeaseMs(env);
  if (!tx(db, () => acquireLeaseSync(db, runId, holder, leaseMs))) return snapshot(db, runId, { leased: false });
  const rc = {
    db, env, holder, run: getRunSync(db, runId), spec: null, attempt: null,
    faults: faultsFrom(options, env),
    secretValues: Array.isArray(options.secretValues) ? options.secretValues.filter(Boolean) : [],
    home: (await ensureDataDirs(env)).home,
    baseDir: options.baseDir || jobBaseDir(db, runId),
  };
  let crashed = false;
  const heartbeat = setInterval(() => { void renewLease(runId, holder, leaseMs, env).catch(() => {}); }, Math.max(10, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  try {
    return await driveLeased(rc, options);
  } catch (error) {
    if (error?.injectedCrash) {
      crashed = true;
      // In-process stand-in for kill -9: no cleanup writes. The lease is
      // expired so the "restarted" driver can take over, as it would after
      // detecting the dead pid of a real crashed process.
      db.prepare("update runs set lease_expires_at = 0 where id = ? and lease_holder = ?").run(runId, holder);
    }
    if (error instanceof LeaseLost) crashed = true;
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (!crashed) await releaseLease(runId, holder, env).catch(() => {});
  }
}

function jobBaseDir(db, runId) {
  const row = db.prepare("select j.source from runs r left join jobs j on j.name = r.job where r.id = ?").get(runId);
  return row?.source ? path.dirname(row.source) : process.cwd();
}

// Drive every run that can make progress now: new, retry-due, interrupted
// (lease expired or holder dead), approval decided, or cancel requested.
export async function driveDueRuns(options = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  const rows = db.prepare(`select id from runs where state in (${RUN_ACTIVE_STATES.map(() => "?").join(",")}) order by created_at, rowid`).all(...RUN_ACTIVE_STATES);
  const results = [];
  for (const row of rows) {
    const run = getRunSync(db, row.id);
    if (run.state === "awaiting_approval" && !run.cancelRequestedAt) {
      const pending = pendingApprovalForRunSync(db, run.id);
      if (pending && pending.expiresAtMs > nowMs()) continue;
    }
    if (run.state === "retrying" && Number(run.nextAttemptAt || 0) > nowMs() && !run.cancelRequestedAt) continue;
    try {
      results.push(await driveRun(run.id, options, env));
    } catch (error) {
      if (error?.injectedCrash) throw error;
      results.push({ runId: run.id, state: run.state, error: error?.message || String(error) });
    }
  }
  return results;
}
