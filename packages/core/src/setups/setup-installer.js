// Setup install / status / uninstall.
//
// Reuses the existing thread, standing-mission and timer APIs. Never binds
// WhatsApp: a chat binding needs the owner's explicit grant and a paired
// account, and is a separate, later step (docs/setups/manifest-v1.md).
import fs from "node:fs/promises";
import { clearThreadStandingMission, setThreadStandingMission } from "../claude-standing-mission-admin.js";
import { createThread, getThread, retireThread, updateThread } from "../threads.js";
import { createTimer, deleteTimer, listTimers, updateTimer } from "../timers.js";
import { adminUserId, normalizeUserId } from "../users.js";
import { getSetupManifest } from "./setup-registry.js";
import {
  findActiveInstance,
  newSetupInstance,
  noteHistory,
  readSetupLedger,
  setupInstanceDir,
  updateSetupInstance,
  withSetupLedger,
  withSetupLifecycle,
} from "./setup-install-ledger.js";

function setupError(code, statusCode, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

// Core must not import connectors; the server supplies the real provider
// login check (apps/server/src/modules/setups/setup-provider-readiness.ts).
// Without one, installs fail closed.
/** @returns {Promise<{ ready: boolean, reason: string, accountProfileId?: string }>} */
async function providerCheckUnavailable(_provider = "", _ownerUserId = "", _env = process.env) {
  return { ready: false, reason: "provider_check_unavailable" };
}

export const defaultSetupDeps = {
  providerReady: providerCheckUnavailable,
  createThread,
  getThread,
  retireThread,
  updateThread,
  setMission: setThreadStandingMission,
  clearMission: clearThreadStandingMission,
  createTimer,
  deleteTimer,
  listTimers,
  updateTimer,
  makeStateDir: (dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 }),
};

export function setupOwnerOf(input, env) {
  return normalizeUserId(input.ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

async function resolveProvider(manifest, input, ownerUserId, env, deps) {
  const allowed = manifest.requires.providers.anyOf;
  const requested = String(input.provider || "").trim();
  if (requested && !allowed.includes(requested)) throw setupError("setup_provider_not_supported", 400, { allowed });
  const checked = [];
  for (const provider of requested ? [requested] : allowed) {
    const status = await deps.providerReady(provider, ownerUserId, env);
    checked.push({ provider, ...status });
    if (status.ready) return { provider, status };
  }
  throw setupError("setup_prerequisite_missing", 428, { missing: "provider_login", checked });
}

// Undo exactly the recorded resources, newest first. Each step is guarded so a
// resource the owner changed or removed in the meantime is skipped, not forced.
// Ownership is proven only by ids recorded in the ledger. The thread id and
// every check-in id are recorded *before* creation, so an interrupted install
// can still remove exactly what it created and nothing else (an owner may
// point their own timers at the Setup's thread; those are never touched).
// `incomplete` marks an install that failed or crashed before finishing.
async function releaseResources(instance, env, deps, reason, { incomplete = false } = {}) {
  const report = { timers: [], mission: "untouched", thread: "untouched" };
  const { threadId } = instance.resources;
  const existing = await deps.listTimers(env);
  for (const owned of [...instance.resources.timers].reverse()) {
    const timer = existing.find((entry) => entry.id === owned.id);
    if (!timer) report.timers.push({ ...owned, result: incomplete ? "not_created" : "already_gone" });
    else if (timer.target !== threadId) report.timers.push({ ...owned, result: "skipped_retargeted" });
    else {
      await deps.deleteTimer(owned.id, env);
      report.timers.push({ ...owned, result: "deleted" });
    }
    await updateSetupInstance(env, instance.instanceId, (entry) => {
      entry.resources.timers = entry.resources.timers.filter((timer) => timer.id !== owned.id);
    });
  }
  const thread = threadId ? await deps.getThread(threadId, env).catch(() => null) : null;
  if (thread && (instance.resources.missionSet || (incomplete && thread.standingMission))) {
    await deps.clearMission(threadId, instance.ownerUserId, env);
    report.mission = "cleared";
  }
  if (thread && thread.ownerUserId === instance.ownerUserId) {
    await deps.retireThread(threadId, { reason, retiredBy: instance.ownerUserId, retirementSource: "setup" }, env);
    report.thread = "retired";
  } else if (threadId && !incomplete) report.thread = "already_gone";
  return report;
}

async function createResources(instance, manifest, input, env, deps) {
  const id = instance.instanceId;
  const stateDir = setupInstanceDir(id, env);
  await deps.makeStateDir(stateDir);
  await updateSetupInstance(env, id, (entry) => { entry.resources.stateDir = stateDir; });

  // Record the intended id first, so a crash right after creation still knows
  // which thread (and which check-ins targeting it) this install owns.
  const threadId = `${manifest.id}-${id.slice(-8)}`;
  await updateSetupInstance(env, id, (entry) => { entry.resources.threadId = threadId; });
  const thread = await deps.createThread({
    id: threadId,
    name: `${manifest.thread.name} (${id.slice(-4)})`,
    ownerUserId: instance.ownerUserId,
    wakePolicy: "wake-on-message",
    executorId: instance.provider,
    executor: { type: instance.provider, ...(input.accountProfileId ? { accountProfileId: input.accountProfileId } : {}) },
    cwd: stateDir,
    workspace: stateDir,
  }, env);
  // createThread returns an existing thread on a name match; never adopt one.
  if (thread?.id !== threadId) throw setupError("setup_thread_conflict", 409, { existingThreadId: thread?.id || null });
  // Marks the thread as Setup-owned so Codex receives the Setup's instructions
  // (setup-codex-instructions.js); the Claude runtime reads the mission directly.
  await deps.updateThread(threadId, { setupInstanceId: id, setupId: manifest.id }, env);

  if (manifest.thread.mission) {
    await deps.setMission(threadId, manifest.thread.mission, instance.ownerUserId, env);
    await updateSetupInstance(env, id, (entry) => { entry.resources.missionSet = true; });
  }
  // Check-ins start off unless the owner opted in to that key at install.
  const optIn = new Set(Array.isArray(input.optIn) ? input.optIn : []);
  for (const spec of manifest.timers) {
    const wanted = optIn.has(spec.key) ? true : spec.defaultEnabled;
    const timerId = `${id}-${spec.key}`;
    await updateSetupInstance(env, id, (entry) => { entry.resources.timers.push({ key: spec.key, id: timerId, wanted }); });
    await deps.createTimer({
      id: timerId,
      enabled: wanted,
      label: spec.label,
      targetType: "thread",
      target: threadId,
      ownerUserId: instance.ownerUserId,
      cadence: spec.cadence,
      time: spec.time,
      timezone: instance.timezone || undefined,
      prompt: spec.prompt,
    }, env);
  }
}

async function checkInStates(instance, env, deps) {
  const timers = await deps.listTimers(env);
  return instance.resources.timers.map(({ key, id }) => ({ key, enabled: timers.some((timer) => timer.id === id && timer.enabled !== false) }));
}

export function installSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  const manifest = getSetupManifest(input.setupId);
  const ownerUserId = setupOwnerOf(input, env);
  return withSetupLifecycle(env, ownerUserId, manifest.id, () => installLocked(manifest, ownerUserId, input, env, deps));
}

async function installLocked(manifest, ownerUserId, input, env, deps) {
  const prior = findActiveInstance(await readSetupLedger(env), ownerUserId, manifest.id);
  if (prior?.status === "installed") return { outcome: "already_installed", instance: prior, checkIns: await checkInStates(prior, env, deps) };
  if (prior) {
    // Inside the lifecycle lock nothing else is working on this Setup, so a
    // non-installed record is a crashed install/uninstall: finish undoing it.
    await releaseResources(prior, env, deps, "setup_install_retry", { incomplete: prior.status !== "uninstalling" });
    await updateSetupInstance(env, prior.instanceId, (entry) => { entry.status = "rolled_back"; noteHistory(entry, "rollback", "done_before_retry"); });
  }
  const unknownOptIn = (input.optIn || []).filter((key) => !manifest.timers.some((timer) => timer.key === key));
  if (unknownOptIn.length) throw setupError("setup_check_in_unknown", 400, { unknown: unknownOptIn });
  const { provider, status } = await resolveProvider(manifest, input, ownerUserId, env, deps);
  const instance = newSetupInstance({ manifest, ownerUserId, provider, timezone: input.timezone });
  await withSetupLedger(env, (ledger) => { ledger.instances.push(instance); });
  try {
    await createResources(instance, manifest, { ...input, accountProfileId: input.accountProfileId || status.accountProfileId }, env, deps);
  } catch (error) {
    const current = (await readSetupLedger(env)).instances.find((entry) => entry.instanceId === instance.instanceId);
    let rollback;
    try {
      rollback = await releaseResources(current, env, deps, "setup_install_failed", { incomplete: true });
      await updateSetupInstance(env, instance.instanceId, (entry) => { entry.status = "rolled_back"; noteHistory(entry, "install", "failed", { error: error.code || error.message }); });
    } catch (rollbackError) {
      await updateSetupInstance(env, instance.instanceId, (entry) => { entry.status = "rollback_failed"; noteHistory(entry, "rollback", "failed", { error: rollbackError.message }); });
      throw setupError("setup_rollback_failed", 500, { instanceId: instance.instanceId, cause: error.code || error.message });
    }
    throw setupError(error.code || "setup_install_failed", error.statusCode || 500, { instanceId: instance.instanceId, rollback, cause: error.message });
  }
  const installed = await updateSetupInstance(env, instance.instanceId, (entry) => { entry.status = "installed"; noteHistory(entry, "install", "done"); });
  return { outcome: "installed", instance: installed, checkIns: await checkInStates(installed, env, deps) };
}

export function uninstallSetup(input = {}, env = process.env, deps = defaultSetupDeps) {
  const manifest = getSetupManifest(input.setupId);
  const ownerUserId = setupOwnerOf(input, env);
  return withSetupLifecycle(env, ownerUserId, manifest.id, () => uninstallLocked(manifest, ownerUserId, env, deps));
}

async function uninstallLocked(manifest, ownerUserId, env, deps) {
  const instance = findActiveInstance(await readSetupLedger(env), ownerUserId, manifest.id);
  if (!instance) return { outcome: "not_installed", setupId: manifest.id };
  // An install that never finished (crash, or rollback that failed) is
  // cleaned up the same way rollback would; ownership still comes only from
  // the ledger's pre-recorded ids.
  const incomplete = ["installing", "rollback_failed"].includes(instance.status);
  await updateSetupInstance(env, instance.instanceId, (entry) => { entry.status = "uninstalling"; noteHistory(entry, "uninstall", "started", { incomplete }); });
  const released = await releaseResources(instance, env, deps, "setup_uninstalled", { incomplete });
  const done = await updateSetupInstance(env, instance.instanceId, (entry) => { entry.status = "uninstalled"; noteHistory(entry, "uninstall", "done"); });
  return { outcome: "uninstalled", instance: done, released, stateRetained: manifest.state?.onUninstall === "retain" ? done.resources.stateDir : null };
}

export async function setupStatus(input = {}, env = process.env, deps = defaultSetupDeps) {
  const ownerUserId = setupOwnerOf(input, env);
  const ledger = await readSetupLedger(env);
  const timers = await deps.listTimers(env);
  const instances = ledger.instances.filter((instance) => instance.ownerUserId === ownerUserId && (!input.setupId || instance.setupId === input.setupId));
  return Promise.all(instances.map(async (instance) => {
    const thread = instance.resources.threadId ? await deps.getThread(instance.resources.threadId, env).catch(() => null) : null;
    return {
      ...instance,
      health: {
        thread: !instance.resources.threadId ? "none" : !thread ? "missing" : thread.retired ? "retired" : "active",
        timers: instance.resources.timers.map((owned) => {
          const timer = timers.find((entry) => entry.id === owned.id && entry.target === instance.resources.threadId);
          return { ...owned, present: Boolean(timer), enabled: Boolean(timer && timer.enabled !== false) };
        }),
        whatsapp: "not_bound",
      },
    };
  }));
}
