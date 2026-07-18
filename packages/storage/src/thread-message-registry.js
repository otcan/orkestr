import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "./paths.js";
import { readJson } from "./store.js";

const dbCache = new Map();
const migratedThreads = new Map();
let sqliteModulePromise = null;

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function sqliteThreadMessageStore(env = process.env) {
  const explicit = String(env.ORKESTR_THREAD_MESSAGE_STORE || "").trim().toLowerCase();
  if (explicit) return explicit === "sqlite";
  return String(env.ORKESTR_THREAD_STORE || "").trim().toLowerCase() === "sqlite";
}

async function loadSqlite() {
  try {
    sqliteModulePromise ||= import("node:sqlite");
    return await sqliteModulePromise;
  } catch {
    return null;
  }
}

function ensureSchema(db) {
  db.exec(`
    create table if not exists orkestr_thread_messages (
      thread_id text not null,
      id text not null,
      position integer not null,
      cursor integer not null,
      role text,
      state text,
      source text,
      phase text,
      connector text,
      chat_id text,
      parent_message_id text,
      event_id text,
      codex_thread_id text,
      codex_turn_id text,
      codex_item_id text,
      client_message_id text,
      external_id text,
      created_at text,
      updated_at text,
      data text not null,
      primary key(thread_id, id),
      unique(thread_id, position)
    );
    create index if not exists idx_orkestr_thread_messages_cursor
      on orkestr_thread_messages(thread_id, cursor, position);
    create index if not exists idx_orkestr_thread_messages_state
      on orkestr_thread_messages(thread_id, state, position);
    create index if not exists idx_orkestr_thread_messages_phase
      on orkestr_thread_messages(thread_id, phase, position);
    create index if not exists idx_orkestr_thread_messages_recent_delivery
      on orkestr_thread_messages(thread_id, source, connector, role, state, created_at, position);
    create index if not exists idx_orkestr_thread_messages_client
      on orkestr_thread_messages(thread_id, client_message_id);
    create index if not exists idx_orkestr_thread_messages_external
      on orkestr_thread_messages(thread_id, external_id, chat_id);
    create index if not exists idx_orkestr_thread_messages_parent
      on orkestr_thread_messages(thread_id, parent_message_id, position);
    create index if not exists idx_orkestr_thread_messages_event
      on orkestr_thread_messages(thread_id, event_id);
    create index if not exists idx_orkestr_thread_messages_codex_item
      on orkestr_thread_messages(thread_id, codex_thread_id, codex_turn_id, codex_item_id, role, phase);
    create table if not exists orkestr_thread_message_meta (
      thread_id text primary key,
      source_signature text not null default '',
      revision integer not null default 0,
      migrated_at text,
      updated_at text not null
    );
  `);
}

async function openDatabase(env = process.env) {
  if (!sqliteThreadMessageStore(env)) return null;
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const paths = await ensureDataDirs(env);
  if (dbCache.has(paths.threadMessagesDb)) return dbCache.get(paths.threadMessagesDb);
  const db = new sqlite.DatabaseSync(paths.threadMessagesDb);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma busy_timeout = 5000");
  ensureSchema(db);
  dbCache.set(paths.threadMessagesDb, db);
  return db;
}

function messageColumns(message = {}, position = 0) {
  const numericCursor = Number(message?.cursor || 0);
  return {
    id: String(message?.id || "").trim(),
    position: Math.max(1, Number(position || 0) || 1),
    cursor: Number.isFinite(numericCursor) && numericCursor > 0 ? Math.floor(numericCursor) : Math.max(1, Number(position || 0) || 1),
    role: String(message?.role || message?.kind || ""),
    state: String(message?.state || ""),
    source: String(message?.source || ""),
    phase: String(message?.phase || ""),
    connector: String(message?.connector || ""),
    chatId: String(message?.chatId || ""),
    parentMessageId: String(message?.parentMessageId || ""),
    eventId: String(message?.eventId || ""),
    codexThreadId: String(message?.codexThreadId || message?.executorThreadId || ""),
    codexTurnId: String(message?.codexTurnId || message?.executorTurnId || ""),
    codexItemId: String(message?.codexItemId || message?.executorItemId || ""),
    clientMessageId: String(message?.clientMessageId || message?.idempotencyKey || ""),
    externalId: String(message?.externalId || ""),
    createdAt: String(message?.createdAt || message?.timestamp || ""),
    updatedAt: String(message?.updatedAt || message?.deliveredAt || message?.createdAt || message?.timestamp || ""),
    data: JSON.stringify(message),
  };
}

function insertStatement(db) {
  return db.prepare(`
    insert into orkestr_thread_messages(
      thread_id, id, position, cursor, role, state, source, phase, connector,
      chat_id, parent_message_id, event_id, codex_thread_id, codex_turn_id, codex_item_id,
      client_message_id, external_id, created_at, updated_at, data
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(thread_id, id) do update set
      cursor = excluded.cursor,
      role = excluded.role,
      state = excluded.state,
      source = excluded.source,
      phase = excluded.phase,
      connector = excluded.connector,
      chat_id = excluded.chat_id,
      parent_message_id = excluded.parent_message_id,
      event_id = excluded.event_id,
      codex_thread_id = excluded.codex_thread_id,
      codex_turn_id = excluded.codex_turn_id,
      codex_item_id = excluded.codex_item_id,
      client_message_id = excluded.client_message_id,
      external_id = excluded.external_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      data = excluded.data
  `);
}

function insertMessage(statement, threadId, message, position) {
  const row = messageColumns(message, position);
  if (!row.id) return false;
  statement.run(
    threadId, row.id, row.position, row.cursor, row.role, row.state, row.source, row.phase,
    row.connector, row.chatId, row.parentMessageId, row.eventId, row.codexThreadId, row.codexTurnId, row.codexItemId,
    row.clientMessageId, row.externalId,
    row.createdAt, row.updatedAt, row.data,
  );
  return true;
}

function sourcePath(threadId, env = process.env) {
  return path.join(dataPaths(env).threadMessages, `${safeThreadId(threadId)}.json`);
}

async function sourceSignature(threadId, env = process.env) {
  const stat = await fs.stat(sourcePath(threadId, env)).catch(() => null);
  return stat?.isFile() ? `${stat.mtimeMs}:${stat.size}` : "missing";
}

function touchMeta(db, threadId, { source = null, migrated = false } = {}) {
  const current = db.prepare("select source_signature, revision, migrated_at from orkestr_thread_message_meta where thread_id = ?").get(threadId);
  const now = new Date().toISOString();
  db.prepare(`
    insert into orkestr_thread_message_meta(thread_id, source_signature, revision, migrated_at, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict(thread_id) do update set
      source_signature = excluded.source_signature,
      revision = excluded.revision,
      migrated_at = excluded.migrated_at,
      updated_at = excluded.updated_at
  `).run(
    threadId,
    source === null ? String(current?.source_signature || "") : String(source),
    Number(current?.revision || 0) + 1,
    migrated ? now : String(current?.migrated_at || now),
    now,
  );
}

async function ensureMigrated(db, threadId, env = process.env) {
  const dbPath = dataPaths(env).threadMessagesDb;
  const cacheKey = `${dbPath}:${threadId}`;
  if (migratedThreads.has(cacheKey)) return;
  const meta = db.prepare("select source_signature from orkestr_thread_message_meta where thread_id = ?").get(threadId);
  if (meta) {
    migratedThreads.set(cacheKey, String(meta.source_signature || ""));
    return;
  }

  const signature = await sourceSignature(threadId, env);
  const messages = signature === "missing" ? [] : await readJson(sourcePath(threadId, env), []);
  db.exec("begin immediate");
  try {
    db.prepare("delete from orkestr_thread_messages where thread_id = ?").run(threadId);
    const insert = insertStatement(db);
    let position = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      position += 1;
      insertMessage(insert, threadId, message, position);
    }
    touchMeta(db, threadId, { source: signature, migrated: true });
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  migratedThreads.set(cacheKey, signature);
}

function parseRows(rows = []) {
  return rows.map((row) => ({ position: Number(row.position || 0), message: JSON.parse(row.data) }));
}

export async function listThreadMessageRows(threadId, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  return parseRows(db.prepare(`
    select position, data from orkestr_thread_messages
    where thread_id = ? order by position asc
  `).all(threadId)).map((row) => row.message);
}

export async function threadMessageStoreEnabled(env = process.env) {
  return Boolean(await openDatabase(env));
}

export async function listThreadMessageCandidates(threadId, options = {}, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  const selected = new Map();
  const addRows = (rows) => {
    for (const row of parseRows(rows)) {
      const id = String(row.message?.id || `${row.position}`);
      selected.set(id, row);
    }
  };
  const tailLimit = Math.max(0, Number(options.tailLimit || 0) || 0);
  if (tailLimit) {
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where thread_id = ? order by position desc limit ?
    `).all(threadId, tailLimit));
  }
  const hasAfterCursor = Object.prototype.hasOwnProperty.call(options, "afterCursor");
  const afterCursor = Math.max(0, Number(options.afterCursor || 0) || 0);
  if (hasAfterCursor) {
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where thread_id = ? and cursor > ? order by position asc
    `).all(threadId, afterCursor));
  }
  const ids = [...new Set((options.ids || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where thread_id = ? and id in (${placeholders}) order by position asc
    `).all(threadId, ...ids));
  }
  const states = [...new Set((options.states || []).map((value) => String(value || "").trim()).filter(Boolean))];
  for (const state of states) {
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where thread_id = ? and state = ? order by position asc
    `).all(threadId, state));
  }
  const phases = [...new Set((options.phases || []).map((value) => String(value || "").trim()).filter(Boolean))];
  for (const phase of phases) {
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where thread_id = ? and phase = ? order by position asc
    `).all(threadId, phase));
  }
  if (options.recentSince) {
    const source = String(options.recentSource || "").trim();
    const connector = String(options.recentConnector || "").trim();
    const role = String(options.recentRole || "").trim();
    const state = String(options.recentState || "").trim();
    const clauses = ["thread_id = ?", "created_at >= ?"];
    const values = [threadId, String(options.recentSince)];
    for (const [column, value] of [
      ["source", source],
      ["connector", connector],
      ["role", role],
      ["state", state],
    ]) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      values.push(value);
    }
    addRows(db.prepare(`
      select position, data from orkestr_thread_messages
      where ${clauses.join(" and ")}
      order by position asc
    `).all(...values));
  }
  return [...selected.values()].sort((left, right) => left.position - right.position).map((row) => row.message);
}

export async function threadMessageRecord(threadId, messageId, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  const row = db.prepare("select data from orkestr_thread_messages where thread_id = ? and id = ?").get(threadId, messageId);
  return row ? JSON.parse(row.data) : null;
}

export async function threadMessageRecordsByStates(threadId, states = [], env = process.env) {
  return listThreadMessageCandidates(threadId, { states }, env);
}

export async function findThreadMessageRecord(threadId, fields = {}, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  const clauses = ["thread_id = ?"];
  const values = [threadId];
  for (const [column, value] of [
    ["client_message_id", fields.clientMessageId],
    ["external_id", fields.externalId],
    ["chat_id", fields.chatId],
    ["event_id", fields.eventId],
    ["codex_thread_id", fields.codexThreadId],
    ["codex_turn_id", fields.codexTurnId],
    ["codex_item_id", fields.codexItemId],
    ["phase", fields.phase],
    ["role", fields.role],
    ["state", fields.state],
  ]) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    clauses.push(`${column} = ?`);
    values.push(normalized);
  }
  const row = db.prepare(`
    select data from orkestr_thread_messages
    where ${clauses.join(" and ")} order by position desc limit 1
  `).get(...values);
  return row ? JSON.parse(row.data) : null;
}

export async function nextThreadMessageCursor(threadId, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  const row = db.prepare("select max(cursor) as cursor from orkestr_thread_messages where thread_id = ?").get(threadId);
  return Math.max(0, Number(row?.cursor || 0) || 0) + 1;
}

export async function appendThreadMessageRecord(threadId, message, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return false;
  await ensureMigrated(db, threadId, env);
  db.exec("begin immediate");
  try {
    const next = db.prepare("select coalesce(max(position), 0) + 1 as position from orkestr_thread_messages where thread_id = ?").get(threadId);
    insertMessage(insertStatement(db), threadId, message, Number(next.position || 1));
    touchMeta(db, threadId);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return true;
}

export async function updateThreadMessageRecord(threadId, messageId, message, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return false;
  await ensureMigrated(db, threadId, env);
  const row = db.prepare("select position from orkestr_thread_messages where thread_id = ? and id = ?").get(threadId, messageId);
  if (!row) return null;
  db.exec("begin immediate");
  try {
    insertMessage(insertStatement(db), threadId, message, Number(row.position || 1));
    touchMeta(db, threadId);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return true;
}

export async function replaceThreadMessageRecords(threadId, messages, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return false;
  await ensureMigrated(db, threadId, env);
  db.exec("begin immediate");
  try {
    db.prepare("delete from orkestr_thread_messages where thread_id = ?").run(threadId);
    const insert = insertStatement(db);
    let position = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      position += 1;
      insertMessage(insert, threadId, message, position);
    }
    touchMeta(db, threadId);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return true;
}

export async function deleteThreadMessageRecords(threadId, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return false;
  await ensureMigrated(db, threadId, env);
  await fs.rm(sourcePath(threadId, env), { force: true });
  db.exec("begin immediate");
  try {
    db.prepare("delete from orkestr_thread_messages where thread_id = ?").run(threadId);
    touchMeta(db, threadId, { source: "missing" });
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  migratedThreads.set(`${dataPaths(env).threadMessagesDb}:${threadId}`, "missing");
  return true;
}

export async function threadMessageStoreFingerprint(threadId, env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  await ensureMigrated(db, threadId, env);
  const row = db.prepare(`
    select revision, updated_at from orkestr_thread_message_meta where thread_id = ?
  `).get(threadId);
  return `sqlite:${Number(row?.revision || 0)}:${String(row?.updated_at || "")}`;
}

export async function threadMessageStoreFingerprints(threadIds = [], env = process.env) {
  const db = await openDatabase(env);
  if (!db) return null;
  const ids = [...new Set((threadIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  for (const threadId of ids) await ensureMigrated(db, threadId, env);
  const selected = new Set(ids);
  const fingerprints = new Map();
  for (const row of db.prepare(`
    select thread_id, revision, updated_at from orkestr_thread_message_meta
  `).all()) {
    const threadId = String(row.thread_id || "");
    if (!selected.has(threadId)) continue;
    fingerprints.set(threadId, `sqlite:${Number(row.revision || 0)}:${String(row.updated_at || "")}`);
  }
  for (const threadId of ids) {
    if (!fingerprints.has(threadId)) fingerprints.set(threadId, "sqlite:0:");
  }
  return fingerprints;
}

export async function migrateThreadMessageStore(env = process.env) {
  const db = await openDatabase(env);
  if (!db) return { enabled: false, migrated: 0 };
  const paths = await ensureDataDirs(env);
  const entries = await fs.readdir(paths.threadMessages, { withFileTypes: true }).catch(() => []);
  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const threadId = path.basename(entry.name, ".json");
    await ensureMigrated(db, threadId, env);
    migrated += 1;
  }
  return { enabled: true, migrated };
}

export async function closeThreadMessageRegistryCache() {
  migratedThreads.clear();
  for (const [dbPath, db] of dbCache.entries()) {
    dbCache.delete(dbPath);
    try {
      db.close();
    } catch {
      // Best-effort cleanup for one-shot tests and CLI processes.
    }
  }
}
