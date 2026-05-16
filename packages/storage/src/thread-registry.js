import fs from "node:fs/promises";
import { ensureDataDirs } from "./paths.js";
import { readJson, writeJson } from "./store.js";

const dbCache = new Map();
let sqliteModulePromise = null;

export async function listThreadRecords(env = process.env) {
  const db = await openThreadDatabase(env);
  if (!db) {
    const paths = await ensureDataDirs(env);
    return readJson(paths.threads, []);
  }
  const rows = db
    .prepare("select data from orkestr_threads order by created_at asc, id asc")
    .all();
  return rows.map((row) => JSON.parse(row.data));
}

export async function saveThreadRecords(threads, env = process.env) {
  const records = Array.isArray(threads) ? threads : [];
  const db = await openThreadDatabase(env);
  if (!db) {
    const paths = await ensureDataDirs(env);
    await writeJson(paths.threads, records);
    return records;
  }
  replaceThreadRows(db, records);
  const paths = await ensureDataDirs(env);
  await writeJson(paths.threads, records);
  return records;
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
      insert into orkestr_threads(id, name, binding_name, created_at, updated_at, data)
      values (?, ?, ?, ?, ?, ?)
    `);
    for (const thread of threads) {
      const id = String(thread?.id || "").trim();
      if (!id) continue;
      insert.run(
        id,
        String(thread?.name || ""),
        String(thread?.bindingName || thread?.binding?.displayName || ""),
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

function setMeta(db, key, value) {
  db.prepare(`
    insert into orkestr_meta(key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(key, value);
}
