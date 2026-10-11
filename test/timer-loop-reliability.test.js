// Reliability checks for scheduled Setup check-ins (future P0).
//
// Overlap and backoff were failing on main 92a0ed80 (two deliveries, retry on
// every tick); fixed by packages/core/src/timer-run-guard.js.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTimer, listTimers, markDueTimers, nextRunAt } from "../packages/core/src/timers.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

async function dueTimerEnv(threadId = "loop-thread") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timer-loop-"));
  const env = { ORKESTR_HOME: home };
  if (threadId) await createThread({ id: threadId, name: "Loop Thread" }, env);
  await createTimer({ label: "Check-in", threadId: threadId || "missing-thread", prompt: "check in", cadence: "daily", time: "09:00" }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2026-05-15T08:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);
  return env;
}

test("overlapping timer ticks deliver a due check-in once", async () => {
  const env = await dueTimerEnv();
  const now = new Date("2026-05-15T10:00:00Z");
  await Promise.all([markDueTimers(env, now), markDueTimers(env, now)]);
  assert.equal((await listThreadMessages("loop-thread", env)).length, 1);
});

test("a failing timer backs off instead of retrying every tick", async () => {
  const env = await dueTimerEnv(null);
  const now = new Date("2026-05-15T10:00:00Z");
  const at = (seconds) => new Date(now.getTime() + seconds * 1000);
  await markDueTimers(env, now);
  let [timer] = await listTimers(env);
  assert.equal(timer.lastError, "thread_not_found");
  assert.equal(timer.failureCount, 1);
  assert.equal(timer.retryAt, at(60).toISOString(), "first retry one minute later");
  await markDueTimers(env, at(30));
  [timer] = await listTimers(env);
  assert.equal(timer.failureCount, 1, "no attempt while backing off");
  await markDueTimers(env, at(61));
  [timer] = await listTimers(env);
  assert.equal(timer.failureCount, 2);
  assert.equal(timer.retryAt, at(61 + 120).toISOString(), "second retry doubles the wait");
});

test("a timer that recovers clears its backoff", async () => {
  const env = await dueTimerEnv(null);
  const now = new Date("2026-05-15T10:00:00Z");
  await markDueTimers(env, now);
  await createThread({ id: "missing-thread", name: "Now present" }, env);
  await markDueTimers(env, new Date(now.getTime() + 61_000));
  const [timer] = await listTimers(env);
  assert.equal(timer.lastError, null);
  assert.equal(timer.retryAt, null);
  assert.equal((await listThreadMessages("missing-thread", env)).length, 1);
});

test("a daily check-in in a skipped DST hour still runs once that day", () => {
  // Europe/Berlin skips 02:00-03:00 on 2026-03-29.
  const timer = { cadence: "daily", time: "02:30", timezone: "Europe/Berlin" };
  const next = nextRunAt(timer, new Date("2026-03-28T23:00:00.000Z"));
  const ms = Date.parse(next);
  assert.ok(ms > Date.parse("2026-03-28T23:00:00.000Z") && ms < Date.parse("2026-03-29T22:00:00.000Z"), `next run ${next} must fall on 2026-03-29 local`);
});

test("a daily check-in in a repeated DST hour runs once", () => {
  // Europe/Berlin repeats 02:00-03:00 on 2026-10-25.
  const timer = { cadence: "daily", time: "02:30", timezone: "Europe/Berlin" };
  const first = nextRunAt(timer, new Date("2026-10-24T22:00:00.000Z"));
  const second = nextRunAt(timer, new Date(Date.parse(first) + 1000));
  assert.ok(Date.parse(second) - Date.parse(first) > 20 * 60 * 60 * 1000, `second run ${second} must be the next day, not the repeated hour`);
});

test("after downtime, many missed daily runs collapse into one catch-up run", async () => {
  const env = await dueTimerEnv();
  await markDueTimers(env, new Date("2026-05-20T10:00:00Z"));
  assert.equal((await listThreadMessages("loop-thread", env)).length, 1);
  const [timer] = await listTimers(env);
  assert.ok(Date.parse(timer.nextRunAt) > Date.parse("2026-05-20T10:00:00Z"));
});
