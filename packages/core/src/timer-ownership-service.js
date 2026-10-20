// POST /api/timers/:timerId/ownership: hand a timer to V2 or take it back.
//
// The read-modify-write runs inside withDueTimerPass so it is serialized with
// the due-timer pass in this process; that pass reads the whole list, enqueues,
// then saves the whole list and would otherwise clobber the ownership marker.
import { createTimerRepository } from "../../storage/src/repositories.js";
import { appendEvent } from "../../storage/src/store.js";
import { assertResourceAccess } from "./policy.js";
import { withDueTimerPass } from "./timer-run-guard.js";
import { applyTimerOwnershipChange, parseTimerOwnershipRequest } from "./timer-ownership.js";
import { listTimers, nextRunAt } from "./timers.js";

function timerNotFound() {
  const error = new Error("timer_not_found");
  error.statusCode = 404;
  return error;
}

export async function setTimerOwnership(id, body = {}, env = process.env, now = new Date(), options = {}) {
  const request = parseTimerOwnershipRequest(body);
  const timerId = String(id || "").trim();
  // Agent Job schedules are read-only views outside timers.json; they cannot
  // be handed to V2 and never enqueue thread input.
  if (timerId.startsWith("agent-job:")) {
    throw Object.assign(new Error("agent_job_schedule_read_only"), { statusCode: 409, code: "agent_job_schedule_read_only" });
  }
  return withDueTimerPass(env, async () => {
    const timers = await listTimers(env);
    const index = timers.findIndex((timer) => timer.id === timerId);
    if (index < 0) throw timerNotFound();
    if (options.principal) assertResourceAccess(options.principal, timers[index], "timer_ownership", env);
    const result = applyTimerOwnershipChange(timers[index], request, now, nextRunAt);
    if (!result.changed) return { timer: result.timer, changed: false };
    timers[index] = result.timer;
    await createTimerRepository(env).save(timers);
    await appendEvent({
      ts: now.toISOString(),
      type: "timer_ownership_changed",
      timerId: result.timer.id,
      ownerUserId: result.timer.ownerUserId,
      target: result.timer.target,
      ownedBy: request.ownedBy,
      handoffId: request.handoffId,
      enabled: result.timer.enabled !== false,
      nextRunAt: result.timer.nextRunAt || null,
    }, env);
    return { timer: result.timer, changed: true };
  });
}

export function setTimerOwnershipForPrincipal(id, body = {}, principal, env = process.env, now = new Date()) {
  return setTimerOwnership(id, body, env, now, { principal });
}
