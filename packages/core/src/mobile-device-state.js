import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { nowIso } from "./mobile-device-crypto.js";

function statePath(env = process.env) {
  return env.ORKESTR_MOBILE_DEVICES_FILE || path.join(dataPaths(env).secrets, "mobile-devices.json");
}

function positiveMs(env, key, fallback) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(1000, Math.floor(parsed)) : fallback;
}

export async function readMobileDeviceState(env = process.env) {
  const state = await readJson(statePath(env), { version: 1, pairings: [], devices: [], sessions: [], proofs: [] });
  return {
    version: 1,
    pairings: Array.isArray(state.pairings) ? state.pairings : [],
    devices: Array.isArray(state.devices) ? state.devices : [],
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    proofs: Array.isArray(state.proofs) ? state.proofs : [],
  };
}

async function writeMobileDeviceState(state, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  const pairings = (state.pairings || [])
    .filter((item) => Date.parse(item.expiresAt || item.updatedAt || "") > now || item.status !== "pending")
    .slice(-500);
  await writeSecretJson(statePath(env), {
    version: 1,
    pairings,
    devices: state.devices || [],
    sessions: (state.sessions || []).filter((item) => Date.parse(item.refreshExpiresAt || "") > now),
    proofs: (state.proofs || []).filter((item) => Date.parse(item.expiresAt || "") > now),
    updatedAt: nowIso(),
  });
}

export function withMobileDeviceState(env, operation) {
  const filePath = statePath(env);
  return withStorageFileLock(filePath, async () => {
    const state = await readMobileDeviceState(env);
    const result = await operation(state);
    await writeMobileDeviceState(state, env);
    return result;
  }, {
    timeoutMs: positiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_TIMEOUT_MS", 30_000),
    staleMs: positiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_STALE_MS", 120_000),
    heartbeatMs: positiveMs(env, "ORKESTR_MOBILE_AUTH_LOCK_HEARTBEAT_MS", 10_000),
  });
}
