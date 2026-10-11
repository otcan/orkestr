// Install ledger for Setups: $ORKESTR_HOME/setups/installs.json.
//
// The ledger is the only source of truth for what a Setup owns. Every
// resource is recorded the moment it is created, so rollback and uninstall act
// on exact IDs and never on names or guesses.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appHome } from "../../../storage/src/paths.js";
import { readJson, writeJson } from "../../../storage/src/store.js";

export const ACTIVE_SETUP_STATES = new Set(["installing", "installed", "uninstalling", "rollback_failed"]);

let ledgerQueue = Promise.resolve();

export function setupHome(env = process.env) {
  return path.join(appHome(env), "setups");
}

export function setupLedgerPath(env = process.env) {
  return path.join(setupHome(env), "installs.json");
}

export function setupInstanceDir(instanceId, env = process.env) {
  return path.join(setupHome(env), "instances", instanceId);
}

export async function readSetupLedger(env = process.env) {
  const ledger = await readJson(setupLedgerPath(env), { version: 1, instances: [] });
  return { version: 1, instances: Array.isArray(ledger?.instances) ? ledger.instances : [] };
}

// Serializes read-modify-write cycles within this process. The server is the
// single writer; the CLI goes through its API.
export function withSetupLedger(env, mutate) {
  const run = ledgerQueue.then(async () => {
    const ledger = await readSetupLedger(env);
    const result = await mutate(ledger);
    await writeJson(setupLedgerPath(env), ledger);
    return result;
  });
  ledgerQueue = run.catch(() => {});
  return run;
}

export function newSetupInstance({ manifest, ownerUserId, provider, timezone }) {
  const now = new Date().toISOString();
  return {
    instanceId: `setup_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    setupId: manifest.id,
    version: manifest.version,
    schemaVersion: manifest.state?.schemaVersion || null,
    ownerUserId,
    provider,
    timezone: timezone || null,
    status: "installing",
    grants: [],
    resources: { stateDir: null, threadId: null, missionSet: false, timers: [] },
    history: [{ at: now, action: "install", outcome: "started" }],
    createdAt: now,
    updatedAt: now,
  };
}

export function findActiveInstance(ledger, ownerUserId, setupId) {
  return ledger.instances.find((instance) =>
    instance.ownerUserId === ownerUserId && instance.setupId === setupId && ACTIVE_SETUP_STATES.has(instance.status)
  ) || null;
}

export function noteHistory(instance, action, outcome, detail = {}) {
  const at = new Date().toISOString();
  instance.history = [...(instance.history || []), { at, action, outcome, ...detail }].slice(-50);
  instance.updatedAt = at;
}

// Persist a mutation of one instance by id.
export function updateSetupInstance(env, instanceId, mutate) {
  return withSetupLedger(env, (ledger) => {
    const instance = ledger.instances.find((entry) => entry.instanceId === instanceId);
    if (!instance) throw Object.assign(new Error("setup_instance_not_found"), { statusCode: 404 });
    mutate(instance);
    instance.updatedAt = new Date().toISOString();
    return structuredClone(instance);
  });
}
