// Runner side of native provider attempts (toolLoop "native": codex,
// claude-code). Builds the context of the shared executor interface
// (agent-job-native-interface.js) and maps the executor's outcome back onto
// the runner: progress into the run journal, per-call tool authorization under
// the pinned job policy, the approval pause, cancel / timeout / lost lease
// through ctx.signal, and the previous attempt's provider session for resume.
import { LeaseLost, executeToolCall } from "./agent-job-effects.js";
import { injectFault } from "./agent-job-faults.js";
import {
  argsHashFor,
  consumeApprovalSync,
  createApprovalSync,
  effectKeyFor,
  expireApprovalSync,
  findApprovalSync,
  listApprovalsSync,
  listEffectsSync,
  redactValue,
} from "./agent-job-ledger.js";
import { nativeEffectGrantedSync, settleNativeEffect } from "./agent-job-native-effects.js";
import { nativeTimeoutError } from "./agent-job-native-interface.js";
import { agentJobToolDecision } from "./agent-job-spec.js";
import { appendCheckpointSync, getRunSync, holdsLeaseSync, listCheckpointsSync, nowMs, tx } from "./agent-job-store.js";
import { agentJobWorkspacePath, prepareAgentJobWorkspace } from "./agent-job-workspace.js";

const MAX_PROGRESS_PER_ATTEMPT = 200;
const POLL_MS = 200;

// The provider session of the most recent attempt on the same provider.
export function lastNativeSession(db, runId, provider) {
  const started = listCheckpointsSync(db, runId, ["session_started"]).filter((entry) => entry.data?.provider === provider);
  const last = started.at(-1);
  return last?.data?.sessionRef ? { sessionRef: last.data.sessionRef, attempt: last.attempt ?? null } : null;
}

function resumeReason(db, runId) {
  const attempts = db.prepare("select end_reason from attempts where run_id = ? order by n desc limit 2").all(runId);
  const previous = attempts[1]?.end_reason || "";
  return previous === "approval_wait" ? "after an approval decision" : previous ? `after the previous attempt ended: ${previous}` : "new attempt";
}

/**
 * The tool-permission hook for provider-native calls (ctx.authorizeTool).
 * approval_required calls bind an approval to (tool, args) and consume it
 * once, as for Orkestr tools. An approved call that is granted is recorded in
 * the effect ledger (agent-job-native-effects.js); allowed calls are not.
 */
export function authorizeNativeToolCall(rc, { tool, args = {}, callId = "" }) {
  return tx(rc.db, () => {
    const run = getRunSync(rc.db, rc.run.id);
    if (run?.cancelRequestedAt) return { decision: "cancelled" };
    if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) return { decision: "deny", reason: "the Orkestr run lease was lost" };
    const decision = agentJobToolDecision(rc.spec, tool);
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "tool_decision", { tool, decision, native: true, callId: String(callId).slice(0, 120) });
    if (decision === "allow") return { decision: "allow" };
    if (decision !== "approval_required") return { decision: "deny", reason: `${tool} is not allowed by this job's permissions.tools` };
    const plainArgs = args && typeof args === "object" ? args : {};
    const argsHash = argsHashFor(plainArgs);
    const effectKey = effectKeyFor(rc.run.id, tool, ["native", argsHash]);
    const approval = findApprovalSync(rc.db, effectKey, argsHash);
    if (approval && !approval.consumedAt) {
      if (approval.state === "pending") {
        if (approval.expiresAtMs <= nowMs()) return { decision: "expired", approval: expireApprovalSync(rc.db, approval.approvalId) };
        return { decision: "pending", approval };
      }
      if (approval.state === "approved" && consumeApprovalSync(rc.db, approval.approvalId)) {
        appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_consumed", { approvalId: approval.approvalId, effectKey, tool });
        nativeEffectGrantedSync(rc, { tool, args: redactValue(plainArgs, rc.secretValues), argsHash, effectKey, callId, approvalId: approval.approvalId });
        return { decision: "allow" };
      }
      if (approval.state === "denied") return { decision: "deny", reason: `a person denied ${tool} with these arguments` };
      if (approval.state === "expired") return { decision: "expired", approval };
    }
    const created = createApprovalSync(rc.db, {
      runId: rc.run.id, effectKey, argsHash, tool, args: redactValue(plainArgs, rc.secretValues), reason: "approval_required", ttlMs: rc.spec.runtime.approvalTimeoutMs,
    });
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_requested", { approvalId: created.approvalId, effectKey, tool, reason: "approval_required", native: true });
    return { decision: "pending", approval: created };
  });
}

// ctx.emit: one NATIVE_EVENT_TYPES event -> one redacted journal checkpoint.
function journal(rc, provider) {
  let seq = 0;
  let progress = 0;
  const write = (kind, data) => tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, kind, data));
  const text = (value, max = 2000) => redactValue(String(value || ""), rc.secretValues).slice(0, max);
  const callId = (value) => String(value || "").slice(0, 120);
  return (event = {}) => {
    seq += 1;
    const at = new Date().toISOString();
    if (event.type === "tool.completed") settleNativeEffect(rc, event);
    if (event.type === "session.started") return write("session_started", { seq, at, provider, sessionRef: String(event.sessionRef || ""), resumed: event.resumed === true });
    if (event.type === "workspace.ready") return write("workspace", { path: String(event.path || ""), kind: String(event.kind || "directory") });
    if (event.type === "usage") return write("usage", { seq, at, inputTokens: Number(event.inputTokens || 0), outputTokens: Number(event.outputTokens || 0), costUsd: event.costUsd ?? null });
    if (event.type === "output.repair") return write("output_repair", { seq, at, error: text(event.error, 500) });
    if (progress >= MAX_PROGRESS_PER_ATTEMPT) return null;
    progress += 1;
    if (event.type === "message.completed" || event.type === "message.delta") return write("progress", { seq, at, type: "message", text: text(event.text) });
    if (event.type === "tool.requested") return write("progress", { seq, at, type: "tool", tool: String(event.tool || "").slice(0, 200), callId: callId(event.callId) });
    if (event.type === "tool.completed") return write("progress", { seq, at, type: "tool_result", tool: String(event.tool || "").slice(0, 200), ok: event.ok === true, callId: callId(event.callId) });
    return null;
  };
}

export function nativeAttemptContext(rc, providerRef, signal) {
  const provider = providerRef.provider;
  const previous = lastNativeSession(rc.db, rc.run.id, provider);
  return {
    runId: rc.run.id,
    job: rc.run.job,
    attempt: rc.attempt,
    provider,
    env: rc.env,
    home: rc.home,
    baseDir: rc.baseDir,
    workspace: agentJobWorkspacePath(rc.home, rc.run.job, rc.run.id),
    prepareWorkspace: (input = {}) => prepareAgentJobWorkspace({ home: rc.home, baseDir: rc.baseDir, job: rc.run.job, runId: rc.run.id, inputs: input.inputs }),
    resume: previous ? { ...previous, reason: resumeReason(rc.db, rc.run.id) } : null,
    signal,
    emit: journal(rc, provider),
    authorizeTool: (call) => authorizeNativeToolCall(rc, call),
    executeTool: (call) => executeToolCall(rc, call),
    toolDecision: (tool) => agentJobToolDecision(rc.spec, tool),
    fault: (point, extra = {}) => injectFault(rc.faults, point, { attempt: rc.attempt, ...extra }),
  };
}

/**
 * Run one native attempt. Returns a runner outcome:
 * { type: "final", output } | { type: "park"|"expired", approval } | { type: "cancelled" }.
 * Throws a timeout error, LeaseLost, or the executor's classified error.
 */
export async function runNativeAttempt(rc, adapter, providerRef, input, deadline) {
  const effects = listEffectsSync(rc.db, rc.run.id).filter((effect) => effect.state === "committed");
  if (effects.length) input.resumeSummary = effects.map((effect) => `${effect.tool}: ${effect.ref || "done"}`).join("\n");
  // Approved but not yet executed: the resumed agent must retry exactly these
  // calls, not reach the same result through another tool.
  const approved = listApprovalsSync(rc.db, rc.run.id).filter((approval) => approval.state === "approved" && approval.reason === "approval_required" && !approval.consumedAt);
  if (approved.length) input.approvedCalls = approved.map((approval) => `${approval.tool} ${JSON.stringify(approval.args)}`.slice(0, 2000)).join("\n");
  const controller = new AbortController();
  // A cooperative executor gets a grace period to interrupt its turn; one
  // that ignores the signal (executor-registry turns) is not awaited.
  const graceMs = adapter.capabilities?.interrupt === "cooperative" ? 10_000 : 5_000;
  let settleAbort;
  const aborted = new Promise((resolve) => { settleAbort = resolve; });
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    setTimeout(() => settleAbort({ aborted: reason }), graceMs).unref?.();
  };
  const poll = setInterval(() => {
    try {
      if (getRunSync(rc.db, rc.run.id)?.cancelRequestedAt) abort("cancelled");
      else if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) abort("lease_lost");
    } catch {}
  }, POLL_MS);
  const timer = setTimeout(() => abort("timeout"), Math.max(0, deadline - nowMs()));
  const ctx = nativeAttemptContext(rc, providerRef, controller.signal);
  try {
    const result = await Promise.race([adapter.run(ctx, input), aborted]);
    if (result?.type === "park" || result?.type === "expired") return { type: result.type, approval: result.approval };
    const reason = controller.signal.aborted ? controller.signal.reason : result?.type === "cancelled" ? "cancelled" : "";
    if (reason === "cancelled") return { type: "cancelled" };
    if (reason === "lease_lost") throw new LeaseLost();
    if (reason) throw nativeTimeoutError();
    return { type: "final", output: result?.output ?? null };
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
  }
}
