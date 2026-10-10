// Agent Job schedule triggers as read-only rows for the timers list
// (GET /api/timers, `orkestr timers list`, the Ops "Global Timers" panel).
// The rows are views: they are not stored in timers.json, the timer runner
// never sees them, and they cannot be edited, paused, run or deleted through
// the timer API. Change the schedule in the job file instead. Only admins see
// them, because Agent Jobs are instance-level.
import { getRegisteredJob, listRegisteredJobs, nowIso, openAgentJobDb } from "./agent-job-store.js";
import { scheduleNextFireMs } from "./agent-job-scheduler.js";
import { isAdminPrincipal } from "./policy.js";
import { defaultAdminUser } from "./users.js";

function everyLabel(trigger) {
  if (trigger.cadence !== "interval") return null;
  const minutes = Math.max(1, Math.round(Number(trigger.everyMs || 0) / 60_000));
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export async function listAgentJobScheduleTimers(env = process.env, now = new Date()) {
  if (String(env.ORKESTR_AGENT_JOBS_ENABLED || "1") === "0") return [];
  const db = await openAgentJobDb(env);
  const ownerUserId = defaultAdminUser(env).id;
  const rows = [];
  for (const { name } of await listRegisteredJobs(env)) {
    const job = await getRegisteredJob(name, env);
    (job?.spec?.triggers || []).forEach((trigger, index) => {
      if (trigger.type !== "schedule") return;
      const state = db.prepare("select next_fire_at from schedule_state where job = ? and trigger_index = ?").get(name, index);
      const nextMs = state ? Number(state.next_fire_at) : scheduleNextFireMs(trigger, now);
      rows.push({
        id: `agent-job:${name}:schedule-${index}`,
        ownerUserId,
        label: `Agent job ${name}`,
        targetType: "agent_job",
        target: `agent_job:${name}`,
        cadence: trigger.cadence,
        time: trigger.cadence === "interval" ? null : trigger.time || null,
        timezone: trigger.timezone || "UTC",
        every: everyLabel(trigger),
        enabled: true,
        nextRunAt: Number.isFinite(nextMs) ? nowIso(nextMs) : "",
        readOnly: true,
        source: "agent_job",
      });
    });
  }
  return rows;
}

export async function listAgentJobScheduleTimersForPrincipal(principal, env = process.env) {
  if (!isAdminPrincipal(principal || {})) return [];
  return listAgentJobScheduleTimers(env).catch(() => []);
}

// Timer mutations on an Agent Job schedule row fail clearly instead of 404.
export function assertTimerWritable(timerId) {
  if (String(timerId || "").startsWith("agent-job:")) {
    throw Object.assign(new Error("agent_job_schedule_read_only"), { statusCode: 409, code: "agent_job_schedule_read_only" });
  }
}
