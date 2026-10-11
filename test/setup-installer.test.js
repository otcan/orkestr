import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, getThread, listThreads } from "../packages/core/src/threads.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";
import { defaultSetupDeps, installSetup, setupStatus, uninstallSetup } from "../packages/core/src/setups/setup-installer.js";
import { readSetupLedger } from "../packages/core/src/setups/setup-install-ledger.js";

async function freshEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-setup-"));
  return { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
}

// Real thread/timer/mission storage; only the provider login check is faked.
function deps(overrides = {}) {
  return { ...defaultSetupDeps, providerReady: async (provider) => ({ ready: provider === "codex", reason: provider === "codex" ? "logged_in" : "not_logged_in" }), ...overrides };
}

test("fresh install creates exactly one thread, its mission and the manifest timers", async () => {
  const env = await freshEnv();
  const result = await installSetup({ setupId: "fitness-tracker", timezone: "Europe/Berlin" }, env, deps());
  assert.equal(result.outcome, "installed");
  const { instance } = result;
  assert.equal(instance.status, "installed");
  assert.equal(instance.provider, "codex");
  const thread = await getThread(instance.resources.threadId, env);
  assert.ok(thread);
  assert.match(thread.standingMission, /personal training log/);
  assert.equal(thread.cwd, instance.resources.stateDir);
  const timers = await listTimers(env);
  assert.deepEqual(timers.map((timer) => timer.id).sort(), instance.resources.timers.map((timer) => timer.id).sort());
  assert.ok(timers.every((timer) => timer.target === thread.id && timer.timezone === "Europe/Berlin"));
  assert.deepEqual(instance.resources.timers.map((timer) => timer.key), ["evening-check-in", "weekly-summary"]);
  const status = await setupStatus({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(status[0].health.thread, "active");
  assert.equal(status[0].health.whatsapp, "not_bound");
  assert.ok(status[0].health.timers.every((timer) => timer.present));
});

test("repeated install is idempotent and creates nothing new", async () => {
  const env = await freshEnv();
  const first = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  const second = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(second.outcome, "already_installed");
  assert.equal(second.instance.instanceId, first.instance.instanceId);
  assert.equal((await listThreads(env)).length, 1);
  assert.equal((await listTimers(env)).length, 2);
});

test("missing provider login refuses before creating anything", async () => {
  const env = await freshEnv();
  const none = deps({ providerReady: async () => ({ ready: false, reason: "not_logged_in" }) });
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, none), (error) => {
    assert.equal(error.code, "setup_prerequisite_missing");
    assert.equal(error.statusCode, 428);
    assert.deepEqual(error.checked.map((entry) => entry.provider), ["codex", "claude-code"]);
    return true;
  });
  assert.equal((await listThreads(env)).length, 0);
  assert.equal((await listTimers(env)).length, 0);
  assert.equal((await readSetupLedger(env)).instances.length, 0);
});

test("a provider outside the manifest is rejected", async () => {
  const env = await freshEnv();
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker", provider: "gemini" }, env, deps()), /setup_provider_not_supported/);
});

test("failure halfway rolls back exactly the created resources", async () => {
  const env = await freshEnv();
  let calls = 0;
  const failing = deps({
    createTimer: async (input, actualEnv) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("disk full"), { code: "timer_write_failed" });
      return createTimer(input, actualEnv);
    },
  });
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, failing), (error) => {
    assert.equal(error.code, "timer_write_failed");
    assert.equal(error.rollback.thread, "retired");
    assert.equal(error.rollback.mission, "cleared");
    // The second id was recorded before createTimer failed, so it is reported but was never created.
    assert.deepEqual(error.rollback.timers.map((timer) => timer.result), ["not_created", "deleted"]);
    return true;
  });
  assert.equal((await listTimers(env)).length, 0);
  const [thread] = await listThreads(env);
  assert.equal(thread.retired, true);
  assert.equal(thread.standingMission, null);
  const [instance] = (await readSetupLedger(env)).instances;
  assert.equal(instance.status, "rolled_back");
  // A later install starts clean.
  const retry = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(retry.outcome, "installed");
  assert.notEqual(retry.instance.instanceId, instance.instanceId);
});

test("an install interrupted mid-way is cleaned up before the next attempt", async () => {
  const env = await freshEnv();
  const crash = deps({ setMission: async () => { throw Object.assign(new Error("process killed"), { code: "simulated_crash" }); }, retireThread: async () => { throw new Error("still down"); } });
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, crash), /setup_rollback_failed/);
  assert.equal((await readSetupLedger(env)).instances[0].status, "rollback_failed");
  const retry = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(retry.outcome, "installed");
  const threads = await listThreads(env);
  assert.equal(threads.filter((thread) => !thread.retired).length, 1);
  assert.equal((await readSetupLedger(env)).instances[0].status, "rolled_back");
});

test("uninstall removes only owned timers, retires the owned thread, and repeats safely", async () => {
  const env = await freshEnv();
  const other = await createThread({ id: "my-own-thread", name: "Fitness tracker" }, env);
  const otherTimer = await createTimer({ label: "Mine", prompt: "hi", targetType: "thread", target: other.id }, env);
  const { instance } = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.notEqual(instance.resources.threadId, other.id, "never adopts a same-named thread");

  const removed = await uninstallSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(removed.outcome, "uninstalled");
  assert.equal(removed.released.thread, "retired");
  assert.ok(removed.stateRetained);
  await fs.access(removed.stateRetained);
  const timers = await listTimers(env);
  assert.deepEqual(timers.map((timer) => timer.id), [otherTimer.id]);
  assert.equal((await getThread(other.id, env)).retired, false);
  assert.equal((await getThread(instance.resources.threadId, env)).retired, true);

  const again = await uninstallSetup({ setupId: "fitness-tracker" }, env, deps());
  assert.equal(again.outcome, "not_installed");
  assert.deepEqual((await listTimers(env)).map((timer) => timer.id), [otherTimer.id]);
});

test("uninstall skips a timer the owner pointed at another thread", async () => {
  const env = await freshEnv();
  const { instance } = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  const timersPath = path.join(env.ORKESTR_HOME, "timers.json");
  const stored = JSON.parse(await fs.readFile(timersPath, "utf8"));
  stored.find((timer) => timer.id === instance.resources.timers[0].id).target = "someone-else";
  await fs.writeFile(timersPath, JSON.stringify(stored));
  const removed = await uninstallSetup({ setupId: "fitness-tracker" }, env, deps());
  const results = Object.fromEntries(removed.released.timers.map((timer) => [timer.key, timer.result]));
  assert.equal(results["evening-check-in"], "skipped_retargeted");
  assert.equal(results["weekly-summary"], "deleted");
  assert.equal((await listTimers(env)).length, 1);
});

test("install refuses to adopt a thread it did not create", async () => {
  const env = await freshEnv();
  const adopting = deps({ createThread: async () => ({ id: "someone-elses-thread" }) });
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, adopting), (error) => {
    assert.equal(error.code, "setup_thread_conflict");
    assert.equal(error.rollback.thread, "untouched");
    return true;
  });
  assert.equal((await listTimers(env)).length, 0);
});

test("install never creates a WhatsApp binding", async () => {
  const env = await freshEnv();
  await installSetup({ setupId: "fitness-tracker" }, env, deps());
  const files = await fs.readdir(env.ORKESTR_HOME, { recursive: true });
  assert.ok(!files.some((file) => /whatsapp/i.test(file)), files.join(","));
});

test("without a server-supplied provider check, install fails closed", async () => {
  const env = await freshEnv();
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker" }, env, defaultSetupDeps), (error) => {
    assert.equal(error.code, "setup_prerequisite_missing");
    assert.ok(error.checked.every((entry) => entry.reason === "provider_check_unavailable"));
    return true;
  });
  assert.equal((await listThreads(env)).length, 0);
});

test("Setup threads carry their instructions to Codex; other Codex threads are unchanged", async () => {
  const env = await freshEnv();
  const { threadStartParams } = await import("../packages/core/src/codex-app-server-common.js");
  const { instance } = await installSetup({ setupId: "fitness-tracker" }, env, deps());
  const thread = await getThread(instance.resources.threadId, env);
  assert.equal(thread.setupInstanceId, instance.instanceId);
  assert.equal(thread.setupId, "fitness-tracker");
  const params = threadStartParams(thread, env);
  assert.match(params.developerInstructions, /Instructions from the installed Orkestr Setup \(fitness-tracker\):\nYou are the owner's personal training log/);
  assert.equal(params.cwd, instance.resources.stateDir);
  const plain = await createThread({ id: "plain-codex", name: "Plain", standingMission: "Only for Claude" }, env);
  assert.doesNotMatch(threadStartParams(plain, env).developerInstructions || "", /Only for Claude/);
});

test("instance ids and thread names carry no fixed digits", async () => {
  const { newSetupInstance } = await import("../packages/core/src/setups/setup-install-ledger.js");
  const manifest = { id: "fitness-tracker", version: "0.1.0", state: { schemaVersion: 1 } };
  const ids = Array.from({ length: 400 }, () => newSetupInstance({ manifest, ownerUserId: "admin", provider: "codex" }).instanceId);
  assert.ok(ids.every((id) => /^setup_[0-9a-f]{16}$/.test(id)));
  for (let position = 6; position < 22; position += 1) {
    assert.ok(new Set(ids.map((id) => id[position])).size > 1, `character ${position} varies`);
  }
  assert.equal(new Set(ids.map((id) => id.slice(-6))).size, ids.length, "thread-name suffixes are unique in practice");
});
