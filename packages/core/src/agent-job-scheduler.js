// Background driver for Agent Jobs inside the server process. On start it
// resumes every non-terminal run instead of failing it (G1); afterwards it
// periodically fires due schedule triggers, then drives runs that can make
// progress. Schedule triggers reuse the timer cadence math in timers.js
// (interval/daily/weekly with timezones); a missed fire while the server was
// down is coalesced into one run on the next tick.
import { admitRun, syncJobDirectories } from "./agent-job-admission.js";
import { driveRun } from "./agent-job-runner.js";
import { RUN_ACTIVE_STATES, getRunSync, listRegisteredJobs, getRegisteredJob, nowIso, nowMs, openAgentJobDb, tx } from "./agent-job-store.js";
import { pendingApprovalForRunSync } from "./agent-job-ledger.js";
import { nextRunAt } from "./timers.js";

export function agentJobSweepIntervalMs(env = process.env) {
  const value = Number(env.ORKESTR_AGENT_JOB_SWEEP_MS || 5_000);
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : 5_000;
}

export function scheduleNextFireMs(trigger, from = new Date()) {
  const timer = {
    cadence: trigger.cadence,
    every: trigger.cadence === "interval" ? `${Math.max(1, Math.round(trigger.everyMs / 60_000))}m` : null,
    time: trigger.time || "09:00",
    timezone: trigger.timezone || "UTC",
  };
  return Date.parse(nextRunAt(timer, from));
}

// Fire every schedule trigger whose slot is due. The slot time is the run's
// dedupe key, so two processes (or a restart mid-tick) admit one run per slot.
export async function fireDueSchedules(env = process.env, now = new Date()) {
  const db = await openAgentJobDb(env);
  const fired = [];
  for (const { name } of await listRegisteredJobs(env)) {
    const job = await getRegisteredJob(name, env);
    const triggers = job?.spec?.triggers || [];
    for (let index = 0; index < triggers.length; index += 1) {
      if (triggers[index].type !== "schedule") continue;
      const row = db.prepare("select next_fire_at from schedule_state where job = ? and trigger_index = ?").get(name, index);
      if (!row) {
        db.prepare("insert or ignore into schedule_state (job, trigger_index, next_fire_at) values (?, ?, ?)").run(name, index, scheduleNextFireMs(triggers[index], now));
        continue;
      }
      if (Number(row.next_fire_at) > now.getTime()) continue;
      const slot = nowIso(Number(row.next_fire_at));
      const admitted = await admitRun({ job: name, type: "schedule", index, dedupeKey: `slot:${slot}` }, env);
      tx(db, () => db.prepare("update schedule_state set next_fire_at = ? where job = ? and trigger_index = ?").run(scheduleNextFireMs(triggers[index], now), name, index));
      fired.push({ job: name, index, slot, runId: admitted.run.id, deduplicated: admitted.deduplicated });
    }
  }
  return fired;
}

async function dueRunIds(env) {
  const db = await openAgentJobDb(env);
  const rows = db.prepare(`select id from runs where state in (${RUN_ACTIVE_STATES.map(() => "?").join(",")}) order by created_at, rowid`).all(...RUN_ACTIVE_STATES);
  return rows.map((row) => getRunSync(db, row.id)).filter((run) => {
    if (run.cancelRequestedAt) return true;
    if (run.state === "retrying") return Number(run.nextAttemptAt || 0) <= nowMs();
    if (run.state === "awaiting_approval") {
      const pending = pendingApprovalForRunSync(db, run.id);
      return !pending || pending.expiresAtMs <= nowMs();
    }
    return true;
  }).map((run) => run.id);
}

let activeScheduler = null;

// Start a freshly admitted run right away instead of waiting for the next tick.
export function kickAgentJobRun(runId) {
  activeScheduler?.kick(runId);
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ track?: (task: Promise<any>) => Promise<any>, report?: (detail: any) => void, relay?: () => Promise<any>, intervalMs?: number }} [options]
 */
export function startAgentJobScheduler(env = process.env, { track = (promise) => promise, report = (_detail) => {}, relay = async () => [], intervalMs = undefined } = {}) {
  if (String(env.ORKESTR_AGENT_JOBS_ENABLED || "1") === "0") return { stop() {}, tick: async () => [] };
  const inFlight = new Set();
  let ticking = false;
  let stopped = false;
  const drive = (runId) => {
    if (inFlight.has(runId) || stopped) return;
    inFlight.add(runId);
    track(driveRun(runId, { waitForBackoff: true, maxBackoffWaitMs: 0 }, env))
      .then(() => relay())
      .catch((error) => report({ source: "agentJobs.drive", code: "agent_job_drive_failed", message: error?.message || String(error), error }))
      .finally(() => inFlight.delete(runId));
  };
  const tick = async () => {
    if (ticking || stopped) return [];
    ticking = true;
    try {
      await syncJobDirectories(env).catch((error) => report({ source: "agentJobs.sync", code: "agent_job_sync_failed", message: error?.message || String(error), error }));
      await fireDueSchedules(env);
      const ids = await dueRunIds(env);
      ids.forEach(drive);
      // Notification intents are relayed by the apps layer (connector outbox).
      await relay().catch((error) => report({ source: "agentJobs.notify", code: "agent_job_notify_failed", message: error?.message || String(error), error }));
      return ids;
    } finally {
      ticking = false;
    }
  };
  track(tick()).catch((error) => report({ source: "agentJobs.recover", code: "agent_job_recover_failed", message: error?.message || String(error), error }));
  const timer = setInterval(() => {
    track(tick()).catch((error) => report({ source: "agentJobs.tick", code: "agent_job_tick_failed", message: error?.message || String(error), error }));
  }, intervalMs ?? agentJobSweepIntervalMs(env));
  timer.unref?.();
  const scheduler = {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (activeScheduler === scheduler) activeScheduler = null;
    },
    tick,
    kick: drive,
  };
  activeScheduler = scheduler;
  return scheduler;
}
