// Bounded self-healing for Codex auth faults. Server-side auth rejections can
// clear without any local credential change, so a parked Codex home lets one
// held input through as a probe per interval. Claims are single-flight per
// Codex home and persisted so restarts do not multiply probes.
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { clean, codexRuntimeEnvForThread, nowIso, runtimeHome } from "./codex-app-server-common.js";

const DEFAULT_PROBE_INTERVAL_MS = 15 * 60_000;
const MIN_PROBE_INTERVAL_MS = 60_000;
const probeLocks = new Map();

export function codexAuthProbeIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_AUTH_PROBE_INTERVAL_MS ?? DEFAULT_PROBE_INTERVAL_MS);
  return Number.isFinite(parsed) ? Math.max(MIN_PROBE_INTERVAL_MS, parsed) : DEFAULT_PROBE_INTERVAL_MS;
}

// Same resolution as the Codex connector's defaultCodexHome, kept local so
// core does not take a new connector import.
export function codexHomeForThread(thread = {}, env = process.env) {
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  return path.resolve(clean(runtimeEnv.CODEX_HOME) || path.join(runtimeHome(runtimeEnv), ".codex"));
}

function codexAuthProbesPath(env = process.env) {
  return path.join(dataPaths(env).home, "codex-auth-probes.json");
}

function timeMs(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function withProbeLock(key, fn) {
  const previous = probeLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  probeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (probeLocks.get(key) === tail) probeLocks.delete(key);
  }
}

// Claims the single probe slot for the thread's Codex home when both the
// thread's last auth signal and the home's last probe are older than the
// probe interval. Returns the claim (with `probeAt`) or null.
export async function claimCodexAuthProbe(thread = {}, message = {}, env = process.env) {
  if (!message?.id) return null;
  const intervalMs = codexAuthProbeIntervalMs(env);
  const authFailure = thread.runtime?.authFailure || {};
  const threadLastMs = Math.max(timeMs(authFailure.detectedAt), timeMs(authFailure.lastProbeAt));
  if (Date.now() - threadLastMs < intervalMs) return null;
  const codexHome = codexHomeForThread(thread, env);
  const probesPath = codexAuthProbesPath(env);
  return withProbeLock(`${probesPath}\u0000${codexHome}`, async () => {
    const probes = await readJson(probesPath, {}).catch(() => ({}));
    const current = probes && typeof probes === "object" ? probes : {};
    if (Date.now() - timeMs(current[codexHome]?.lastProbeAt) < intervalMs) return null;
    const claim = { lastProbeAt: nowIso(), threadId: clean(thread.id), messageId: clean(message.id) };
    await writeJson(probesPath, { ...current, [codexHome]: claim });
    await appendEvent({
      type: "codex_auth_probe_claimed",
      threadId: claim.threadId,
      messageId: claim.messageId,
      intervalMs,
    }, env).catch(() => {});
    return { ...claim, probeAt: claim.lastProbeAt, codexHome };
  });
}
