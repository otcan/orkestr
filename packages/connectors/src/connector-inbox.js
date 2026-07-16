import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databases = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function databasePath(env = process.env) {
  const home = clean(env.ORKESTR_HOME);
  if (!home) throw Object.assign(new Error("orkestr_home_required"), { statusCode: 503 });
  return path.resolve(clean(env.ORKESTR_CONNECTOR_INBOX_DB) || path.join(home, "data", "connector-inbox.sqlite"));
}

async function database(env = process.env) {
  const filePath = databasePath(env);
  if (databases.has(filePath)) return databases.get(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma busy_timeout = 5000");
  db.exec(`
    create table if not exists orkestr_connector_inbox (
      id text primary key,
      connector text not null,
      account_id text,
      conversation_id text,
      state text not null,
      attempt_count integer not null default 0,
      next_attempt_at text,
      error text,
      payload text not null,
      result text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_connector_inbox_state_next on orkestr_connector_inbox(state, next_attempt_at);
  `);
  databases.set(filePath, db);
  return db;
}

function row(record) {
  if (!record) return null;
  return {
    id: record.id,
    connector: record.connector,
    accountId: record.account_id || "",
    conversationId: record.conversation_id || "",
    state: record.state,
    attemptCount: Number(record.attempt_count || 0),
    nextAttemptAt: record.next_attempt_at || "",
    error: record.error || "",
    payload: JSON.parse(record.payload || "{}"),
    result: record.result ? JSON.parse(record.result) : null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function ensureConnectorInboxEvent(input = {}, env = process.env) {
  const id = clean(input.id || input.eventId || input.messageId);
  if (!id) throw Object.assign(new Error("connector_inbox_event_id_required"), { statusCode: 400 });
  const db = await database(env);
  const existing = row(db.prepare("select * from orkestr_connector_inbox where id = ?").get(id));
  if (existing) return { created: false, event: existing };
  const now = new Date().toISOString();
  db.prepare(`
    insert into orkestr_connector_inbox(id, connector, account_id, conversation_id, state, attempt_count, payload, created_at, updated_at)
    values (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    id,
    clean(input.connector || "whatsapp"),
    clean(input.accountId),
    clean(input.conversationId),
    JSON.stringify(input.payload || {}),
    now,
    now,
  );
  return { created: true, event: row(db.prepare("select * from orkestr_connector_inbox where id = ?").get(id)) };
}

export async function markConnectorInboxEvent(id = "", patch = {}, env = process.env) {
  const db = await database(env);
  const current = row(db.prepare("select * from orkestr_connector_inbox where id = ?").get(clean(id)));
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(`
    update orkestr_connector_inbox
    set state = ?, attempt_count = ?, next_attempt_at = ?, error = ?, result = ?, updated_at = ?
    where id = ?
  `).run(
    clean(next.state || current.state),
    Number(next.attemptCount || 0),
    clean(next.nextAttemptAt),
    clean(next.error).slice(0, 1000),
    next.result ? JSON.stringify(next.result) : null,
    next.updatedAt,
    current.id,
  );
  return row(db.prepare("select * from orkestr_connector_inbox where id = ?").get(current.id));
}

export async function listConnectorInboxEvents({ states = [], limit = 100 } = {}, env = process.env) {
  const db = await database(env);
  const wanted = (Array.isArray(states) ? states : [states]).map(clean).filter(Boolean);
  const capped = Math.max(1, Math.min(1000, Number(limit || 100) || 100));
  if (!wanted.length) return db.prepare("select * from orkestr_connector_inbox order by created_at desc limit ?").all(capped).map(row);
  const placeholders = wanted.map(() => "?").join(",");
  return db.prepare(`select * from orkestr_connector_inbox where state in (${placeholders}) order by created_at asc limit ?`).all(...wanted, capped).map(row);
}

export function resetConnectorInboxForTest() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
