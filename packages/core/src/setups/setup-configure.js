// Configure, pause, resume and export an installed Setup. Acts only on the
// check-ins recorded in the install ledger, and only while they still target
// the Setup's own thread.
import { getSetupManifest } from "./setup-registry.js";
import { findActiveInstance, noteHistory, readSetupLedger, updateSetupInstance, withSetupLifecycle } from "./setup-install-ledger.js";
import { defaultSetupDeps, setupOwnerOf } from "./setup-installer.js";

function setupError(code, statusCode, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

async function installedInstance(input, env) {
  const manifest = getSetupManifest(input.setupId);
  const instance = findActiveInstance(await readSetupLedger(env), setupOwnerOf(input, env), manifest.id);
  if (!instance || instance.status !== "installed") throw setupError("setup_not_installed", 404, { setupId: manifest.id });
  return { manifest, instance };
}

// Each check-in keeps the owner's choice (`wanted`) in the ledger. configure
// changes that choice; pause turns everything off without forgetting it;
// resume restores exactly the chosen check-ins. Nothing is ever switched on
// that the owner did not choose. enable / disable take check-in keys or "all".
async function applyCheckIns(instance, env, deps, decide) {
  const existing = await deps.listTimers(env);
  const changes = [];
  for (const owned of instance.resources.timers) {
    const enabled = decide(owned);
    if (enabled === undefined) continue;
    const timer = existing.find((entry) => entry.id === owned.id);
    if (!timer) { changes.push({ key: owned.key, result: "missing" }); continue; }
    if (timer.target !== instance.resources.threadId) { changes.push({ key: owned.key, result: "skipped_retargeted" }); continue; }
    if ((timer.enabled !== false) === enabled) { changes.push({ key: owned.key, result: enabled ? "already_on" : "already_off" }); continue; }
    await deps.updateTimer(owned.id, { enabled }, env);
    changes.push({ key: owned.key, result: enabled ? "enabled" : "disabled" });
  }
  return changes;
}

function locked(input, env, run) {
  const manifest = getSetupManifest(input.setupId);
  return withSetupLifecycle(env, setupOwnerOf(input, env), manifest.id, () => run());
}

export function configureSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  return locked(input, env, async () => {
    const { instance } = await installedInstance(input, env);
    const owned = instance.resources.timers;
    const expand = (keys = []) => (keys.includes("all") ? owned.map((timer) => timer.key) : keys);
    const enable = new Set(expand(input.enable));
    const disable = new Set(expand(input.disable));
    const unknown = [...enable, ...disable].filter((key) => !owned.some((timer) => timer.key === key));
    if (unknown.length) throw setupError("setup_check_in_unknown", 400, { unknown });
    const conflict = [...enable].filter((key) => disable.has(key));
    if (conflict.length) throw setupError("setup_check_in_conflict", 400, { conflict });
    const choice = (key) => (enable.has(key) ? true : disable.has(key) ? false : undefined);
    const updated = await updateSetupInstance(env, instance.instanceId, (entry) => {
      for (const timer of entry.resources.timers) if (choice(timer.key) !== undefined) timer.wanted = choice(timer.key);
    });
    // While paused, only the choice is stored; resume applies it.
    const changes = updated.paused
      ? owned.filter((timer) => choice(timer.key) !== undefined).map((timer) => ({ key: timer.key, result: choice(timer.key) ? "on_after_resume" : "stays_off" }))
      : await applyCheckIns(updated, env, deps, (timer) => choice(timer.key));
    await updateSetupInstance(env, instance.instanceId, (entry) => noteHistory(entry, "configure", "done", { changes: changes.map((change) => `${change.key}:${change.result}`) }));
    return { outcome: "configured", setupId: instance.setupId, paused: Boolean(updated.paused), changes };
  });
}

export function pauseSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  return locked(input, env, async () => {
    const { instance } = await installedInstance(input, env);
    const paused = await updateSetupInstance(env, instance.instanceId, (entry) => { entry.paused = true; noteHistory(entry, "pause", "done"); });
    return { outcome: "paused", setupId: instance.setupId, paused: true, changes: await applyCheckIns(paused, env, deps, () => false) };
  });
}

export function resumeSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  return locked(input, env, async () => {
    const { instance } = await installedInstance(input, env);
    const resumed = await updateSetupInstance(env, instance.instanceId, (entry) => { entry.paused = false; noteHistory(entry, "resume", "done"); });
    return { outcome: "resumed", setupId: instance.setupId, paused: false, changes: await applyCheckIns(resumed, env, deps, (timer) => timer.wanted === true) };
  });
}

// Everything the owner configured, without secrets. Records from the fitness
// store join this export once the store exists (Phase B).
export async function exportSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  const { manifest, instance } = await installedInstance(input, env);
  const timers = await deps.listTimers(env);
  const thread = await deps.getThread(instance.resources.threadId, env).catch(() => null);
  return {
    format: "orkestr.setup-export/v1",
    exportedAt: new Date().toISOString(),
    setup: { id: manifest.id, version: instance.version, schemaVersion: instance.schemaVersion },
    instance: { instanceId: instance.instanceId, provider: instance.provider, timezone: instance.timezone, createdAt: instance.createdAt, history: instance.history },
    instructions: thread?.standingMission || null,
    checkIns: instance.resources.timers.map((owned) => {
      const { key, id } = owned;
      const timer = timers.find((entry) => entry.id === id);
      return { key, wanted: owned.wanted === true, enabled: Boolean(timer && timer.enabled !== false), cadence: timer?.cadence || null, time: timer?.time || null, timezone: timer?.timezone || null };
    }),
    records: [],
  };
}
