// Timer ownership fence for the V1 <-> V2 timer handoff (workstream B2).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { setTimerOwnership, setTimerOwnershipForPrincipal } from "../packages/core/src/timer-ownership-service.js";
import {
  createTimer,
  deleteTimer,
  doctorTimers,
  listTimers,
  markDueTimers,
  runTimerNow,
  updateTimer,
} from "../packages/core/src/timers.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

const now = new Date("2026-05-15T10:00:00.000Z");

async function timerEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-timer-ownership-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "own-thread", name: "Ownership Thread" }, env);
  return env;
}

async function createDailyTimer(env, label = "Daily check") {
  return createTimer({ label, threadId: "own-thread", prompt: "check in", cadence: "daily", time: "09:00" }, env);
}

async function rawTimers(env) {
  return JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "timers.json"), "utf8"));
}

async function writeRawTimers(env, timers) {
  await fs.writeFile(path.join(env.ORKESTR_HOME, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);
}

async function rejectsWith(promise, code, statusCode) {
  await assert.rejects(promise, (error) => error.message === code && error.statusCode === statusCode);
}

test("handoff to v2 disables the timer, replays idempotently, and rejects a different key", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  const first = await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "handoff-1" }, env, now);
  assert.equal(first.changed, true);
  assert.equal(first.timer.ownedBy, "v2");
  assert.equal(first.timer.enabled, false);
  assert.equal(first.timer.nextRunAt, null);
  assert.equal(first.timer.ownership.owner, "v2");
  assert.equal(first.timer.ownership.handoffId, "handoff-1");
  assert.equal(first.timer.ownership.enabledBeforeHandoff, true);
  assert.equal(first.timer.ownership.nextRunAtBeforeHandoff, timer.nextRunAt);
  const [stored] = await rawTimers(env);
  assert.equal(stored.ownedBy, "v2");
  assert.equal(stored.enabled, false);

  const replay = await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "handoff-1" }, env, now);
  assert.equal(replay.changed, false);
  assert.equal(replay.timer.ownership.changedAt, first.timer.ownership.changedAt);

  await rejectsWith(setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "handoff-2" }, env, now), "timer_ownership_conflict", 409);
  await rejectsWith(setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "bad key!" }, env, now), "invalid_handoff_id", 400);
  await rejectsWith(setTimerOwnership(timer.id, { ownedBy: "v3", handoffId: "handoff-1" }, env, now), "invalid_timer_owner", 400);
  await rejectsWith(setTimerOwnership("missing", { ownedBy: "v2", handoffId: "handoff-1" }, env, now), "timer_not_found", 404);
  const events = await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8").catch(() => "");
  assert.equal((events.match(/timer_ownership_changed/g) || []).length, 1);
});

test("ownership changes require timer access for non-admin principals", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await assert.rejects(
    setTimerOwnershipForPrincipal(timer.id, { ownedBy: "v2", handoffId: "h-1" }, userPrincipal({ id: "someone-else", role: "user" }), env, now),
    (error) => error.statusCode === 403,
  );
  assert.equal((await listTimers(env))[0].ownedBy, undefined);
});

test("a v2-owned timer whose stored row still says enabled and overdue is never enqueued", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-stale" }, env, now);
  const stored = await rawTimers(env);
  stored[0].enabled = true;
  stored[0].nextRunAt = "2026-05-15T08:00:00.000Z";
  await writeRawTimers(env, stored);

  const [listed] = await listTimers(env);
  assert.equal(listed.enabled, false);
  assert.equal(listed.nextRunAt, null);
  assert.equal(listed.ownedBy, "v2");
  assert.deepEqual(await markDueTimers(env, now), []);
  assert.deepEqual(await markDueTimers(env, new Date("2026-05-20T10:00:00.000Z")), []);
  assert.equal((await listThreadMessages("own-thread", env)).length, 0);
});

test("run now, update, pause/resume and delete are refused while v2 owns the timer", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-refuse" }, env, now);
  const before = await rawTimers(env);

  await rejectsWith(runTimerNow(timer.id, env, now), "timer_owned_by_v2", 409);
  await rejectsWith(updateTimer(timer.id, { enabled: true }, env, now), "timer_owned_by_v2", 409);
  await rejectsWith(updateTimer(timer.id, { label: "renamed" }, env, now), "timer_owned_by_v2", 409);
  await rejectsWith(deleteTimer(timer.id, env), "timer_owned_by_v2", 409);

  assert.deepEqual(await rawTimers(env), before);
  assert.equal((await listThreadMessages("own-thread", env)).length, 0);
});

test("create and update cannot set the ownership marker directly", async () => {
  const env = await timerEnv();
  const created = await createTimer({
    label: "Sneaky",
    threadId: "own-thread",
    prompt: "check in",
    ownedBy: "v2",
    ownership: { owner: "v2", handoffId: "x" },
  }, env);
  assert.equal(created.ownedBy, undefined);
  assert.equal(created.ownership, undefined);
  const updated = await updateTimer(created.id, { ownedBy: "v2", ownership: { owner: "v2" }, label: "Still V1" }, env, now);
  assert.equal(updated.ownedBy, undefined);
  assert.equal(updated.ownership, undefined);
  assert.equal(updated.label, "Still V1");
  assert.equal(updated.enabled, true);
});

test("doctor reports v2-owned timers as owned_by_v2 info, not broken", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-doctor" }, env, now);
  const doctor = await doctorTimers(env, new Date("2026-05-20T10:00:00.000Z"));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.status, "ok");
  assert.equal(doctor.counts.ownedByV2, 1);
  assert.deepEqual(doctor.issues.map((issue) => [issue.severity, issue.code]), [["info", "owned_by_v2"]]);
});

test("handback restores enablement and restarts the schedule from now without catch-up", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-back" }, env, now);
  await rejectsWith(setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-other" }, env, now), "timer_ownership_conflict", 409);

  // Many daily runs were missed while V2 owned the timer.
  const later = new Date("2026-06-20T10:00:00.000Z");
  const back = await setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-back" }, env, later);
  assert.equal(back.changed, true);
  assert.equal(back.timer.ownedBy, undefined);
  assert.deepEqual(
    { owner: back.timer.ownership.owner, handoffId: back.timer.ownership.handoffId, returnedFrom: back.timer.ownership.returnedFrom },
    { owner: "v1", handoffId: "h-back", returnedFrom: "v2" },
  );
  assert.equal(back.timer.enabled, true);
  const nextMs = Date.parse(back.timer.nextRunAt);
  assert.ok(nextMs > later.getTime() && nextMs <= later.getTime() + 24 * 60 * 60 * 1000, `next run ${back.timer.nextRunAt} is the next single future slot`);
  assert.deepEqual(await markDueTimers(env, later), [], "no immediate fire after handback");
  assert.equal((await listThreadMessages("own-thread", env)).length, 0);

  const replay = await setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-back" }, env, later);
  assert.equal(replay.changed, false);
  await rejectsWith(setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-unknown" }, env, later), "timer_not_owned_by_v2", 409);

  // Once handed back the timer is an ordinary V1 timer again.
  const updated = await updateTimer(timer.id, { label: "Back in V1" }, env, later);
  assert.equal(updated.label, "Back in V1");
});

test("handback keeps a timer disabled when asked, and a disabled timer stays disabled by default", async () => {
  const env = await timerEnv();
  const timer = await createDailyTimer(env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-keep" }, env, now);
  const kept = await setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-keep", enable: false }, env, now);
  assert.equal(kept.timer.enabled, false);
  assert.equal(kept.timer.nextRunAt, null);

  const paused = await createDailyTimer(env, "Paused");
  await updateTimer(paused.id, { enabled: false }, env, now);
  const handed = await setTimerOwnership(paused.id, { ownedBy: "v2", handoffId: "h-paused" }, env, now);
  assert.equal(handed.timer.ownership.enabledBeforeHandoff, false);
  const restored = await setTimerOwnership(paused.id, { ownedBy: "v1", handoffId: "h-paused" }, env, now);
  assert.equal(restored.timer.enabled, false);

  const forced = await createDailyTimer(env, "Forced");
  await updateTimer(forced.id, { enabled: false }, env, now);
  await setTimerOwnership(forced.id, { ownedBy: "v2", handoffId: "h-forced" }, env, now);
  const enabled = await setTimerOwnership(forced.id, { ownedBy: "v1", handoffId: "h-forced", enable: true }, env, now);
  assert.equal(enabled.timer.enabled, true);
  assert.ok(Date.parse(enabled.timer.nextRunAt) > now.getTime());
  await rejectsWith(setTimerOwnership(forced.id, { ownedBy: "v1", handoffId: "h-forced", enable: "yes" }, env, now), "invalid_enable", 400);
});

test("handoff is serialized with a concurrently running due pass so the marker is not lost", async () => {
  const env = await timerEnv();
  const due = await createDailyTimer(env, "Due");
  const handed = await createDailyTimer(env, "Handed");
  const stored = await rawTimers(env);
  for (const timer of stored) timer.nextRunAt = "2026-05-15T08:00:00.000Z";
  await writeRawTimers(env, stored);

  // The due pass starts first (reads the list, enqueues, saves the whole list);
  // the handoff must not be clobbered by that save.
  const [fired, ownership] = await Promise.all([
    markDueTimers(env, now),
    setTimerOwnership(handed.id, { ownedBy: "v2", handoffId: "h-race" }, env, now),
  ]);
  assert.equal(ownership.changed, true);
  assert.deepEqual(fired.map((timer) => timer.id).sort(), [due.id, handed.id].sort());
  const after = await rawTimers(env);
  const handedRow = after.find((timer) => timer.id === handed.id);
  assert.equal(handedRow.ownedBy, "v2");
  assert.equal(handedRow.enabled, false);
  assert.equal(handedRow.nextRunAt, null);
  assert.equal(after.find((timer) => timer.id === due.id).lastRunAt, now.toISOString());
  assert.deepEqual(await markDueTimers(env, new Date("2026-05-17T10:00:00.000Z")).then((list) => list.map((timer) => timer.id)), [due.id]);
});

test("a one-shot timer whose time passed during v2 ownership is not fired on handback", async () => {
  const env = await timerEnv();
  const timer = await createTimer({ label: "Once", threadId: "own-thread", prompt: "once", runAt: "2026-05-16T09:00:00.000Z" }, env);
  await setTimerOwnership(timer.id, { ownedBy: "v2", handoffId: "h-once" }, env, now);
  const back = await setTimerOwnership(timer.id, { ownedBy: "v1", handoffId: "h-once" }, env, new Date("2026-05-17T00:00:00.000Z"));
  assert.equal(back.timer.enabled, false);
  assert.equal(back.timer.nextRunAt, null);
});

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function ownershipFetch(seen, response) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    seen.push({ key: `${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("CLI timers handoff and handback call the ownership API", async () => {
  const seen = [];
  const payload = { timer: { id: "timer-1", ownedBy: "v2", enabled: false, nextRunAt: null }, changed: true };
  let stdout = capture();
  let code = await runCli(["timers", "handoff", "timer-1", "--handoff-id", "b2:cutover.1", "--json"], {
    stdout, stderr: capture(), fetchImpl: ownershipFetch(seen, payload),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen[0], { key: "POST /api/timers/timer-1/ownership", body: { ownedBy: "v2", handoffId: "b2:cutover.1" } });
  assert.deepEqual(JSON.parse(stdout.text()), payload);

  for (const [flag, enable] of [["--enable", true], ["--keep-disabled", false], [null, undefined]]) {
    stdout = capture();
    const argv = ["timers", "handback", "timer-1", "--handoff-id", "b2:cutover.1", ...(flag ? [flag] : [])];
    code = await runCli(argv, { stdout, stderr: capture(), fetchImpl: ownershipFetch(seen, { timer: { id: "timer-1", enabled: false }, changed: false }) });
    assert.equal(code, 0);
    assert.deepEqual(seen.at(-1).body, enable === undefined
      ? { ownedBy: "v1", handoffId: "b2:cutover.1" }
      : { ownedBy: "v1", handoffId: "b2:cutover.1", enable });
    assert.match(stdout.text(), /Timer timer-1 owned by v1 .*already applied/);
  }

  const stderr = capture();
  code = await runCli(["timers", "handoff", "timer-1"], { stdout: capture(), stderr, fetchImpl: ownershipFetch(seen, {}) });
  assert.equal(code, 1);
  assert.match(stderr.text(), /orkestr timers handoff <timer-id> --handoff-id <key>/);
});

test("CLI timer table shows the v2 owner", async () => {
  const stdout = capture();
  const code = await runCli(["timers"], {
    stdout,
    stderr: capture(),
    fetchImpl: ownershipFetch([], { timers: [{ id: "timer-1", label: "Daily", cadence: "daily", ownedBy: "v2", enabled: false, target: "t" }] }),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /owner=v2/);
});
