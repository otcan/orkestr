// Keep the existing Orkestr-owned loop; supply cooperative cancellation and its
// existing journal projection to the HTTP adapter. No second run/event store.
import { LeaseLost } from "./agent-job-effects.js";
import { getRunSync, holdsLeaseSync, nowMs } from "./agent-job-store.js";

export async function runLocalJobStep(rc, adapter, input, transcript, deadline, emit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), Math.max(0, deadline - nowMs()));
  const poll = setInterval(() => {
    if (getRunSync(rc.db, rc.run.id)?.cancelRequestedAt) controller.abort("cancelled");
    else if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) controller.abort("lease_lost");
  }, 100);
  try {
    const result = await adapter.step({ runId: rc.run.id, job: rc.run.job, attempt: rc.attempt, env: rc.env, signal: controller.signal, emit }, { input, transcript });
    if (getRunSync(rc.db, rc.run.id)?.cancelRequestedAt) return { type: "cancelled" };
    if (!holdsLeaseSync(rc.db, rc.run.id, rc.holder)) throw new LeaseLost();
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.reason === "cancelled") return { type: "cancelled" };
    if (controller.signal.reason === "lease_lost") throw new LeaseLost();
    if (controller.signal.reason === "timeout") throw Object.assign(new Error("attempt_timeout"), { kind: "timeout", retryable: true });
    throw error;
  } finally { clearTimeout(timer); clearInterval(poll); }
}
