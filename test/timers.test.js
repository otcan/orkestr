import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { createTimer, listTimers, markDueTimers, nextRunAt } from "../packages/core/src/timers.js";

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
  const messages = await listAgentMessages("job-search-assistant", env);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "timer_due");
});
