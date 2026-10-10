// Effect ledger entries for approved provider-native tool calls (codex.*,
// claude.*, mcp.*). The provider performs the call itself, so Orkestr cannot
// dedupe or reconcile it like an Orkestr tool; it records it for audit (G3/G7):
// when an approval is consumed the call becomes an `intended`, dispatched
// effect bound to effect_key + args_hash, and the provider's completion event
// commits or fails it. A crash in between leaves it dispatched, so recovery
// marks it `unknown` and a person decides (G4). Calls allowed without an
// approval are journaled as tool decisions only.
import { commitEffectSync, failEffectSync, getEffectSync, intendEffectSync, markEffectDispatchedSync, reopenEffectSync } from "./agent-job-ledger.js";
import { appendCheckpointSync, tx } from "./agent-job-store.js";

const key = (callId) => String(callId || "").slice(0, 120);

// Inside the authorization transaction, right after the approval was consumed.
export function nativeEffectGrantedSync(rc, { tool, args, argsHash, effectKey, callId, approvalId }) {
  const effect = intendEffectSync(rc.db, { effectKey, runId: rc.run.id, tool, argsHash, args, mode: "native" });
  // A person approved retrying an unknown (or failed) call: a fresh intent.
  if (["unknown", "failed"].includes(effect.state)) reopenEffectSync(rc.db, effectKey);
  markEffectDispatchedSync(rc.db, effectKey);
  appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "tool_decision", { tool, decision: "approved", native: true, approvalId, callId: key(callId) });
  appendCheckpointSync(rc.db, rc.run.id, rc.attempt, "effect_dispatched", { effectKey, tool, native: true });
  if (key(callId)) (rc.nativeEffects ||= new Map()).set(key(callId), effectKey);
}

// ctx.emit "tool.completed" for a granted call -> committed | failed.
export function settleNativeEffect(rc, event = {}) {
  const effectKey = rc.nativeEffects?.get(key(event.callId));
  if (!effectKey) return null;
  rc.nativeEffects.delete(key(event.callId));
  return tx(rc.db, () => {
    const effect = getEffectSync(rc.db, effectKey);
    if (!effect || effect.state !== "intended") return effect;
    const next = event.ok === true
      ? commitEffectSync(rc.db, effectKey, { result: { callId: key(event.callId) } })
      : failEffectSync(rc.db, effectKey, { outcome: "failed", error: "the provider reported the call as failed or declined" });
    appendCheckpointSync(rc.db, rc.run.id, rc.attempt, next.state === "committed" ? "effect_committed" : "effect_failed", { effectKey, tool: effect.tool, native: true });
    return next;
  });
}
