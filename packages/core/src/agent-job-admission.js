// Admission for Agent Job runs (docs/spec/agent-job.md §3.1): load and pin
// job specs, compute run_key = H(job, trigger, dedupe_key), dedupe redelivered
// events (G2) and apply the job's concurrency policy. A run exists on disk
// before admitRun returns (G1).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { normalizeAgentJobSpec } from "./agent-job-spec.js";
import { loadAgentJobYaml } from "./agent-job-spec-yaml.js";
import { finalizeRunSync } from "./agent-job-audit.js";
import { agentJobProviderStatus, providerNotConnectedError } from "./agent-job-providers.js";
import {
  RUN_ACTIVE_STATES,
  appendCheckpointSync,
  getRegisteredJob,
  getRunSync,
  newId,
  recordTriggerAudit,
  nowIso,
  openAgentJobDb,
  pinSpecSync,
  registerJobSpec,
  sha256,
  stableStringify,
  tx,
  updateRunSync,
} from "./agent-job-store.js";

const JOB_FILE_RE = /\.(ya?ml|json)$/i;

function admissionError(code, statusCode = 400, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

export async function loadJobFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  if (/\.json$/i.test(filePath)) return normalizeAgentJobSpec(JSON.parse(text));
  return loadAgentJobYaml(text);
}

// A path is either one job file or a directory of job files (non-recursive,
// plus a `jobs/` subdirectory, which is where `orkestr init` writes).
export async function loadJobFiles(target) {
  const resolved = path.resolve(String(target || "."));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw admissionError("job_path_not_found", 404, { path: resolved });
  if (stat.isFile()) return [{ path: resolved, spec: await loadJobFile(resolved) }];
  const files = [];
  for (const dir of [resolved, path.join(resolved, "jobs")]) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names.sort()) if (JOB_FILE_RE.test(name)) files.push(path.join(dir, name));
  }
  if (!files.length) throw admissionError("no_job_files", 404, { path: resolved });
  return Promise.all(files.map(async (file) => ({ path: file, spec: await loadJobFile(file) })));
}

export async function registerJobFiles(target, env = process.env) {
  const loaded = await loadJobFiles(target);
  const registered = [];
  for (const entry of loaded) registered.push({ ...(await registerJobSpec(entry.spec, { source: entry.path }, env)), spec: entry.spec });
  return registered;
}

// Jobs placed under ORKESTR_HOME/agent-jobs (or ORKESTR_AGENT_JOBS_DIR) and
// the overlay's jobs/ directory are registered on server start.
export async function syncJobDirectories(env = process.env) {
  const { home } = await ensureDataDirs(env);
  const dirs = [String(env.ORKESTR_AGENT_JOBS_DIR || "").trim() || path.join(home, "agent-jobs")];
  if (String(env.ORKESTR_OVERLAY_DIR || "").trim()) dirs.push(path.join(env.ORKESTR_OVERLAY_DIR, "jobs"));
  const registered = [];
  const errors = [];
  for (const dir of dirs) {
    if (!dir || !(await fs.stat(dir).catch(() => null))?.isDirectory()) continue;
    for (const name of (await fs.readdir(dir)).sort()) {
      if (!JOB_FILE_RE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        registered.push(await registerJobSpec(await loadJobFile(file), { source: file }, env));
      } catch (error) {
        errors.push({ file, error: error?.message || String(error) });
      }
    }
  }
  return { registered, errors };
}

export function runKeyFor(job, triggerName, dedupeKey) {
  return `rk_${sha256(stableStringify([job, triggerName, dedupeKey]))}`;
}

function jsonPointer(body, pointer) {
  let value = body;
  for (const raw of String(pointer || "").split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

// Pick the trigger an event belongs to and the event's dedupe key.
export function resolveTrigger(spec, { type, name = "", index = null, dedupeKey = "", body = null } = {}) {
  const triggers = spec.triggers.filter((trigger) => trigger.type === type);
  if (!triggers.length) throw admissionError("trigger_not_declared", 404, { type });
  const trigger = type === "webhook"
    ? triggers.find((entry) => !name || entry.name === name)
    : Number.isInteger(index) ? spec.triggers[index] : triggers[0];
  if (!trigger) throw admissionError("trigger_not_declared", 404, { type, name });
  let key = String(dedupeKey || "").trim();
  if (!key && type === "webhook") {
    const fromBody = trigger.eventId ? jsonPointer(body, trigger.eventId) : undefined;
    key = fromBody !== undefined && fromBody !== null && fromBody !== "" ? String(fromBody) : `body:${sha256(stableStringify(body ?? null))}`;
  }
  if (!key) key = `once:${crypto.randomUUID()}`;
  const triggerName = trigger.name || (Number.isInteger(index) ? `${trigger.type}-${index}` : trigger.type);
  return { trigger, triggerName, dedupeKey: key.slice(0, 512) };
}

function activeRunsSync(db, job) {
  return db.prepare(`select id, state from runs where job = ? and state in (${RUN_ACTIVE_STATES.map(() => "?").join(",")}) order by created_at, rowid`)
    .all(job, ...RUN_ACTIVE_STATES);
}

/**
 * Admit one trigger event. Returns { run, deduplicated }.
 * Pass `spec` to admit against a spec directly (it is pinned and registered),
 * or `job` to use the currently registered spec.
 */
export async function admitRun({ job = "", spec = null, type = "api", name = "", index = null, dedupeKey = "", body = null, source = "" } = {}, env = process.env) {
  let pinned = spec;
  if (pinned) await registerJobSpec(pinned, { source }, env);
  else {
    const registered = await getRegisteredJob(job, env);
    if (!registered) throw admissionError("job_not_found", 404, { job });
    pinned = registered.spec;
  }
  const jobName = pinned.metadata.name;
  const { trigger, triggerName, dedupeKey: key } = resolveTrigger(pinned, { type, name, index, dedupeKey, body });
  // Owner decision: never admit a run whose provider is not connected.
  const status = await agentJobProviderStatus(pinned.agent.provider, env);
  if (!status.runnable) {
    await recordTriggerAudit({ job: jobName, type, outcome: "rejected", reason: `provider_not_connected:${status.reason}`, sourceRef: key }, env);
    throw providerNotConnectedError(pinned.agent.provider, status.reason);
  }
  const runKey = runKeyFor(jobName, triggerName, key);
  const db = await openAgentJobDb(env);
  return tx(db, () => {
    const existing = db.prepare("select id from runs where run_key = ?").get(runKey);
    if (existing) return { run: getRunSync(db, existing.id), deduplicated: true };
    const hash = pinSpecSync(db, pinned);
    const id = newId("run");
    const now = nowIso();
    const triggerRecord = { type: trigger.type, name: trigger.name || null, dedupeKey: key, event: body ?? null };
    db.prepare(`insert into runs (id, job, run_key, spec_hash, trigger_json, state, created_at, updated_at)
      values (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, jobName, runKey, hash, JSON.stringify(triggerRecord), now, now);
    appendCheckpointSync(db, id, null, "run_admitted", { trigger: trigger.type, name: trigger.name || null, specHash: hash });
    const active = activeRunsSync(db, jobName).filter((row) => row.id !== id);
    const policy = pinned.runtime.concurrency;
    if (active.length && policy === "forbid") {
      return { run: finalizeRunSync(db, id, { state: "skipped", reason: "concurrency_forbid" }), deduplicated: false };
    }
    if (active.length && policy === "replace") {
      for (const row of active) updateRunSync(db, row.id, { cancelRequestedAt: now, cancelRequestedBy: `replace:${id}` });
    }
    return { run: getRunSync(db, id), deduplicated: false };
  });
}

// Record a cancel. The driver holding the lease stops before the next effect
// and finalizes; an unleased run is finalized by the next drive or sweep (G11).
export async function requestCancel(runId, { by = "" } = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  return tx(db, () => {
    const run = getRunSync(db, runId);
    if (!run) throw admissionError("run_not_found", 404);
    if (!RUN_ACTIVE_STATES.includes(run.state)) return run;
    if (!run.cancelRequestedAt) {
      updateRunSync(db, runId, { cancelRequestedAt: nowIso(), cancelRequestedBy: String(by || "unknown").slice(0, 200) });
      appendCheckpointSync(db, runId, null, "cancel_requested", { by: String(by || "unknown").slice(0, 200) });
    }
    return getRunSync(db, runId);
  });
}
