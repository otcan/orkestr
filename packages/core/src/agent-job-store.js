// Durable store for Agent Job runs (docs/spec/agent-job.md §3): pinned job
// specs, runs, attempts, the checkpoint journal and run leases. SQLite under
// ORKESTR_HOME, opened synchronously so every multi-statement change is one
// BEGIN IMMEDIATE transaction, which also serializes concurrent processes
// (server, `orkestr run`, `orkestr jobs approve`) that share one home.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { assertTestStoragePath } from "../../storage/src/test-storage-isolation.js";

export const RUN_TERMINAL_STATES = Object.freeze(["succeeded", "failed", "cancelled", "skipped"]);
export const RUN_ACTIVE_STATES = Object.freeze(["pending", "running", "retrying", "awaiting_approval"]);

const databases = new Map();
let sqliteModule = null;

export function nowMs() {
  return Date.now();
}

export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function specHash(spec) {
  return `sha256:${sha256(spec)}`;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function isTerminalRunState(state) {
  return RUN_TERMINAL_STATES.includes(String(state || ""));
}

// A holder id names one process lifetime. Same-host holders whose pid is gone
// are dead even before their lease expires, so a restart can take over at once.
export function processHolderId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

export function holderIsDead(holder) {
  const [host, pid] = String(holder || "").split(":");
  if (!host || host !== os.hostname() || !/^\d+$/.test(pid || "")) return false;
  if (Number(pid) === process.pid) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

const schema = `
create table if not exists job_specs (spec_hash text primary key, name text not null, spec_json text not null, created_at text not null);
create table if not exists jobs (name text primary key, spec_hash text not null, source text, registered_at text not null, updated_at text not null);
create table if not exists runs (
  id text primary key, job text not null, run_key text not null unique, spec_hash text not null,
  trigger_json text not null, state text not null, reason text, attempt_count integer not null default 0,
  provider_index integer not null default 0, lease_holder text, lease_expires_at integer, next_attempt_at integer,
  cancel_requested_at text, cancel_requested_by text, output_json text, error text, audit_json text, sealed_at text,
  created_at text not null, updated_at text not null, finished_at text);
create index if not exists agent_job_runs_state on runs(state);
create index if not exists agent_job_runs_job on runs(job, created_at);
create table if not exists attempts (
  run_id text not null, n integer not null, provider text not null, model text, state text not null,
  end_reason text, error text, resumed_from_seq integer, last_seq integer, started_at text not null, ended_at text,
  primary key (run_id, n));
create table if not exists checkpoints (
  run_id text not null, seq integer not null, attempt integer, kind text not null, data_json text not null, at text not null,
  primary key (run_id, seq));
create table if not exists effects (
  effect_key text primary key, run_id text not null, tool text not null, args_hash text not null, args_json text not null,
  state text not null, mode text not null, dispatched_at text, result_json text, ref text, outcome text,
  reconciled integer not null default 0, error text, created_at text not null, updated_at text not null);
create index if not exists agent_job_effects_run on effects(run_id);
create table if not exists approvals (
  id text primary key, run_id text not null, effect_key text not null, args_hash text not null, tool text not null,
  args_json text not null, reason text not null, state text not null, requested_at text not null, expires_at integer not null,
  decided_by text, decided_at text, comment text, consumed_at text);
create index if not exists agent_job_approvals_run on approvals(run_id);
create table if not exists notifications (
  key text primary key, run_id text not null, event text not null, channel text not null, target text not null,
  payload_json text not null, outbox_job_id text, created_at text not null, relayed_at text);
create table if not exists schedule_state (job text not null, trigger_index integer not null, next_fire_at integer not null,
  primary key (job, trigger_index));
`;

export async function agentJobDbPath(env = process.env) {
  const paths = await ensureDataDirs(env);
  return String(env.ORKESTR_AGENT_JOBS_DB || "").trim() || path.join(paths.home, "agent-jobs.sqlite");
}

export async function openAgentJobDb(env = process.env) {
  const dbPath = assertTestStoragePath(await agentJobDbPath(env), env, "agent_jobs_sqlite");
  if (databases.has(dbPath)) return databases.get(dbPath);
  sqliteModule ||= await import("node:sqlite");
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec("pragma journal_mode = WAL");
  // FULL: an admitted run must survive power loss, not only a process crash (G1).
  db.exec("pragma synchronous = FULL");
  db.exec("pragma busy_timeout = 10000");
  db.exec(schema);
  databases.set(dbPath, db);
  return db;
}

export async function closeAgentJobDbs() {
  for (const db of databases.values()) {
    try { db.close(); } catch {}
  }
  databases.clear();
}

// Run fn(db) inside one IMMEDIATE transaction. fn must be synchronous.
export function tx(db, fn) {
  db.exec("begin immediate");
  try {
    const result = fn(db);
    db.exec("commit");
    return result;
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
}

function parse(json, fallback = null) {
  if (json === null || json === undefined || json === "") return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

export function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    job: row.job,
    runKey: row.run_key,
    specHash: row.spec_hash,
    trigger: parse(row.trigger_json, {}),
    state: row.state,
    reason: row.reason || null,
    attemptCount: Number(row.attempt_count || 0),
    providerIndex: Number(row.provider_index || 0),
    leaseHolder: row.lease_holder || null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    nextAttemptAt: row.next_attempt_at ?? null,
    cancelRequestedAt: row.cancel_requested_at || null,
    cancelRequestedBy: row.cancel_requested_by || null,
    output: parse(row.output_json),
    error: row.error || null,
    sealed: Boolean(row.sealed_at),
    sealedAt: row.sealed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

export function rowToAttempt(row) {
  return {
    n: Number(row.n),
    provider: row.provider,
    model: row.model || null,
    state: row.state,
    endReason: row.end_reason || null,
    error: row.error || null,
    resumedFromSeq: row.resumed_from_seq ?? null,
    lastSeq: row.last_seq ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
  };
}

// ---- job specs (G8: runs pin a spec_hash; edits create a new hash) ----

export function pinSpecSync(db, spec) {
  const hash = specHash(spec);
  db.prepare("insert or ignore into job_specs (spec_hash, name, spec_json, created_at) values (?, ?, ?, ?)")
    .run(hash, spec.metadata.name, JSON.stringify(spec), nowIso());
  return hash;
}

export async function registerJobSpec(spec, { source = "" } = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  return tx(db, () => {
    const hash = pinSpecSync(db, spec);
    const now = nowIso();
    db.prepare(`insert into jobs (name, spec_hash, source, registered_at, updated_at) values (?, ?, ?, ?, ?)
      on conflict(name) do update set spec_hash = excluded.spec_hash, source = excluded.source, updated_at = excluded.updated_at`)
      .run(spec.metadata.name, hash, String(source || ""), now, now);
    return { name: spec.metadata.name, specHash: hash, source: String(source || "") };
  });
}

export async function getRegisteredJob(name, env = process.env) {
  const db = await openAgentJobDb(env);
  const row = db.prepare("select j.name, j.spec_hash, j.source, s.spec_json from jobs j join job_specs s on s.spec_hash = j.spec_hash where j.name = ?").get(String(name || ""));
  return row ? { name: row.name, specHash: row.spec_hash, source: row.source || "", spec: parse(row.spec_json) } : null;
}

export async function listRegisteredJobs(env = process.env) {
  const db = await openAgentJobDb(env);
  return db.prepare("select name, spec_hash, source, updated_at from jobs order by name").all()
    .map((row) => ({ name: row.name, specHash: row.spec_hash, source: row.source || "", updatedAt: row.updated_at }));
}

export function getPinnedSpecSync(db, hash) {
  const row = db.prepare("select spec_json from job_specs where spec_hash = ?").get(String(hash || ""));
  return row ? parse(row.spec_json) : null;
}

// ---- runs ----

export function getRunSync(db, id) {
  return rowToRun(db.prepare("select * from runs where id = ?").get(String(id || "")));
}

export async function getRun(id, env = process.env) {
  return getRunSync(await openAgentJobDb(env), id);
}

export async function listRuns({ job = "", state = "", limit = 50 } = {}, env = process.env) {
  const db = await openAgentJobDb(env);
  const where = [];
  const args = [];
  if (job) { where.push("job = ?"); args.push(job); }
  if (state) {
    const states = String(state).split(/[,\s]+/).filter(Boolean);
    where.push(`state in (${states.map(() => "?").join(",")})`);
    args.push(...states);
  }
  const sql = `select * from runs ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc, rowid desc limit ?`;
  return db.prepare(sql).all(...args, Math.max(1, Math.min(1000, Number(limit) || 50))).map(rowToRun);
}

export function updateRunSync(db, id, patch = {}) {
  const columns = {
    state: "state", reason: "reason", attemptCount: "attempt_count", providerIndex: "provider_index",
    nextAttemptAt: "next_attempt_at", output: "output_json", error: "error", finishedAt: "finished_at",
    cancelRequestedAt: "cancel_requested_at", cancelRequestedBy: "cancel_requested_by",
    audit: "audit_json", sealedAt: "sealed_at", leaseHolder: "lease_holder", leaseExpiresAt: "lease_expires_at",
  };
  const sets = ["updated_at = ?"];
  const args = [nowIso()];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    args.push(key === "output" || key === "audit" ? (value === null ? null : JSON.stringify(value)) : value ?? null);
  }
  db.prepare(`update runs set ${sets.join(", ")} where id = ?`).run(...args, id);
  return getRunSync(db, id);
}

// ---- leases: exactly one driver per run ----

export function acquireLeaseSync(db, runId, holder, ttlMs, now = nowMs()) {
  const row = db.prepare("select lease_holder, lease_expires_at from runs where id = ?").get(runId);
  if (!row) return false;
  const free = !row.lease_holder || row.lease_holder === holder || Number(row.lease_expires_at || 0) <= now || holderIsDead(row.lease_holder);
  if (!free) return false;
  db.prepare("update runs set lease_holder = ?, lease_expires_at = ? where id = ?").run(holder, now + ttlMs, runId);
  return true;
}

export async function acquireLease(runId, holder, ttlMs, env = process.env) {
  const db = await openAgentJobDb(env);
  return tx(db, () => acquireLeaseSync(db, runId, holder, ttlMs));
}

export async function renewLease(runId, holder, ttlMs, env = process.env) {
  const db = await openAgentJobDb(env);
  const result = db.prepare("update runs set lease_expires_at = ? where id = ? and lease_holder = ?").run(nowMs() + ttlMs, runId, holder);
  return Number(result.changes) === 1;
}

export async function releaseLease(runId, holder, env = process.env) {
  const db = await openAgentJobDb(env);
  db.prepare("update runs set lease_holder = null, lease_expires_at = null where id = ? and lease_holder = ?").run(runId, holder);
}

export function holdsLeaseSync(db, runId, holder) {
  const row = db.prepare("select lease_holder, lease_expires_at from runs where id = ?").get(runId);
  return Boolean(row && row.lease_holder === holder && Number(row.lease_expires_at || 0) > nowMs());
}

// ---- attempts ----

export function listAttemptsSync(db, runId) {
  return db.prepare("select * from attempts where run_id = ? order by n").all(runId).map(rowToAttempt);
}

export function insertAttemptSync(db, runId, n, { provider, model = null, resumedFromSeq = null }) {
  db.prepare("insert into attempts (run_id, n, provider, model, state, resumed_from_seq, started_at) values (?, ?, ?, ?, 'starting', ?, ?)")
    .run(runId, n, provider, model, resumedFromSeq, nowIso());
}

export function updateAttemptSync(db, runId, n, { state, endReason, error, lastSeq } = {}) {
  const sets = [];
  const args = [];
  if (state) { sets.push("state = ?"); args.push(state); }
  if (endReason) { sets.push("end_reason = ?", "ended_at = ?"); args.push(endReason, nowIso()); }
  if (error !== undefined) { sets.push("error = ?"); args.push(error ? String(error).slice(0, 1000) : null); }
  if (lastSeq !== undefined) { sets.push("last_seq = ?"); args.push(lastSeq); }
  if (!sets.length) return;
  db.prepare(`update attempts set ${sets.join(", ")} where run_id = ? and n = ?`).run(...args, runId, n);
}

// ---- checkpoint journal (append-only) ----

export function appendCheckpointSync(db, runId, attempt, kind, data = {}) {
  const row = db.prepare("select coalesce(max(seq), 0) as seq from checkpoints where run_id = ?").get(runId);
  const seq = Number(row.seq) + 1;
  db.prepare("insert into checkpoints (run_id, seq, attempt, kind, data_json, at) values (?, ?, ?, ?, ?, ?)")
    .run(runId, seq, attempt ?? null, kind, JSON.stringify(data ?? {}), nowIso());
  if (attempt) db.prepare("update attempts set last_seq = ? where run_id = ? and n = ?").run(seq, runId, attempt);
  return seq;
}

export function listCheckpointsSync(db, runId, kinds = null) {
  const rows = db.prepare("select * from checkpoints where run_id = ? order by seq").all(runId);
  return rows
    .filter((row) => !kinds || kinds.includes(row.kind))
    .map((row) => ({ seq: Number(row.seq), attempt: row.attempt ?? null, kind: row.kind, data: parse(row.data_json, {}), at: row.at }));
}

export async function listCheckpoints(runId, env = process.env) {
  return listCheckpointsSync(await openAgentJobDb(env), runId);
}
