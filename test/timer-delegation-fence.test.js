// V1 timers and held local input on a thread delegated to a remote runtime.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverPendingThreadInputs, resetThreadInputDeliveryTimersForTest } from "../packages/core/src/runtime-leases.js";
import { setTimerOwnership } from "../packages/core/src/timer-ownership-service.js";
import { createTimer, listTimers, markDueTimers, runTimerNow, updateTimer } from "../packages/core/src/timers.js";
import { appendThreadMessage, createThread, getThreadMessage, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";

const delegatedBinding = {
  connector: "whatsapp",
  chatId: "example-chat@g.us",
  remoteBackend: "example-backend",
  remoteThreadId: "example-remote-thread",
  remoteRuntimeEnabled: true,
  mirrorToWhatsApp: false,
};
const now = new Date();
const dayMs = 24 * 60 * 60 * 1000;
// A moment after the timer's next run, plus whole days.
const dueAfter = (timer, days = 0) => new Date(Date.parse(timer.nextRunAt) + 60_000 + days * dayMs);

async function fixture(t, binding = delegatedBinding) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "timer-delegation-fence-"));
  const env = {
    HOME: home, ORKESTR_HOME: home, PATH: process.env.PATH,
    ORKESTR_CLAUDE_CODE_ENABLED: "0", ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_CODEX_BIN: path.join(home, "missing-codex"),
  };
  await createThread({ id: "example-thread", name: "Example thread", ownerUserId: "admin", binding }, env);
  t.after(async () => {
    resetThreadInputDeliveryTimersForTest();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return env;
}

async function dailyTimer(env, label = "Morning brief") {
  return createTimer({ label, threadId: "example-thread", prompt: "brief me", cadence: "daily", time: "09:00" }, env);
}

const inputs = async env => (await listThreadMessages("example-thread", env)).filter(m => m.role === "user");
const events = async (env, type) => (await listEvents(env, 500)).filter(e => e.type === type);

test("a V1 timer due on a delegated thread is paused once with a visible notice instead of held", async t => {
  const env = await fixture(t);
  const timer = await dailyTimer(env);
  assert.deepEqual(await markDueTimers(env, dueAfter(timer)), []);
  assert.equal((await inputs(env)).length, 0, "no local input is enqueued");
  const [paused] = await listTimers(env);
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.pausedReason, "thread_delegated_to_remote_runtime");
  const notice = await getThreadMessage("example-thread", paused.lastDelegationNoticeMessageId, env);
  assert.equal(notice.role, "assistant");
  assert.equal(notice.source, "timer_delegation_fence");
  assert.equal(notice.phase, "signal");
  assert.equal(notice.signalMode, "notify_passively");
  assert.equal(notice.chatId, "example-chat@g.us");
  assert.match(notice.text, /Timer "Morning brief" did not run: this chat is now handled by Orkestr V2/);
  const [refused] = await events(env, "timer_due_refused");
  assert.equal(refused.timerId, timer.id);
  assert.equal(refused.remoteThreadId, "example-remote-thread");
  assert.equal(refused.noticeMessageId, notice.id);
  // Later passes neither fire nor repeat the notice.
  assert.deepEqual(await markDueTimers(env, dueAfter(timer, 4)), []);
  assert.equal((await events(env, "timer_due_refused")).length, 1);
  assert.equal((await events(env, "thread_signal_appended")).length, 1);
});

test("run now on a delegated thread is refused and enqueues nothing", async t => {
  const env = await fixture(t);
  const timer = await dailyTimer(env);
  await assert.rejects(runTimerNow(timer.id, env, now),
    error => error.message === "timer_target_delegated_to_remote_runtime" && error.statusCode === 409);
  assert.equal((await inputs(env)).length, 0);
});

test("after handback the owner re-enables the paused timer and it runs locally", async t => {
  const env = await fixture(t);
  const timer = await dailyTimer(env);
  await markDueTimers(env, dueAfter(timer));
  await updateThread("example-thread", { binding: { ...delegatedBinding, remoteRuntimeEnabled: false } }, env);
  const resumed = await updateTimer(timer.id, { enabled: true }, env, dueAfter(timer));
  const fired = await markDueTimers(env, dueAfter(resumed));
  assert.deepEqual(fired.map(x => x.id), [timer.id]);
  assert.equal((await inputs(env)).filter(m => m.source === "timer_due").length, 1);
});

test("V2-owned timers and timers on local threads are not affected", async t => {
  const env = await fixture(t);
  const owned = await dailyTimer(env, "Owned by V2");
  await setTimerOwnership(owned.id, { ownedBy: "v2", handoffId: "handoff-1" }, env, now);
  assert.deepEqual(await markDueTimers(env, dueAfter(owned, 1)), []);
  assert.equal((await listTimers(env))[0].pausedReason, undefined);
  assert.equal((await events(env, "timer_due_refused")).length, 0);

  const local = await fixture(t, { connector: "whatsapp", chatId: "example-chat@g.us" });
  const timer = await dailyTimer(local);
  assert.deepEqual((await markDueTimers(local, dueAfter(timer))).map(x => x.id), [timer.id]);
});

test("agent job schedules cannot be handed to V2", async t => {
  const env = await fixture(t);
  await assert.rejects(setTimerOwnership("agent-job:example:schedule-0", { ownedBy: "v2", handoffId: "handoff-1" }, env, now),
    error => error.message === "agent_job_schedule_read_only" && error.statusCode === 409);
});

test("a held V1 timer run on a delegated thread is dropped with an audit; other local input waits for forwarding", async t => {
  const env = await fixture(t);
  const timerRun = await appendThreadMessage("example-thread", { role: "user", source: "timer_due", text: "Example timer_due input", state: "queued", timerId: "example-timer" }, env);
  // No remote backend is configured here: UI and API input stay queued for
  // forwarding (see remote-runtime-local-input.test.js) and are never run locally.
  const local = [];
  for (const source of ["ui", "api"]) {
    local.push(await appendThreadMessage("example-thread", { role: "user", source, text: `Example ${source} input`, state: "queued" }, env));
  }
  const forwarded = await appendThreadMessage("example-thread", {
    role: "user", source: "whatsapp_inbound", connector: "whatsapp", text: "Owner input", state: "queued",
    deliveryState: "remote_forwarding", remoteBackend: "example-backend", remoteThreadId: "example-remote-thread",
  }, env);
  const relay = await appendThreadMessage("example-thread", { role: "user", source: "whatsapp_group_relay", text: "Relay input", state: "queued" }, env);
  assert.deepEqual(await deliverPendingThreadInputs("example-thread", env), []);
  const dropped = await getThreadMessage("example-thread", timerRun.id, env);
  assert.equal(dropped.state, "failed");
  assert.equal(dropped.deliveryState, "dropped");
  assert.equal(dropped.error, "thread_delegated_to_remote_runtime");
  for (const row of local) {
    const current = await getThreadMessage("example-thread", row.id, env);
    assert.equal(current.state, "queued");
    assert.equal(current.remoteForwardHeld, "whatsapp_remote_backend_not_configured:example-backend");
  }
  assert.deepEqual(await getThreadMessage("example-thread", forwarded.id, env), forwarded);
  assert.deepEqual(await getThreadMessage("example-thread", relay.id, env), relay);
  const audit = await events(env, "thread_input_dropped_delegated");
  assert.deepEqual(audit.map(e => e.messageId), [timerRun.id]);
  assert.equal(audit[0].timerId, "example-timer");
  assert.equal(audit[0].fence, "v1_timer");
  assert.equal(audit[0].remoteThreadId, "example-remote-thread");
  // A second pass is a no-op.
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal((await events(env, "thread_input_dropped_delegated")).length, 1);
  // Handback: the dropped timer run is no longer pending, so it never bursts.
  await updateThread("example-thread", { binding: { ...delegatedBinding, remoteRuntimeEnabled: false } }, env);
  assert.equal((await getThreadMessage("example-thread", timerRun.id, env)).state, "failed");
});
