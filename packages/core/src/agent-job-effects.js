// Effect executor for Agent Job tool calls (docs/spec/agent-job.md §5-§6).
// Every tool call is authorized first (default deny, G6). Side effects are
// written `intended` before the external call, short-circuited when already
// `committed` (G3), reconciled after a crash, and never guessed when the
// outcome cannot be determined (G4). Approval-gated effects need an approval
// bound to effect_key + args_hash that is consumed exactly once (G7).
import { agentJobToolDecision } from "./agent-job-spec.js";
import { injectFault } from "./agent-job-faults.js";
import {
  argsHashFor,
  commitEffectSync,
  consumeApprovalSync,
  createApprovalSync,
  effectKeyFor,
  expireApprovalSync,
  failEffectSync,
  findApprovalSync,
  getEffectSync,
  intendEffectSync,
  listEffectsSync,
  markEffectDispatchedSync,
  markEffectUnknownSync,
  redactValue,
  reopenEffectSync,
} from "./agent-job-ledger.js";
import { getAgentJobTool } from "./agent-job-tools.js";
import { appendCheckpointSync, getRunSync, holdsLeaseSync, nowMs, tx } from "./agent-job-store.js";

export class LeaseLost extends Error {
  constructor() {
    super("agent_job_lease_lost");
    this.code = "agent_job_lease_lost";
    this.leaseLost = true;
  }
}

function toolContext(rc, extra = {}) {
  return { env: rc.env, home: rc.home, baseDir: rc.baseDir, inputs: rc.spec.task.inputs || {}, runId: rc.run.id, ...extra };
}

function checkpoint(rc, kind, data) {
  return tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, kind, data));
}

function redacted(rc, value) {
  return redactValue(value, rc.secretValues);
}

// Look the effect up in the external system. found -> committed; definitely
// absent -> failed(absent), so re-execution is allowed; otherwise unknown.
export async function reconcileEffect(rc, effect) {
  const tool = getAgentJobTool(effect.tool);
  let verdict = null;
  if (typeof tool?.reconcile === "function") {
    try {
      verdict = await tool.reconcile(effect, toolContext(rc, { args: effect.args, effectKey: effect.effectKey }));
    } catch (error) {
      verdict = { error: error?.message || String(error) };
    }
  }
  return tx(rc.db, () => {
    let next;
    if (verdict?.found) next = commitEffectSync(rc.db, effect.effectKey, { result: redacted(rc, verdict.result), ref: verdict.ref, reconciled: true });
    else if (verdict && verdict.found === false) next = failEffectSync(rc.db, effect.effectKey, { outcome: "absent" });
    else next = markEffectUnknownSync(rc.db, effect.effectKey, verdict?.error || (tool?.reconcile ? "reconcile_failed" : "at_most_once_no_reconcile"));
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_reconciled", { effectKey: effect.effectKey, tool: effect.tool, state: next.state, outcome: next.outcome });
    return next;
  });
}

// Resolve the approval gate for one effect. Returns { go: true } once a
// matching approval has been consumed, or a terminal tool status / park.
function approvalGate(rc, effect, reason) {
  return tx(rc.db, () => {
    const approval = findApprovalSync(rc.db, effect.effectKey, effect.argsHash);
    const live = approval && approval.reason === reason && !approval.consumedAt;
    if (live && approval.state === "pending") {
      if (approval.expiresAtMs <= nowMs()) return { status: "expired", approval: expireApprovalSync(rc.db, approval.approvalId) };
      return { status: "park", approval };
    }
    if (live && approval.state === "approved") {
      if (!consumeApprovalSync(rc.db, approval.approvalId)) return { status: "park", approval };
      if (reason === "effect_unknown") reopenEffectSync(rc.db, effect.effectKey);
      appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_consumed", { approvalId: approval.approvalId, effectKey: effect.effectKey });
      return { go: true };
    }
    if (live && approval.state === "denied") {
      const outcome = reason === "effect_unknown" ? "skipped" : "denied";
      failEffectSync(rc.db, effect.effectKey, { outcome });
      return { status: outcome };
    }
    if (live && approval.state === "expired") return { status: "expired", approval };
    return requestApprovalSync(rc, effect, reason);
  });
}

function requestApprovalSync(rc, effect, reason) {
  const created = createApprovalSync(rc.db, {
    runId: rc.run.id,
    effectKey: effect.effectKey,
    argsHash: effect.argsHash,
    tool: effect.tool,
    args: effect.args,
    reason,
    ttlMs: rc.spec.runtime.approvalTimeoutMs,
  });
  appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "approval_requested", { approvalId: created.approvalId, effectKey: effect.effectKey, tool: effect.tool, reason });
  return { status: "park", approval: created, created: true };
}

// Recovery: an `unknown` effect blocks the run until a human decides (G4).
export function ensureUnknownEffectApprovals(rc) {
  return tx(rc.db, () => listEffectsSync(rc.db, rc.run.id)
    .filter((effect) => effect.state === "unknown")
    .map((effect) => {
      const approval = findApprovalSync(rc.db, effect.effectKey, effect.argsHash);
      if (approval && approval.reason === "effect_unknown" && !approval.consumedAt) return approval;
      return requestApprovalSync(rc, effect, "effect_unknown").approval;
    }));
}

function ensureMayDispatch(rc) {
  const run = getRunSync(rc.db, rc.run.id);
  if (run?.cancelRequestedAt) return "cancelled";
  if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) throw new LeaseLost();
  return null;
}

async function dispatch(rc, tool, effect, args) {
  // G11: no new effect starts once a cancel is recorded.
  if (ensureMayDispatch(rc) === "cancelled") return { status: "cancelled" };
  tx(rc.db, () => {
    markEffectDispatchedSync(rc.db, effect.effectKey);
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_dispatched", { effectKey: effect.effectKey, tool: effect.tool });
  });
  injectFault(rc.faults, "effect_dispatched", { attempt: rc.attempt, tool: effect.tool });
  let performed;
  try {
    performed = await tool.perform(args, toolContext(rc, { args, effectKey: effect.effectKey }));
  } catch (error) {
    if (error?.injectedCrash) throw error;
    const message = redacted(rc, String(error?.message || error));
    tx(rc.db, () => {
      if (error?.outcomeUnknown) markEffectUnknownSync(rc.db, effect.effectKey, message);
      else failEffectSync(rc.db, effect.effectKey, { outcome: "failed", error: message });
      appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_failed", { effectKey: effect.effectKey, tool: effect.tool, error: message });
    });
    return { status: "error", error: message };
  }
  injectFault(rc.faults, "effect_performed", { attempt: rc.attempt, tool: effect.tool });
  const committed = tx(rc.db, () => {
    const next = commitEffectSync(rc.db, effect.effectKey, { result: redacted(rc, performed?.result ?? null), ref: performed?.ref });
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_committed", { effectKey: effect.effectKey, tool: effect.tool, ref: next.ref });
    return next;
  });
  injectFault(rc.faults, "effect_committed", { attempt: rc.attempt, tool: effect.tool });
  return { status: "committed", result: committed.result, ref: committed.ref };
}

// Execute one tool call requested by the agent. Returns
//   { status: "ok"|"committed"|"deduplicated"|"reconciled", result }
//   { status: "denied"|"skipped"|"error"|"unknown_tool" }    (told to the agent)
//   { status: "park", approval } | { status: "expired", approval } | { status: "cancelled" }
export async function executeToolCall(rc, call) {
  const toolName = String(call.tool || "");
  const decision = agentJobToolDecision(rc.spec, toolName);
  checkpoint(rc, "tool_decision", { tool: toolName, decision, stepIndex: call.stepIndex ?? null });
  if (decision === "deny") return { status: "denied", decision };
  const tool = getAgentJobTool(toolName);
  if (!tool) return { status: "unknown_tool", decision };
  const args = call.args && typeof call.args === "object" ? call.args : {};

  if (tool.effect === false && decision === "allow") {
    if (ensureMayDispatch(rc) === "cancelled") return { status: "cancelled" };
    try {
      const performed = await tool.perform(args, toolContext(rc, { args }));
      return { status: "ok", result: redacted(rc, performed?.result ?? null) };
    } catch (error) {
      return { status: "error", error: redacted(rc, String(error?.message || error)) };
    }
  }

  const argsHash = argsHashFor(args);
  const logical = typeof tool.logicalKey === "function" ? tool.logicalKey(args, toolContext(rc)) : ["args", argsHash];
  const effectKey = effectKeyFor(rc.run.id, toolName, logical);
  let effect = tx(rc.db, () => {
    const next = intendEffectSync(rc.db, {
      effectKey,
      runId: rc.run.id,
      tool: toolName,
      argsHash,
      args: redacted(rc, args),
      mode: typeof tool.reconcile === "function" ? "reconcilable" : "at_most_once",
    });
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_intended", { effectKey, tool: toolName, argsHash, state: next.state });
    return next;
  });
  injectFault(rc.faults, "effect_intended", { attempt: rc.attempt, tool: toolName });

  if (effect.state === "committed") {
    checkpoint(rc, "effect_deduplicated", { effectKey, tool: toolName });
    return { status: "deduplicated", result: effect.result, ref: effect.ref };
  }
  if (effect.state === "intended" && effect.dispatchedAt) effect = await reconcileEffect(rc, effect);
  if (effect.state === "committed") return { status: "reconciled", result: effect.result, ref: effect.ref };
  if (effect.state === "failed") {
    if (["denied", "skipped", "expired"].includes(effect.outcome)) return { status: effect.outcome };
    effect = tx(rc.db, () => reopenEffectSync(rc.db, effectKey));
  }
  if (effect.state === "unknown") {
    const gate = approvalGate(rc, effect, "effect_unknown");
    if (!gate.go) return gate;
    effect = getEffectSync(rc.db, effectKey);
  } else if (decision === "approval_required") {
    const gate = approvalGate(rc, effect, "approval_required");
    if (!gate.go) return gate;
  }
  if (getEffectSync(rc.db, effectKey).argsHash !== argsHash) return { status: "error", error: "effect_args_changed" };
  return dispatch(rc, tool, effect, args);
}

// Recovery: every dispatched-but-uncommitted effect of the run is reconciled
// before the run continues (agent-job §5).
export async function reconcileDispatchedEffects(rc, effects) {
  const results = [];
  for (const effect of effects) {
    if (effect.state === "intended" && effect.dispatchedAt) results.push(await reconcileEffect(rc, effect));
  }
  return results;
}
