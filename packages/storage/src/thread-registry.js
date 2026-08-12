import fs from "node:fs/promises";
import { ensureDataDirs } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { assertPublicRefInvariant, assertUniquePublicRefs } from "./public-references.js";
import { withStorageFileLock } from "./storage-lock.js";

const dbCache = new Map();
const dbPaths = new WeakMap();
const threadListCache = new Map();
let sqliteModulePromise = null;

export async function listThreadRecords(env = process.env) {
  const db = await openThreadDatabase(env);
  if (!db) {
    const paths = await ensureDataDirs(env);
    return dedupeThreadRecords(await readJson(paths.threads, []));
  }
  const dbPath = dbPaths.get(db);
  const dataVersion = threadDatabaseVersion(db);
  const cached = dbPath ? threadListCache.get(dbPath) : null;
  if (cached?.dataVersion === dataVersion) return cached.records.slice();
  const rows = db
    .prepare("select data from orkestr_threads order by created_at asc, id asc")
    .all();
  const records = dedupeThreadRecords(rows.map((row) => JSON.parse(row.data)));
  if (dbPath) threadListCache.set(dbPath, { dataVersion, records });
  return records.slice();
}

export async function saveThreadRecords(threads, env = process.env) {
  return saveThreadRecordsValidated(threads, env);
}

async function saveThreadRecordsValidated(threads, env, options = {}) {
  const records = dedupeThreadRecords(Array.isArray(threads) ? threads : []);
  const db = await openThreadDatabase(env);
  if (!db) {
    const paths = await ensureDataDirs(env);
    validateThreadPublicRefs(await readJson(paths.threads, []), records, options);
    await writeJson(paths.threads, records);
    return records;
  }
  validateThreadPublicRefs(await listThreadRecords(env), records, options);
  replaceThreadRows(db, records);
  cacheThreadRecords(db, records);
  const paths = await ensureDataDirs(env);
  await writeJson(paths.threads, records);
  return records;
}

export async function assignThreadPublicRefs(assignments = [], env = process.env) {
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.canonicalPublicRefLock, () => assignThreadPublicRefsLocked(assignments, env));
}

async function assignThreadPublicRefsLocked(assignments = [], env = process.env) {
  const records = await listThreadRecords(env);
  const byId = new Map(assignments.map((item) => [String(item.id || "").trim(), item]));
  const found = new Set();
  const next = records.map((record) => {
    const assignment = byId.get(String(record.id || "").trim());
    if (!assignment) return record;
    found.add(String(record.id || "").trim());
    assertPublicRefInvariant(record.publicRef, assignment.publicRef, "thread", { allowAssignment: true });
    return record.publicRef ? record : { ...record, publicRef: assignment.publicRef, publicRefAssignedAt: assignment.publicRefAssignedAt };
  });
  if (found.size !== byId.size) throw Object.assign(new Error("thread_public_ref_assignment_stale"), { statusCode: 409 });
  return saveThreadRecordsValidated(next, env, { allowAssignment: true });
}

export async function rollbackThreadPublicRefAssignments(assignments = [], env = process.env) {
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.canonicalPublicRefLock, () => rollbackThreadPublicRefAssignmentsLocked(assignments, env));
}

async function rollbackThreadPublicRefAssignmentsLocked(assignments = [], env = process.env) {
  const expected = new Map(assignments.map((item) => [String(item.id || "").trim(), item]));
  const current = await listThreadRecords(env);
  const next = current.map((record) => {
    const assignment = expected.get(String(record.id || "").trim());
    if (!assignment || record.publicRef !== assignment.publicRef || record.publicRefAssignedAt !== assignment.publicRefAssignedAt) return record;
    const reverted = { ...record };
    delete reverted.publicRef;
    delete reverted.publicRefAssignedAt;
    return reverted;
  });
  return saveThreadRecordsInternal(next, env);
}

function validateThreadPublicRefs(previous, next, options = {}) {
  assertUniquePublicRefs(next, "thread");
  const priorById = new Map((previous || []).map((record) => [String(record?.id || "").trim(), record]));
  for (const record of next) {
    const prior = priorById.get(String(record?.id || "").trim());
    if (!prior) continue;
    assertPublicRefInvariant(prior.publicRef, record.publicRef, "thread", options);
    if (prior.publicRefAssignedAt && prior.publicRefAssignedAt !== record.publicRefAssignedAt) throw Object.assign(new Error("thread_public_ref_metadata_immutable"), { statusCode: 409 });
  }
}

async function saveThreadRecordsInternal(records, env) {
  const db = await openThreadDatabase(env);
  if (!db) {
    const paths = await ensureDataDirs(env);
    await writeJson(paths.threads, records);
    return records;
  }
  replaceThreadRows(db, records);
  cacheThreadRecords(db, records);
  const paths = await ensureDataDirs(env);
  await writeJson(paths.threads, records);
  return records;
}

export async function closeThreadRegistryCache(env = null) {
  const selected = new Set();
  if (env) {
    try {
      const paths = await ensureDataDirs(env);
      if (paths.threadsDb) selected.add(paths.threadsDb);
    } catch {
      // Fall back to closing all cached databases below.
    }
  }
  for (const [dbPath, db] of dbCache.entries()) {
    if (selected.size && !selected.has(dbPath)) continue;
    dbCache.delete(dbPath);
    threadListCache.delete(dbPath);
    try {
      db.close();
    } catch {
      // Closing is best-effort for one-shot CLI cleanup.
    }
  }
}

export function dedupeThreadRecords(threads) {
  if (!Array.isArray(threads) || threads.length < 2) return Array.isArray(threads) ? threads : [];
  const selected = new Map();
  threads.forEach((thread, index) => {
    const key = threadDedupeKey(thread);
    if (!key) return;
    const current = selected.get(key);
    if (!current || compareThreadDedupeCandidate(thread, index, current.thread, current.index) > 0) {
      selected.set(key, { thread, index });
    }
  });
  return threads.filter((thread, index) => {
    const key = threadDedupeKey(thread);
    if (!key) return true;
    return selected.get(key)?.index === index;
  });
}

function threadDedupeKey(thread) {
  const owner = String(thread?.ownerUserId || thread?.userId || "admin").trim().toLowerCase() || "admin";
  const name = String(thread?.name || thread?.bindingName || thread?.title || "").trim().toLowerCase();
  if (name) return `owner:${owner}:name:${name}`;
  const id = String(thread?.id || "").trim();
  return id ? `owner:${owner}:id:${id}` : "";
}

function compareThreadDedupeCandidate(left, leftIndex, right, rightIndex) {
  const leftScore = threadDedupeScore(left);
  const rightScore = threadDedupeScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  const leftCreated = Date.parse(String(left?.createdAt || ""));
  const rightCreated = Date.parse(String(right?.createdAt || ""));
  if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
    return rightCreated - leftCreated;
  }
  if (Number.isFinite(leftCreated) !== Number.isFinite(rightCreated)) {
    return Number.isFinite(leftCreated) ? 1 : -1;
  }
  return rightIndex - leftIndex;
}

function threadDedupeScore(thread) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  let score = 0;
  if (String(thread?.executor?.codexThreadId || thread?.codexThreadId || "").trim()) score += 16;
  if (String(thread?.codexModel || metadata.codexModel || "").trim()) score += 8;
  if (String(thread?.codexReasoningEffort || metadata.codexReasoningEffort || "").trim()) score += 4;
  if (String(thread?.workspace || thread?.cwd || thread?.repoPath || thread?.worktreePath || "").trim()) score += 2;
  if (String(thread?.activeRuntimeLeaseId || "").trim()) score += 1;
  return score;
}

async function openThreadDatabase(env) {
  const mode = String(env.ORKESTR_THREAD_STORE || env.ORKESTR_STORAGE || "auto").toLowerCase();
  if (mode === "json") return null;
  const sqlite = await loadSqlite(mode);
  if (!sqlite) return null;

  const paths = await ensureDataDirs(env);
  if (dbCache.has(paths.threadsDb)) return dbCache.get(paths.threadsDb);

  const existed = await fs.stat(paths.threadsDb).then((stat) => stat.size > 0, () => false);
  const db = new sqlite.DatabaseSync(paths.threadsDb);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma busy_timeout = 5000");
  ensureSchema(db);
  dbCache.set(paths.threadsDb, db);
  dbPaths.set(db, paths.threadsDb);
  await migrateJsonThreadsIfNeeded(db, paths, existed);
  return db;
}

async function loadSqlite(mode) {
  try {
    sqliteModulePromise ||= import("node:sqlite");
    return await sqliteModulePromise;
  } catch (error) {
    if (mode === "sqlite") throw error;
    return null;
  }
}

function ensureSchema(db) {
  db.exec(`
    create table if not exists orkestr_threads (
      id text primary key,
      name text,
      binding_name text,
      public_ref text,
      public_ref_assigned_at text,
      created_at text,
      updated_at text,
      data text not null
    );
    create index if not exists idx_orkestr_threads_name on orkestr_threads(name);
    create index if not exists idx_orkestr_threads_binding_name on orkestr_threads(binding_name);
    create table if not exists orkestr_meta (
      key text primary key,
      value text not null
    );
  `);
  ensureColumn(db, "orkestr_threads", "public_ref", "text");
  ensureColumn(db, "orkestr_threads", "public_ref_assigned_at", "text");
  db.exec("create unique index if not exists idx_orkestr_threads_public_ref on orkestr_threads(public_ref) where public_ref is not null");
}

function ensureColumn(db, table, column, type) {
  if (db.prepare(`pragma table_info(${table})`).all().some((item) => item.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${type}`);
}

async function migrateJsonThreadsIfNeeded(db, paths, existed) {
  const migrated = db.prepare("select value from orkestr_meta where key = ?").get("threads_json_migrated_at");
  const count = Number(db.prepare("select count(*) as count from orkestr_threads").get().count || 0);
  if (migrated || (existed && count > 0)) return;
  const fromJson = await readJson(paths.threads, []);
  if (Array.isArray(fromJson) && fromJson.length) replaceThreadRows(db, fromJson);
  setMeta(db, "threads_json_migrated_at", new Date().toISOString());
}

function replaceThreadRows(db, threads) {
  db.exec("begin immediate");
  try {
    db.exec("delete from orkestr_threads");
    const insert = db.prepare(`
      insert into orkestr_threads(id, name, binding_name, public_ref, public_ref_assigned_at, created_at, updated_at, data)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const thread of threads) {
      const id = String(thread?.id || "").trim();
      if (!id) continue;
      insert.run(
        id,
        String(thread?.name || ""),
        String(thread?.bindingName || thread?.binding?.displayName || ""),
        String(thread?.publicRef || "") || null,
        String(thread?.publicRefAssignedAt || "") || null,
        String(thread?.createdAt || ""),
        String(thread?.updatedAt || ""),
        JSON.stringify(thread),
      );
    }
    setMeta(db, "threads_updated_at", new Date().toISOString());
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function threadDatabaseVersion(db) {
  return Number(db.prepare("pragma data_version").get()?.data_version || 0);
}

function cacheThreadRecords(db, records) {
  const dbPath = dbPaths.get(db);
  if (!dbPath) return;
  threadListCache.set(dbPath, {
    dataVersion: threadDatabaseVersion(db),
    records: Array.isArray(records) ? records.slice() : [],
  });
}

function setMeta(db, key, value) {
  db.prepare(`
    insert into orkestr_meta(key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(key, value);
}
