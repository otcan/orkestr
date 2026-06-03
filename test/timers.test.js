import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { createTimer, doctorTimers, listTimers, markDueTimers, nextRunAt, normalizeStoredTimer, parseTimerDelayMs, timerRunAtFromDelay } from "../packages/core/src/timers.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

test("daily timers schedule the next future clock time", () => {
  const from = new Date("2026-05-15T06:00:00Z");
  const next = new Date(nextRunAt({ cadence: "daily", time: "09:00" }, from));
  assert.ok(next > from);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test("timer persistence creates records with a next run", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timers-"));
  const env = { ORKESTR_HOME: home };
  const timer = await createTimer({ label: "Scan", prompt: "Check Gmail", cadence: "daily" }, env);
  const timers = await listTimers(env);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].id, timer.id);
  assert.ok(timers[0].nextRunAt);
});

test("relative one-shot timers preserve delay-derived runAt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-relative-timers-"));
  const env = { ORKESTR_HOME: home };
  const before = Date.now();
  const timer = await createTimer({ label: "Hi", prompt: "Tell me hi", cadence: "daily", delay: "2 minutes" }, env);
  const after = Date.now();
  const nextMs = Date.parse(timer.nextRunAt);

  assert.equal(timer.cadence, "once");
  assert.equal(timer.runAt, timer.nextRunAt);
  assert.ok(nextMs >= before + 119_000);
  assert.ok(nextMs <= after + 121_000);
  assert.equal(parseTimerDelayMs("in 2 minutes"), 120_000);
  assert.equal(parseTimerDelayMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(timerRunAtFromDelay("10m", new Date("2026-05-15T10:00:00.000Z")), "2026-05-15T10:10:00.000Z");
  await assert.rejects(() => createTimer({ label: "Bad", prompt: "No", delay: "soonish" }, env), /invalid_timer_delay/);
});

test("timer doctor reports healthy configured timers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timer-doctor-ok-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "timer-thread", name: "Timer Thread" }, env);
  await fs.writeFile(
    path.join(home, "timers.json"),
    `${JSON.stringify([
      {
        id: "healthy-timer",
        label: "Healthy",
        targetType: "thread",
        target: "timer-thread",
        cadence: "daily",
        time: "13:00",
        prompt: "Run healthy timer",
        enabled: true,
        nextRunAt: "2026-05-15T13:00:00.000Z",
      },
    ], null, 2)}\n`,
  );

  const result = await doctorTimers(env, new Date("2026-05-15T10:00:00.000Z"));

  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.counts.total, 1);
  assert.deepEqual(result.issues, []);
});

test("timer doctor reports broken targets, prompt files, and stale due timers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timer-doctor-broken-"));
  const env = { ORKESTR_HOME: home };
  await fs.writeFile(
    path.join(home, "timers.json"),
    `${JSON.stringify([
      {
        id: "broken-timer",
        label: "Broken",
        targetType: "thread",
        target: "missing-thread",
        cadence: "daily",
        time: "09:00",
        promptFile: path.join(home, "missing-prompt.md"),
        enabled: true,
        nextRunAt: "2026-05-15T09:00:00.000Z",
      },
    ], null, 2)}\n`,
  );

  const result = await doctorTimers(env, new Date("2026-05-15T10:00:00.000Z"));
  const codes = result.issues.map((issue) => issue.code).sort();

  assert.equal(result.status, "broken");
  assert.equal(result.ok, false);
  assert.deepEqual(codes, ["missing_prompt_file", "missing_thread_target", "timer_overdue"]);
});

test("due timers are marked and rescheduled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-due-"));
  const env = { ORKESTR_HOME: home };
  await createTimer({ label: "Due", prompt: "Run", cadence: "interval", every: "1h" }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);
  const due = await markDueTimers(env, new Date("2026-05-15T10:00:00Z"));
  assert.equal(due.length, 1);
  const after = await listTimers(env);
  assert.equal(after[0].lastRunAt, "2026-05-15T10:00:00.000Z");
  const messages = await listAgentMessages("coding-agent", env);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "timer_due");
});

test("thread timers queue input on the target thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-timers-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "timer-thread", name: "Timer Thread" }, env);
  await createTimer({ label: "Thread Due", threadId: "timer-thread", prompt: "Run thread timer", cadence: "interval", every: "1h" }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);

  await markDueTimers(env, new Date("2026-05-15T10:00:00Z"));
  const messages = await listThreadMessages("timer-thread", env);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "timer_due");
  assert.equal(messages[0].text, "Run thread timer");
});

test("legacy dueAt timers are normalized as due work", () => {
  const timer = normalizeStoredTimer({
    id: "legacy-daily",
    targetType: "thread",
    target: "timer-thread",
    text: "Run legacy timer",
    dueAt: "2026-05-15T09:00:00.000Z",
    status: "pending",
    repeat: { type: "interval", everyMs: 86_400_000, label: "daily" },
  }, new Date("2026-05-16T10:00:00.000Z"));

  assert.equal(timer.enabled, true);
  assert.equal(timer.cadence, "daily");
  assert.equal(timer.prompt, "Run legacy timer");
  assert.equal(timer.nextRunAt, "2026-05-15T09:00:00.000Z");
});

test("a failing due timer does not block later due timers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timer-failure-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "valid-thread", name: "Valid Thread" }, env);
  await createTimer({ label: "Missing Thread", threadId: "missing-thread", prompt: "Should fail", cadence: "interval", every: "1h" }, env);
  await createTimer({ label: "Valid Thread", threadId: "valid-thread", prompt: "Should run", cadence: "interval", every: "1h" }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  timers[1].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);

  const due = await markDueTimers(env, new Date("2026-05-15T10:00:00Z"));
  const after = await listTimers(env);
  const messages = await listThreadMessages("valid-thread", env);

  assert.equal(due.length, 1);
  assert.equal(due[0].label, "Valid Thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Should run");
  assert.equal(after[0].lastRunAt || null, null);
  assert.equal(after[0].lastError, "thread_not_found");
  assert.equal(after[0].nextRunAt, "2020-01-01T00:00:00.000Z");
  assert.equal(after[1].lastRunAt, "2026-05-15T10:00:00.000Z");
});
