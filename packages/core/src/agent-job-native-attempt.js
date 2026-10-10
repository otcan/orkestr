// Runner side of a native-tool-loop attempt (toolLoop "native", e.g. codex).
// The adapter runs the provider's own loop; the runner hands it a context:
//   signal          aborts on a recorded cancel ("cancel") or the attempt deadline ("timeout")
//   emit(kind, d)   journal a progress checkpoint (redacted, truncated)
//   checkpoints(k)  read this run's journal
//   toolDecision(t) permissions.tools decision (default deny)
//   executeTool(c)  authorize + run a tool call through the effect ledger
//   fault(point)    fault injection (tests)
// The adapter returns { output } or { type: "park" | "expired" | "cancelled", approval }.
import { executeToolCall } from "./agent-job-effects.js";
import { injectFault } from "./agent-job-faults.js";
import { listEffectsSync, redactValue } from "./agent-job-ledger.js";
import { agentJobToolDecision } from "./agent-job-spec.js";
import { appendCheckpointSync, getRunSync, listAttemptsSync, listCheckpointsSync, nowMs, tx } from "./agent-job-store.js";

const CANCEL_POLL_MS = 200;

function journalData(rc, data) {
  const redacted = redactValue(data ?? {}, rc.secretValues);
  if (typeof redacted?.text === "string") redacted.text = redacted.text.slice(0, 4000);
  return redacted;
}

export async function runNativeAttempt(rc, adapter, ctx, input, deadline) {
  const effects = listEffectsSync(rc.db, rc.run.id).filter((effect) => effect.state === "committed");
  if (effects.length) input.resumeSummary = effects.map((effect) => `${effect.tool}: ${effect.ref || "done"}`).join("\n");
  const previous = listAttemptsSync(rc.db, rc.run.id).filter((attempt) => attempt.n < rc.attempt).at(-1);
  const controller = new AbortController();
  const poll = setInterval(() => {
    if (nowMs() >= deadline) controller.abort("timeout");
    else if (getRunSync(rc.db, rc.run.id)?.cancelRequestedAt) controller.abort("cancel");
  }, CANCEL_POLL_MS);
  poll.unref?.();
  const native = {
    ...ctx,
    home: rc.home,
    baseDir: rc.baseDir,
    signal: controller.signal,
    previousAttempt: previous ? { attempt: previous.n, reason: previous.endReason || previous.state } : null,
    emit: (kind, data) => tx(rc.db, () => appendCheckpointSync(rc.db, rc.run.id, rc.attempt, kind, journalData(rc, data))),
    checkpoints: (kinds) => listCheckpointsSync(rc.db, rc.run.id, kinds),
    toolDecision: (tool) => agentJobToolDecision(rc.spec, tool),
    executeTool: (call) => executeToolCall(rc, call),
    fault: (point, extra = {}) => injectFault(rc.faults, point, { attempt: rc.attempt, ...extra }),
  };
  try {
    const result = await adapter.run(native, input);
    if (["park", "expired", "cancelled"].includes(result?.type)) return result;
    return { type: "final", output: result?.output ?? null };
  } finally {
    clearInterval(poll);
  }
}
