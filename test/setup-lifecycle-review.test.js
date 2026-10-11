// Regression tests for the PR #15 review findings on the Setup installer.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, listThreads } from "../packages/core/src/threads.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";
import { defaultSetupDeps, installSetup, uninstallSetup } from "../packages/core/src/setups/setup-installer.js";
import { configureSetup, pauseSetup, resumeSetup } from "../packages/core/src/setups/setup-configure.js";
import { readSetupLedger } from "../packages/core/src/setups/setup-install-ledger.js";

async function freshEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-setup-review-"));
  return { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
}
const ready = { ...defaultSetupDeps, providerReady: async () => ({ ready: true, reason: "chatgpt_login" }) };
const enabledByKey = async (env) => {
  const [instance] = (await readSetupLedger(env)).instances.filter((entry) => entry.status === "installed");
  const timers = await listTimers(env);
  return Object.fromEntries(instance.resources.timers.map(({ key, id }) => [key, timers.find((timer) => timer.id === id)?.enabled !== false]));
};

// Finding 1: install lifecycle must be serialized per owner and Setup.
test("concurrent installs create exactly one instance", async () => {
  const env = await freshEnv();
  const results = await Promise.all([installSetup({ setupId: "fitness-tracker" }, env, ready), installSetup({ setupId: "fitness-tracker" }, env, ready)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ["already_installed", "installed"]);
  assert.equal((await listThreads(env)).length, 1);
  assert.equal((await listTimers(env)).length, 2);
  assert.equal((await readSetupLedger(env)).instances.length, 1);
});

test("an install in progress is not rolled back by a second install, uninstall or configure", async () => {
  const env = await freshEnv();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = { ...ready, setMission: async (...args) => { await gate; return defaultSetupDeps.setMission(...args); } };
  const first = installSetup({ setupId: "fitness-tracker" }, env, slow);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = installSetup({ setupId: "fitness-tracker" }, env, ready);
  const removal = uninstallSetup({ setupId: "fitness-tracker" }, env, ready);
  const change = configureSetup({ setupId: "fitness-tracker", enable: ["weekly-summary"] }, env, ready).catch((error) => error.code);
  release();
  const [a, b, c, d] = await Promise.all([first, second, removal, change]);
  assert.equal(a.outcome, "installed");
  assert.equal(b.outcome, "already_installed");
  assert.equal(c.outcome, "uninstalled", "uninstall runs after the install finished");
  assert.equal(d, "setup_not_installed", "configure after uninstall reports not installed");
  const instances = (await readSetupLedger(env)).instances;
  assert.deepEqual(instances.map((instance) => instance.status), ["uninstalled"]);
  assert.equal((await listTimers(env)).length, 0);
});

// Finding 2: a resource created but not yet recorded must not be orphaned.
test("a timer created just before a failure is still removed by rollback", async () => {
  const env = await freshEnv();
  let calls = 0;
  const recordFails = { ...ready, createTimer: async (input, actualEnv) => {
    calls += 1;
    const timer = await createTimer(input, actualEnv);
    if (calls === 2) throw Object.assign(new Error("ledger write failed after create"), { code: "simulated_record_failure" });
    return timer;
  } };
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker", optIn: ["weekly-summary"] }, env, recordFails), /simulated_record_failure/);
  assert.deepEqual(await listTimers(env), [], "no orphan timer, including the enabled one");
  assert.ok((await listThreads(env)).every((thread) => thread.retired));
});

test("a crashed install is cleaned up on retry without touching unrelated resources", async () => {
  const env = await freshEnv();
  const mine = await createThread({ id: "users-own", name: "Users own" }, env);
  const myTimer = await createTimer({ label: "Mine", prompt: "x", targetType: "thread", target: mine.id }, env);
  const crash = { ...ready,
    createTimer: async (input, actualEnv) => { await createTimer(input, actualEnv); throw Object.assign(new Error("killed"), { code: "simulated_crash" }); },
    retireThread: async () => { throw new Error("still down"); },
  };
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, crash), /setup_rollback_failed/);
  const retry = await installSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.equal(retry.outcome, "installed");
  const timers = await listTimers(env);
  assert.equal(timers.length, 3, "user's timer plus the new install's two");
  assert.ok(timers.some((timer) => timer.id === myTimer.id));
  assert.ok(timers.every((timer) => timer.id === myTimer.id || timer.target === retry.instance.resources.threadId));
  const threads = await listThreads(env);
  assert.equal(threads.find((thread) => thread.id === mine.id).retired, false);
});

// Finding 4: pause/resume must keep each reminder's chosen state.
test("pause then resume keeps a weekly-only opt-in", async () => {
  const env = await freshEnv();
  await installSetup({ setupId: "fitness-tracker", optIn: ["weekly-summary"] }, env, ready);
  await pauseSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.deepEqual(await enabledByKey(env), { "evening-check-in": false, "weekly-summary": false });
  await resumeSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.deepEqual(await enabledByKey(env), { "evening-check-in": false, "weekly-summary": true });
});

test("pause and resume never opt in to reminders that were never chosen", async () => {
  const env = await freshEnv();
  await installSetup({ setupId: "fitness-tracker" }, env, ready);
  await pauseSetup({ setupId: "fitness-tracker" }, env, ready);
  await resumeSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.deepEqual(await enabledByKey(env), { "evening-check-in": false, "weekly-summary": false });
});

test("a reminder turned off explicitly stays off after resume", async () => {
  const env = await freshEnv();
  await installSetup({ setupId: "fitness-tracker", optIn: ["evening-check-in", "weekly-summary"] }, env, ready);
  await configureSetup({ setupId: "fitness-tracker", disable: ["evening-check-in"] }, env, ready);
  await pauseSetup({ setupId: "fitness-tracker" }, env, ready);
  await resumeSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.deepEqual(await enabledByKey(env), { "evening-check-in": false, "weekly-summary": true });
});

// Re-review: ownership comes only from pre-recorded ids, never from target.
test("an owner's own timer on an interrupted install's thread survives the retry", async () => {
  const env = await freshEnv();
  const crash = { ...ready,
    createTimer: async (input, actualEnv) => { await createTimer(input, actualEnv); throw Object.assign(new Error("killed"), { code: "simulated_crash" }); },
    retireThread: async () => { throw new Error("still down"); },
  };
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, crash), /setup_rollback_failed/);
  const [interrupted] = (await readSetupLedger(env)).instances;
  const independent = await createTimer({ label: "My own reminder", prompt: "stretch", targetType: "thread", target: interrupted.resources.threadId }, env);
  const retry = await installSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.equal(retry.outcome, "installed");
  const timers = await listTimers(env);
  assert.ok(timers.some((timer) => timer.id === independent.id), "independent timer survives");
  assert.equal(timers.filter((timer) => timer.target === interrupted.resources.threadId).length, 1, "only the owner's timer remains on the old thread");
});

test("direct uninstall after a create-then-record failure removes the owned timer", async () => {
  const env = await freshEnv();
  let calls = 0;
  const broken = { ...ready,
    createTimer: async (input, actualEnv) => {
      calls += 1;
      const timer = await createTimer(input, actualEnv);
      if (calls === 2) throw Object.assign(new Error("record failed"), { code: "simulated_record_failure" });
      return timer;
    },
    listTimers: async () => { throw new Error("rollback could not read timers"); },
  };
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker", optIn: ["weekly-summary"] }, env, broken), /setup_rollback_failed/);
  assert.equal((await listTimers(env)).length, 2, "both timers exist after the failed rollback");
  const removed = await uninstallSetup({ setupId: "fitness-tracker" }, env, ready);
  assert.equal(removed.outcome, "uninstalled");
  assert.deepEqual(await listTimers(env), [], "no owned timer survives or is forgotten");
  assert.deepEqual((await readSetupLedger(env)).instances.map((instance) => instance.status), ["uninstalled"]);
});
