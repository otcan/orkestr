// Runner side of native provider attempts (toolLoop "native", e.g. Claude
// Code). Supplies the adapter ctx from docs/spec/adapter-interface.md:
//   workspace     internal job workspace ORKESTR_HOME/agent-jobs/workspaces/<run>
//   signal        aborted on cancel ("cancelled"), timeout or a lost lease
//   emit(event)   progress into the run journal (checkpoints)
//   authorizeTool per-call decision under the pinned job policy (G6/G7)
// and resumes the provider session of the previous attempt when the adapter
// declares resume "session".
import path from "node:path";
import { LeaseLost } from "./agent-job-effects.js";
import {
  argsHashFor,
  consumeApprovalSync,
  createApprovalSync,
  effectKeyFor,
  expireApprovalSync,
  findApprovalSync,
  listEffectsSync,
  redactValue,
} from "./agent-job-ledger.js";
import { agentJobToolDecision } from "./agent-job-spec.js";
import { appendCheckpointSync, getRunSync, holdsLeaseSync, listCheckpointsSync, nowMs, tx } from "./agent-job-store.js";

const MAX_PROGRESS_PER_ATTEMPT = 200;
const POLL_MS = 200;

export function agentJobWorkspace(home, runId) {
  return path.join(home, "agent-jobs", "workspaces", String(runId).replace(/[^A-Za-z0-9_-]/g, "_"));
}

// The provider session of the most recent attempt on the same provider.
export function lastNativeSessionRef(db, runId, provider) {
  const started = listCheckpointsSync(db, runId, ["session_started"]).filter((entry) => entry.data?.provider === provider);
  return started.at(-1)?.data?.sessionRef || "";
}

function resumeReason(db, runId) {
  const attempts = db.prepare("select end_reason from attempts where run_id = ? order by n desc limit 2").all(runId);
  const previous = attempts[1]?.end_reason || "";
  return previous === "approval_wait" ? "after an approval decision" : previous ? `after the previous attempt ended: ${previous}` : "new attempt";
}

/**
 * Authorize one provider tool call. Returns
 *   { decision: "allow" } | { decision: "deny", reason }
 *   { decision: "pending", approval } (park the run) | { decision: "expired", approval }
 *   { decision: "cancelled" }
 * approval_required calls bind an approval to (tool, args) and consume it
 * once, as for Orkestr tools; native calls are not effect-ledgered.
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
    const safeArgs = redactValue(args && typeof args === "object" ? args : {}, rc.secretValues);
    const argsHash = argsHashFor(args && typeof args === "object" ? args : {});
    const effectKey = effectKeyFor(rc.run.id, tool, ["native", argsHash]);
    const approval = findApprovalSync(rc.db, effectKey, argsHash);
    if (approval && !approval.consumedAt) {
      if (approval.state === "pending") {
        if (approval.expiresAtMs <= nowMs()) return { decision: "expired", approval: expireApprovalSync(rc.db, approval.approvalId) };
        return { decision: "pending", approval };
      }
      if (approval.state === "approved" && consumeApprovalSync(rc.db, approval.approvalId)) {
        appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_consumed", { approvalId: approval.approvalId, effectKey, tool });
        return { decision: "allow" };
      }
      if (approval.state === "denied") return { decision: "deny", reason: `a person denied ${tool} with these arguments` };
      if (approval.state === "expired") return { decision: "expired", approval };
    }
    const created = createApprovalSync(rc.db, {
      runId: rc.run.id, effectKey, argsHash, tool, args: safeArgs, reason: "approval_required", ttlMs: rc.spec.runtime.approvalTimeoutMs,
    });
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_requested", { approvalId: created.approvalId, effectKey, tool, reason: "approval_required", native: true });
    return { decision: "pending", approval: created };
  });
}

function journal(rc) {
  let seq = 0;
  let progress = 0;
  const write = (kind, data) => tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, kind, data));
  const text = (value) => redactValue(String(value || ""), rc.secretValues).slice(0, 2000);
  return (event = {}) => {
    seq += 1;
    const at = new Date().toISOString();
    if (event.type === "session.started") return write("session_started", { seq, at, provider: rc.providerRef.provider, sessionRef: String(event.sessionRef || "") });
    if (event.type === "usage") return write("usage", { seq, at, inputTokens: Number(event.inputTokens || 0), outputTokens: Number(event.outputTokens || 0), costUsd: event.costUsd ?? null });
    if (progress >= MAX_PROGRESS_PER_ATTEMPT) return null;
    progress += 1;
    if (event.type === "message.completed" || event.type === "message.delta") return write("progress", { seq, at, type: "message", text: text(event.text) });
    if (event.type === "tool.requested") return write("progress", { seq, at, type: "tool", tool: String(event.tool || ""), callId: String(event.callId || "").slice(0, 120) });
    if (event.type === "tool.completed") return write("progress", { seq, at, type: "tool_result", tool: String(event.tool || ""), ok: event.ok === true, callId: String(event.callId || "").slice(0, 120) });
    return null;
  };
}

/**
 * Run one native attempt. Returns a runner outcome:
 * { type: "final", output } | { type: "park"|"expired", approval } | { type: "cancelled" }.
 * Throws a timeout error, LeaseLost, or the adapter's classified error.
 */
export async function runNativeAttempt(rc, adapter, providerRef, input, deadline) {
  const effects = listEffectsSync(rc.db, rc.run.id).filter((effect) => effect.state === "committed");
  if (effects.length) input.resumeSummary = effects.map((effect) => `${effect.tool}: ${effect.ref || "done"}`).join("\n");
  if (adapter.capabilities?.resume === "session") {
    const sessionRef = lastNativeSessionRef(rc.db, rc.run.id, providerRef.provider);
    if (sessionRef) Object.assign(input, { resumeSessionRef: sessionRef, resumeReason: resumeReason(rc.db, rc.run.id) });
  }
  const controller = new AbortController();
  let settleAbort;
  const aborted = new Promise((resolve) => { settleAbort = resolve; });
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    // Adapters that ignore the signal (executor-registry turns) are not awaited.
    setTimeout(() => settleAbort({ aborted: reason }), 5_000).unref?.();
  };
  const poll = setInterval(() => {
    try {
      if (getRunSync(rc.db, rc.run.id)?.cancelRequestedAt) abort("cancelled");
      else if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) abort("lease_lost");
    } catch {}
  }, POLL_MS);
  const timer = setTimeout(() => abort("timeout"), Math.max(0, deadline - nowMs()));
  const ctx = {
    runId: rc.run.id,
    job: rc.run.job,
    attempt: rc.attempt,
    provider: providerRef.provider,
    env: rc.env,
    workspace: agentJobWorkspace(rc.home, rc.run.id),
    signal: controller.signal,
    emit: journal({ ...rc, providerRef }),
    authorizeTool: (call) => authorizeNativeToolCall(rc, call),
  };
  try {
    const result = await Promise.race([adapter.run(ctx, input), aborted]);
    if (result?.park) return { type: "park", approval: result.park };
    if (result?.expired) return { type: "expired", approval: result.expired };
    const reason = controller.signal.aborted ? controller.signal.reason : result?.aborted || (result?.cancelled ? "cancelled" : "");
    if (reason === "cancelled") return { type: "cancelled" };
    if (reason === "lease_lost") throw new LeaseLost();
    if (reason) throw Object.assign(new Error("attempt_timeout"), { kind: "timeout", retryable: true });
    return { type: "final", output: result?.output ?? null };
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
  }
}
