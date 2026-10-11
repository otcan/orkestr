import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listThreads } from "../packages/core/src/threads.js";
import { listTimers } from "../packages/core/src/timers.js";
import { defaultSetupDeps, installSetup } from "../packages/core/src/setups/setup-installer.js";
import { configureSetup, exportSetup, pauseSetup, resumeSetup } from "../packages/core/src/setups/setup-configure.js";

async function freshEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-setup-configure-"));
  return { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
}

const deps = { ...defaultSetupDeps, providerReady: async () => ({ ready: true, reason: "chatgpt_login" }) };
const enabledByKey = async (env, instance) => {
  const timers = await listTimers(env);
  return Object.fromEntries(instance.resources.timers.map(({ key, id }) => [key, timers.find((timer) => timer.id === id).enabled !== false]));
};

test("check-ins are created off unless opted in at install", async () => {
  const env = await freshEnv();
  const { instance } = await installSetup({ setupId: "fitness-tracker", optIn: ["weekly-summary"] }, env, deps);
  assert.deepEqual(await enabledByKey(env, instance), { "evening-check-in": false, "weekly-summary": true });
  const timers = await listTimers(env);
  assert.equal(timers.find((timer) => timer.enabled === false).nextRunAt, null, "a disabled check-in has no next run");
});

test("an unknown opt-in key is rejected before anything is created", async () => {
  const env = await freshEnv();
  await assert.rejects(() => installSetup({ setupId: "fitness-tracker", optIn: ["hourly-nag"] }, env, deps), /setup_check_in_unknown/);
  assert.equal((await listThreads(env)).length, 0);
  assert.equal((await listTimers(env)).length, 0);
});

test("configure, pause and resume change only the Setup's own check-ins", async () => {
  const env = await freshEnv();
  const { instance } = await installSetup({ setupId: "fitness-tracker" }, env, deps);
  let result = await configureSetup({ setupId: "fitness-tracker", enable: ["evening-check-in"] }, env, deps);
  assert.deepEqual(result.changes, [{ key: "evening-check-in", result: "enabled" }]);
  assert.deepEqual(await enabledByKey(env, instance), { "evening-check-in": true, "weekly-summary": false });
  result = await resumeSetup({ setupId: "fitness-tracker" }, env, deps);
  assert.deepEqual(result.changes.map((change) => change.result), ["already_on", "enabled"]);
  result = await pauseSetup({ setupId: "fitness-tracker" }, env, deps);
  assert.deepEqual(result.changes.map((change) => change.result), ["disabled", "disabled"]);
  assert.deepEqual(await enabledByKey(env, instance), { "evening-check-in": false, "weekly-summary": false });
  await assert.rejects(() => configureSetup({ setupId: "fitness-tracker", enable: ["nope"] }, env, deps), /setup_check_in_unknown/);
  await assert.rejects(() => configureSetup({ setupId: "fitness-tracker", enable: ["weekly-summary"], disable: ["weekly-summary"] }, env, deps), /setup_check_in_conflict/);
});

test("configure skips a check-in the owner pointed elsewhere and refuses when not installed", async () => {
  const env = await freshEnv();
  await assert.rejects(() => configureSetup({ setupId: "fitness-tracker", enable: ["all"] }, env, deps), /setup_not_installed/);
  const { instance } = await installSetup({ setupId: "fitness-tracker" }, env, deps);
  const timersPath = path.join(env.ORKESTR_HOME, "timers.json");
  const stored = JSON.parse(await fs.readFile(timersPath, "utf8"));
  stored.find((timer) => timer.id === instance.resources.timers[0].id).target = "someone-else";
  await fs.writeFile(timersPath, JSON.stringify(stored));
  const result = await resumeSetup({ setupId: "fitness-tracker" }, env, deps);
  assert.deepEqual(result.changes, [{ key: "evening-check-in", result: "skipped_retargeted" }, { key: "weekly-summary", result: "enabled" }]);
  assert.equal(stored.find((timer) => timer.target === "someone-else").enabled, false);
});

test("export contains the configuration and no secrets", async () => {
  const env = await freshEnv();
  await installSetup({ setupId: "fitness-tracker", timezone: "Europe/Berlin", optIn: ["evening-check-in"] }, env, deps);
  const exported = await exportSetup({ setupId: "fitness-tracker" }, env, deps);
  assert.equal(exported.format, "orkestr.setup-export/v1");
  assert.match(exported.instructions, /personal training log/);
  assert.deepEqual(exported.checkIns.map(({ key, enabled, timezone }) => [key, enabled, timezone]), [["evening-check-in", true, "Europe/Berlin"], ["weekly-summary", false, "Europe/Berlin"]]);
  assert.deepEqual(exported.records, []);
  assert.doesNotMatch(JSON.stringify(exported), /token|password|secret/i);
});
