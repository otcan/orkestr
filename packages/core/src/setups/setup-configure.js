// Configure, pause, resume and export an installed Setup. Acts only on the
// check-ins recorded in the install ledger, and only while they still target
// the Setup's own thread.
import { getSetupManifest } from "./setup-registry.js";
import { findActiveInstance, noteHistory, readSetupLedger, updateSetupInstance } from "./setup-install-ledger.js";
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

// enable / disable: lists of check-in keys; "all" means every check-in.
export async function configureSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  const { instance } = await installedInstance(input, env);
  const owned = instance.resources.timers;
  const expand = (keys = []) => (keys.includes("all") ? owned.map((timer) => timer.key) : keys);
  const enable = new Set(expand(input.enable));
  const disable = new Set(expand(input.disable));
  const unknown = [...enable, ...disable].filter((key) => !owned.some((timer) => timer.key === key));
  if (unknown.length) throw setupError("setup_check_in_unknown", 400, { unknown });
  const conflict = [...enable].filter((key) => disable.has(key));
  if (conflict.length) throw setupError("setup_check_in_conflict", 400, { conflict });
  const existing = await deps.listTimers(env);
  const changes = [];
  for (const { key, id } of owned) {
    if (!enable.has(key) && !disable.has(key)) continue;
    const timer = existing.find((entry) => entry.id === id);
    if (!timer) { changes.push({ key, result: "missing" }); continue; }
    if (timer.target !== instance.resources.threadId) { changes.push({ key, result: "skipped_retargeted" }); continue; }
    const enabled = enable.has(key);
    if ((timer.enabled !== false) === enabled) { changes.push({ key, result: enabled ? "already_on" : "already_off" }); continue; }
    await deps.updateTimer(id, { enabled }, env);
    changes.push({ key, result: enabled ? "enabled" : "disabled" });
  }
  await updateSetupInstance(env, instance.instanceId, (entry) => noteHistory(entry, "configure", "done", { changes: changes.map((change) => `${change.key}:${change.result}`) }));
  return { outcome: "configured", setupId: instance.setupId, changes };
}

export function pauseSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  return configureSetup({ ...input, enable: [], disable: ["all"] }, env, deps);
}

export function resumeSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  return configureSetup({ ...input, enable: ["all"], disable: [] }, env, deps);
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
    checkIns: instance.resources.timers.map(({ key, id }) => {
      const timer = timers.find((entry) => entry.id === id);
      return { key, enabled: Boolean(timer && timer.enabled !== false), cadence: timer?.cadence || null, time: timer?.time || null, timezone: timer?.timezone || null };
    }),
    records: [],
  };
}
