import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  clearConnectorOutboxPostgresCache,
  connectorOutboxWherePostgres,
  getConnectorOutboxJobRowPostgres,
  openConnectorOutboxPostgres,
  pruneConnectorOutboxRowsPostgres,
  replaceConnectorOutboxRowsPostgres,
  setConnectorOutboxMetaPostgres,
  setConnectorOutboxPostgresPoolFactory,
  upsertConnectorOutboxJobRowPostgres,
  withPostgresTransaction,
} from "./connector-outbox-postgres.js";

export const terminalStates = new Set(["delivered", "skipped", "skipped_policy", "suppressed", "dead_letter", "cancelled", "delivery_uncertain"]);
const operatorActions = new Set(["retry", "suppress", "mark_delivered", "mark-delivered", "replay", "dead_letter", "dead-letter"]);
const dbCache = new Map();
let sqliteModulePromise = null;

export const __connectorOutboxTestInternals = {
  setPostgresPoolFactory(factory = null) {
    setConnectorOutboxPostgresPoolFactory(factory);
  },
  clearCaches() {
    dbCache.clear();
    clearConnectorOutboxPostgresCache();
  },
};

export function clean(value) {
  return String(value || "").trim();
}

export function nowIso() {
  return new Date().toISOString();
}

function dateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function outboxPath(env = process.env) {
  return dataPaths(env).connectorOutbox;
}

function outboxDbPath(env = process.env) {
  return dataPaths(env).connectorOutboxDb;
}

function connectorOutboxStoreMode(env = process.env) {
  return clean(env.ORKESTR_CONNECTOR_OUTBOX_STORE || env.ORKESTR_CONNECTOR_OUTBOX_BACKEND || "auto").toLowerCase();
}

export function connectorOutboxPostgresMode(env = process.env) {
  const mode = connectorOutboxStoreMode(env);
  return mode === "postgres" || mode === "postgresql";
}

function statusRank(value) {
  const status = clean(value || "pending").toLowerCase();
  if (status === "delivered") return 6;
  if (status === "dead_letter" || status === "suppressed" || status === "skipped" || status === "skipped_policy" || status === "cancelled" || status === "delivery_uncertain") return 5;
  if (status === "claimed" || status === "sent_to_broker") return 4;
  if (status === "failed_retryable") return 3;
  if (status === "pending") return 2;
  return 1;
}

export function connectorOutboxTerminalState(value = "") {
  return terminalStates.has(clean(value || "pending").toLowerCase());
}

export function normalizeConnectorOutboxAction(action = "") {
  const normalized = clean(action).toLowerCase().replace(/-/g, "_");
  return operatorActions.has(normalized) ? normalized : "";
}

export function connectorOutboxClaimTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS || env.ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.floor(parsed)) : 120_000;
}

export function connectorOutboxRetryBackoffMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS || env.ORKESTR_WHATSAPP_OUTBOX_RETRY_BACKOFF_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 30_000;
}

export function connectorOutboxRetentionLimit(env = process.env) {
  const raw = clean(env.ORKESTR_CONNECTOR_OUTBOX_RETENTION || env.ORKESTR_WHATSAPP_CONNECTOR_OUTBOX_RETENTION || "");
  const parsed = Number(raw || 10_000);
  const minimum = raw ? 1 : 1_000;
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : 10_000;
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

async function openConnectorOutboxDatabase(env = process.env) {
  const mode = connectorOutboxStoreMode(env);
  if (mode === "json") return null;
  if (connectorOutboxPostgresMode(env)) return null;
  const sqlite = await loadSqlite(mode);
  if (!sqlite) return null;
  const paths = await ensureDataDirs(env);
  if (dbCache.has(paths.connectorOutboxDb)) return dbCache.get(paths.connectorOutboxDb);
  const existed = await fs.stat(paths.connectorOutboxDb).then((stat) => stat.size > 0, () => false);
  const db = new sqlite.DatabaseSync(paths.connectorOutboxDb);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma busy_timeout = 5000");
  ensureConnectorOutboxSchema(db);
  dbCache.set(paths.connectorOutboxDb, db);
  await migrateJsonConnectorOutboxIfNeeded(db, paths, existed, env);
  return db;
}

function ensureConnectorOutboxSchema(db) {
  db.exec(`
    create table if not exists orkestr_connector_outbox (
      id text primary key,
      idempotency_key text not null unique,
      tenant_id text,
      owner_user_id text,
      connector text,
      account_id text,
      chat_id text,
      thread_id text,
      source_message_id text,
      source_revision text,
      delivery_type text,
      state text,
      claim_expires_at text,
      created_at text,
      updated_at text,
      terminal_at text,
      data text not null
    );
    create index if not exists idx_connector_outbox_state_updated on orkestr_connector_outbox(state, updated_at);
    create index if not exists idx_connector_outbox_connector_state_updated on orkestr_connector_outbox(connector, state, updated_at);
    create index if not exists idx_connector_outbox_owner_state_updated on orkestr_connector_outbox(owner_user_id, state, updated_at);
    create index if not exists idx_connector_outbox_chat_state_updated on orkestr_connector_outbox(chat_id, state, updated_at);
    create index if not exists idx_connector_outbox_thread_state_updated on orkestr_connector_outbox(thread_id, state, updated_at);
    create index if not exists idx_connector_outbox_source_message on orkestr_connector_outbox(source_message_id);
    create table if not exists orkestr_connector_outbox_meta (
      key text primary key,
      value text not null
    );
  `);
}

async function migrateJsonConnectorOutboxIfNeeded(db, paths, existed, env = process.env) {
  const migrated = db.prepare("select value from orkestr_connector_outbox_meta where key = ?").get("json_migrated_at");
  const count = Number(db.prepare("select count(*) as count from orkestr_connector_outbox").get().count || 0);
  if (migrated || (existed && count > 0)) return;
  const payload = await readJson(paths.connectorOutbox, { schemaVersion: 1, jobs: [] });
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  if (jobs.length) replaceConnectorOutboxRows(db, mergeConnectorOutboxJobs(jobs, [], env), env);
  setConnectorOutboxMeta(db, "json_migrated_at", nowIso());
}

function setConnectorOutboxMeta(db, key, value) {
  db.prepare(`
    insert into orkestr_connector_outbox_meta(key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(key, value);
}

export function rowToConnectorOutboxJob(row, env = process.env) {
  try {
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    return normalizeConnectorOutboxJob(data, env);
  } catch {
    return normalizeConnectorOutboxJob({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      tenantId: row.tenant_id,
      ownerUserId: row.owner_user_id,
      connector: row.connector,
      accountId: row.account_id,
      chatId: row.chat_id,
      threadId: row.thread_id,
      sourceMessageId: row.source_message_id,
      sourceRevision: row.source_revision,
      deliveryType: row.delivery_type,
      state: row.state,
      claimExpiresAt: row.claim_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    }, env);
  }
}

export function jobColumns(job) {
  return [
    job.id,
    job.idempotencyKey,
    job.tenantId,
    job.ownerUserId,
    job.connector,
    job.accountId,
    job.chatId,
    job.threadId,
    job.sourceMessageId,
    job.sourceRevision,
    job.deliveryType,
    job.state,
    job.claimExpiresAt,
    job.createdAt,
    job.updatedAt,
    job.terminalAt,
    JSON.stringify(job),
  ];
}

function upsertConnectorOutboxJobRow(db, job) {
  db.prepare(`
    insert into orkestr_connector_outbox(
      id, idempotency_key, tenant_id, owner_user_id, connector, account_id,
      chat_id, thread_id, source_message_id, source_revision, delivery_type,
      state, claim_expires_at, created_at, updated_at, terminal_at, data
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(idempotency_key) do update set
      id = excluded.id,
      tenant_id = excluded.tenant_id,
      owner_user_id = excluded.owner_user_id,
      connector = excluded.connector,
      account_id = excluded.account_id,
      chat_id = excluded.chat_id,
      thread_id = excluded.thread_id,
      source_message_id = excluded.source_message_id,
      source_revision = excluded.source_revision,
      delivery_type = excluded.delivery_type,
      state = excluded.state,
      claim_expires_at = excluded.claim_expires_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      terminal_at = excluded.terminal_at,
      data = excluded.data
  `).run(...jobColumns(job));
}

function replaceConnectorOutboxRows(db, jobs = [], env = process.env) {
  db.exec("begin immediate");
  try {
    db.exec("delete from orkestr_connector_outbox");
    for (const job of mergeConnectorOutboxJobs(jobs, [], env)) upsertConnectorOutboxJobRow(db, job);
    pruneConnectorOutboxRows(db, env);
    setConnectorOutboxMeta(db, "updated_at", nowIso());
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function terminalStateSqlPlaceholders() {
  return [...terminalStates].map(() => "?").join(", ");
}

function pruneConnectorOutboxRows(db, env = process.env) {
  const limit = connectorOutboxRetentionLimit(env);
  const states = [...terminalStates];
  const rows = db.prepare(`
    select id from orkestr_connector_outbox
    where state in (${terminalStateSqlPlaceholders()})
    order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
    limit -1 offset ?
  `).all(...states, limit);
  if (!rows.length) return 0;
  const remove = db.prepare("delete from orkestr_connector_outbox where id = ?");
  for (const row of rows) remove.run(row.id);
  return rows.length;
}

function connectorOutboxWhere(filters = {}) {
  const clauses = [];
  const values = [];
  const add = (column, value) => {
    const text = clean(value);
    if (!text) return;
    clauses.push(`${column} = ?`);
    values.push(text);
  };
  add("connector", filters.connector);
  add("tenant_id", filters.tenantId);
  add("owner_user_id", filters.ownerUserId || filters.userId);
  add("account_id", filters.accountId);
  add("chat_id", filters.chatId);
  add("thread_id", filters.threadId || filters.thread);
  add("delivery_type", filters.deliveryType);
  const states = clean(filters.state).toLowerCase().split(/[\s,]+/g).map(clean).filter(Boolean);
  if (states.length) {
    clauses.push(`state in (${states.map(() => "?").join(", ")})`);
    values.push(...states);
  }
  return {
    sql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    values,
  };
}

function getConnectorOutboxJobRow(db, jobIdOrKey = "", env = process.env) {
  const target = clean(jobIdOrKey);
  if (!target) return null;
  const row = db.prepare("select data from orkestr_connector_outbox where id = ? or idempotency_key = ? limit 1").get(target, target);
  return row ? rowToConnectorOutboxJob(row, env) : null;
}

export function connectorOutboxPayloadHash(payload = {}) {
  return hash(stableStringify(payload));
}

export function connectorOutboxIdempotencyKey(input = {}) {
  return [
    clean(input.tenantId || input.ownerUserId || "admin"),
    clean(input.connector),
    clean(input.accountId),
    clean(input.chatId),
    clean(input.threadId),
    clean(input.sourceMessageId),
    clean(input.sourceRevision || "1"),
    clean(input.deliveryType),
  ].join("|");
}

export function connectorOutboxJobId(input = {}) {
  return `co_${hash(clean(input.idempotencyKey) || connectorOutboxIdempotencyKey(input)).slice(0, 32)}`;
}

export function normalizeConnectorOutboxJob(input = {}, env = process.env) {
  const now = nowIso();
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const payloadHash = clean(input.payloadHash) || connectorOutboxPayloadHash(payload);
  const idempotencyKey = clean(input.idempotencyKey) || connectorOutboxIdempotencyKey({ ...input, payloadHash, payload });
  const state = clean(input.state || "pending").toLowerCase() || "pending";
  return {
    id: clean(input.id) || connectorOutboxJobId({ ...input, idempotencyKey }),
    tenantId: clean(input.tenantId || input.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin"),
    ownerUserId: clean(input.ownerUserId || input.tenantId || env.ORKESTR_ADMIN_USER_ID || "admin"),
    connector: clean(input.connector).toLowerCase(),
    accountId: clean(input.accountId),
    chatId: clean(input.chatId),
    threadId: clean(input.threadId),
    agentId: clean(input.agentId),
    sourceEventId: clean(input.sourceEventId || input.sourceMessageId),
    sourceMessageId: clean(input.sourceMessageId),
    sourceRevision: clean(input.sourceRevision || "1"),
    deliveryType: clean(input.deliveryType),
    payload,
    payloadHash,
    idempotencyKey,
    state,
    attemptCount: Math.max(0, Math.floor(Number(input.attemptCount || 0) || 0)),
    claimedBy: clean(input.claimedBy),
    claimedAt: clean(input.claimedAt),
    claimExpiresAt: clean(input.claimExpiresAt),
    createdAt: clean(input.createdAt) || now,
    updatedAt: clean(input.updatedAt) || now,
    terminalAt: connectorOutboxTerminalState(state) ? clean(input.terminalAt) || now : clean(input.terminalAt),
    deliveredAt: clean(input.deliveredAt),
    failedAt: clean(input.failedAt),
    skippedAt: clean(input.skippedAt),
    error: clean(input.error).slice(0, 1000),
    brokerAck: input.brokerAck && typeof input.brokerAck === "object" && !Array.isArray(input.brokerAck) ? input.brokerAck : null,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

function mergeJob(existing = {}, next = {}) {
  const existingRank = statusRank(existing.state);
  const nextRank = statusRank(next.state);
  if (existingRank > nextRank && connectorOutboxTerminalState(existing.state)) return existing;
  if (nextRank > existingRank) return { ...existing, ...next };
  if (existingRank > nextRank) return { ...next, ...existing };
  const existingUpdated = dateMs(existing.updatedAt || existing.terminalAt || existing.createdAt);
  const nextUpdated = dateMs(next.updatedAt || next.terminalAt || next.createdAt);
  return nextUpdated >= existingUpdated ? { ...existing, ...next } : { ...next, ...existing };
}

export function mergeConnectorOutboxJobs(existing = [], next = [], env = process.env) {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const normalized = normalizeConnectorOutboxJob(item, env);
    if (!normalized.idempotencyKey) continue;
    const key = normalized.idempotencyKey;
    merged.set(key, merged.has(key) ? mergeJob(merged.get(key), normalized) : normalized);
  }
  return pruneConnectorOutboxJobs([...merged.values()], env);
}

export function pruneConnectorOutboxJobs(jobs = [], env = process.env) {
  const sorted = [...(jobs || [])].sort((left, right) => dateMs(left.createdAt) - dateMs(right.createdAt));
  const active = sorted.filter((job) => !connectorOutboxTerminalState(job.state));
  const terminal = sorted.filter((job) => connectorOutboxTerminalState(job.state));
  const retainedTerminal = terminal
    .sort((left, right) =>
      dateMs(left.updatedAt || left.terminalAt || left.createdAt) - dateMs(right.updatedAt || right.terminalAt || right.createdAt)
    )
    .slice(-connectorOutboxRetentionLimit(env));
  const retained = new Set([...active, ...retainedTerminal].map((job) => job.idempotencyKey));
  return sorted.filter((job) => retained.has(job.idempotencyKey));
}

export async function readConnectorOutbox(env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const rows = await pg.query("select data from orkestr_connector_outbox order by created_at asc, id asc");
    return {
      schemaVersion: 1,
      jobs: rows.rows.map((row) => rowToConnectorOutboxJob(row, env)),
      backend: "postgres",
    };
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const rows = db
      .prepare("select data from orkestr_connector_outbox order by created_at asc, id asc")
      .all();
    return {
      schemaVersion: 1,
      jobs: rows.map((row) => rowToConnectorOutboxJob(row, env)),
      backend: "sqlite",
    };
  }
  await ensureDataDirs(env);
  const payload = await readJson(outboxPath(env), { schemaVersion: 1, jobs: [] });
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  return {
    schemaVersion: 1,
    jobs: mergeConnectorOutboxJobs(jobs, [], env),
  };
}

function filterValueMatches(actual = "", expected = "") {
  const needle = clean(expected).toLowerCase();
  if (!needle) return true;
  return clean(actual).toLowerCase() === needle;
}

function stateFilterMatches(actual = "", expected = "") {
  const raw = clean(expected).toLowerCase();
  if (!raw) return true;
  const states = raw.split(/[\s,]+/g).map(clean).filter(Boolean);
  return !states.length || states.includes(clean(actual || "pending").toLowerCase());
}

export async function listConnectorOutboxJobs(filters = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const limit = Math.max(0, Math.floor(Number(filters.limit || 0) || 0));
    const where = connectorOutboxWherePostgres(filters);
    const totalResult = await pg.query(`select count(*)::int as count from orkestr_connector_outbox ${where.sql}`, where.values);
    const rows = limit
      ? await pg.query(`
          select data from orkestr_connector_outbox
          ${where.sql}
          order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
          limit $${where.values.length + 1}
        `, [...where.values, limit])
      : await pg.query(`
          select data from orkestr_connector_outbox
          ${where.sql}
          order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
        `, where.values);
    const jobs = rows.rows.map((row) => rowToConnectorOutboxJob(row, env));
    return {
      schemaVersion: 1,
      jobs,
      count: jobs.length,
      total: Number(totalResult.rows[0]?.count || 0),
      backend: "postgres",
      filters: {
        connector: clean(filters.connector),
        state: clean(filters.state),
        tenantId: clean(filters.tenantId),
        ownerUserId: clean(filters.ownerUserId || filters.userId),
        accountId: clean(filters.accountId),
        chatId: clean(filters.chatId),
        threadId: clean(filters.threadId || filters.thread),
        deliveryType: clean(filters.deliveryType),
        limit,
      },
      generatedAt: nowIso(),
    };
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const limit = Math.max(0, Math.floor(Number(filters.limit || 0) || 0));
    const where = connectorOutboxWhere(filters);
    const total = Number(db.prepare(`select count(*) as count from orkestr_connector_outbox ${where.sql}`).get(...where.values).count || 0);
    const rows = limit
      ? db.prepare(`
          select data from orkestr_connector_outbox
          ${where.sql}
          order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
          limit ?
        `).all(...where.values, limit)
      : db.prepare(`
          select data from orkestr_connector_outbox
          ${where.sql}
          order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
        `).all(...where.values);
    const jobs = rows.map((row) => rowToConnectorOutboxJob(row, env));
    return {
      schemaVersion: 1,
      jobs,
      count: jobs.length,
      total,
      backend: "sqlite",
      filters: {
        connector: clean(filters.connector),
        state: clean(filters.state),
        tenantId: clean(filters.tenantId),
        ownerUserId: clean(filters.ownerUserId || filters.userId),
        accountId: clean(filters.accountId),
        chatId: clean(filters.chatId),
        threadId: clean(filters.threadId || filters.thread),
        deliveryType: clean(filters.deliveryType),
        limit,
      },
      generatedAt: nowIso(),
    };
  }
  const store = await readConnectorOutbox(env);
  const limit = Math.max(0, Math.floor(Number(filters.limit || 0) || 0));
  const jobs = store.jobs
    .filter((job) => filterValueMatches(job.connector, filters.connector))
    .filter((job) => stateFilterMatches(job.state, filters.state))
    .filter((job) => filterValueMatches(job.tenantId, filters.tenantId))
    .filter((job) => filterValueMatches(job.ownerUserId, filters.ownerUserId || filters.userId))
    .filter((job) => filterValueMatches(job.accountId, filters.accountId))
    .filter((job) => filterValueMatches(job.chatId, filters.chatId))
    .filter((job) => filterValueMatches(job.threadId, filters.threadId || filters.thread))
    .filter((job) => filterValueMatches(job.deliveryType, filters.deliveryType))
    .sort((left, right) => dateMs(right.updatedAt || right.terminalAt || right.createdAt) - dateMs(left.updatedAt || left.terminalAt || left.createdAt));
  const visible = limit ? jobs.slice(0, limit) : jobs;
  return {
    schemaVersion: store.schemaVersion,
    jobs: visible,
    count: visible.length,
    total: jobs.length,
    filters: {
      connector: clean(filters.connector),
      state: clean(filters.state),
      tenantId: clean(filters.tenantId),
      ownerUserId: clean(filters.ownerUserId || filters.userId),
      accountId: clean(filters.accountId),
      chatId: clean(filters.chatId),
      threadId: clean(filters.threadId || filters.thread),
      deliveryType: clean(filters.deliveryType),
      limit,
    },
    generatedAt: nowIso(),
  };
}

export async function writeConnectorOutbox(store = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const jobs = mergeConnectorOutboxJobs(store.jobs || [], [], env);
    await replaceConnectorOutboxRowsPostgres(pg, jobs, env);
    return { schemaVersion: 1, jobs, backend: "postgres", updatedAt: nowIso() };
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const jobs = mergeConnectorOutboxJobs(store.jobs || [], [], env);
    replaceConnectorOutboxRows(db, jobs, env);
    return { schemaVersion: 1, jobs, backend: "sqlite", updatedAt: nowIso() };
  }
  await ensureDataDirs(env);
  return writeJson(outboxPath(env), {
    schemaVersion: 1,
    jobs: mergeConnectorOutboxJobs(store.jobs || [], [], env),
    updatedAt: nowIso(),
  });
}

export async function ensureConnectorOutboxJob(input = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const job = normalizeConnectorOutboxJob(input, env);
    let created = false;
    const nextJob = await withPostgresTransaction(pg, async (client) => {
      const existing = await getConnectorOutboxJobRowPostgres(client, job.idempotencyKey, env, { forUpdate: true });
      const merged = existing ? mergeJob(existing, job) : job;
      await upsertConnectorOutboxJobRowPostgres(client, merged);
      await pruneConnectorOutboxRowsPostgres(client, env);
      await setConnectorOutboxMetaPostgres(client, "updated_at", nowIso());
      created = !existing;
      return merged;
    });
    if (created) {
      await appendEvent({
        type: "connector_outbox_job_created",
        outboxJobId: job.id,
        tenantId: job.tenantId,
        connector: job.connector,
        accountId: job.accountId,
        chatId: job.chatId,
        threadId: job.threadId,
        sourceMessageId: job.sourceMessageId,
        deliveryType: job.deliveryType,
      }, env).catch(() => {});
    }
    return { job: nextJob, created };
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const job = normalizeConnectorOutboxJob(input, env);
    const existing = getConnectorOutboxJobRow(db, job.idempotencyKey, env);
    const nextJob = existing ? mergeJob(existing, job) : job;
    db.exec("begin immediate");
    try {
      upsertConnectorOutboxJobRow(db, nextJob);
      pruneConnectorOutboxRows(db, env);
      setConnectorOutboxMeta(db, "updated_at", nowIso());
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    if (!existing) {
      await appendEvent({
        type: "connector_outbox_job_created",
        outboxJobId: job.id,
        tenantId: job.tenantId,
        connector: job.connector,
        accountId: job.accountId,
        chatId: job.chatId,
        threadId: job.threadId,
        sourceMessageId: job.sourceMessageId,
        deliveryType: job.deliveryType,
      }, env).catch(() => {});
    }
    return { job: nextJob, created: !existing };
  }
  const store = await readConnectorOutbox(env);
  const job = normalizeConnectorOutboxJob(input, env);
  const existing = store.jobs.find((item) => item.idempotencyKey === job.idempotencyKey) || null;
  const nextJob = existing ? mergeJob(existing, job) : job;
  store.jobs = mergeConnectorOutboxJobs(store.jobs, [nextJob], env);
  await writeConnectorOutbox(store, env);
  if (!existing) {
    await appendEvent({
      type: "connector_outbox_job_created",
      outboxJobId: job.id,
      tenantId: job.tenantId,
      connector: job.connector,
      accountId: job.accountId,
      chatId: job.chatId,
      threadId: job.threadId,
      sourceMessageId: job.sourceMessageId,
      deliveryType: job.deliveryType,
    }, env).catch(() => {});
  }
  return { job: nextJob, created: !existing };
}

function claimExpired(job = {}, nowMs = Date.now()) {
  if (clean(job.state).toLowerCase() === "failed_retryable") {
    const retryAtMs = dateMs(job.claimExpiresAt);
    if (retryAtMs && retryAtMs > nowMs) return false;
  }
  if (clean(job.state).toLowerCase() !== "claimed" && clean(job.state).toLowerCase() !== "sent_to_broker") return true;
  const expiresAtMs = dateMs(job.claimExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export async function claimConnectorOutboxJob(jobIdOrKey = "", { claimant = "" } = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const result = await withPostgresTransaction(pg, async (client) => {
      const job = await getConnectorOutboxJobRowPostgres(client, jobIdOrKey, env, { forUpdate: true });
      if (!job) return { acquired: false, reason: "connector_outbox_job_missing" };
      if (connectorOutboxTerminalState(job.state)) {
        return { acquired: false, reason: `connector_outbox_${job.state}`, terminal: true, job };
      }
      if (!claimExpired(job, nowMs)) {
        const reason = clean(job.state).toLowerCase() === "failed_retryable"
          ? "connector_outbox_retry_scheduled"
          : "connector_outbox_claim_active";
        return { acquired: false, reason, job };
      }
      const claimed = normalizeConnectorOutboxJob({
        ...job,
        state: "claimed",
        claimedBy: clean(claimant) || `pid:${process.pid}`,
        claimedAt: now,
        claimExpiresAt: new Date(nowMs + connectorOutboxClaimTtlMs(env)).toISOString(),
        attemptCount: Number(job.attemptCount || 0) + 1,
        updatedAt: now,
      }, env);
      await upsertConnectorOutboxJobRowPostgres(client, claimed);
      await setConnectorOutboxMetaPostgres(client, "updated_at", now);
      return { acquired: true, job: claimed };
    });
    if (result.acquired) {
      await appendEvent({
        type: "connector_outbox_job_claimed",
        outboxJobId: result.job.id,
        tenantId: result.job.tenantId,
        connector: result.job.connector,
        chatId: result.job.chatId,
        threadId: result.job.threadId,
        sourceMessageId: result.job.sourceMessageId,
        deliveryType: result.job.deliveryType,
        claimedBy: result.job.claimedBy,
      }, env).catch(() => {});
    }
    return result;
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const job = getConnectorOutboxJobRow(db, jobIdOrKey, env);
    if (!job) return { acquired: false, reason: "connector_outbox_job_missing" };
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    if (connectorOutboxTerminalState(job.state)) {
      return { acquired: false, reason: `connector_outbox_${job.state}`, terminal: true, job };
    }
    if (!claimExpired(job, nowMs)) {
      const reason = clean(job.state).toLowerCase() === "failed_retryable"
        ? "connector_outbox_retry_scheduled"
        : "connector_outbox_claim_active";
      return { acquired: false, reason, job };
    }
    const claimed = normalizeConnectorOutboxJob({
      ...job,
      state: "claimed",
      claimedBy: clean(claimant) || `pid:${process.pid}`,
      claimedAt: now,
      claimExpiresAt: new Date(nowMs + connectorOutboxClaimTtlMs(env)).toISOString(),
      attemptCount: Number(job.attemptCount || 0) + 1,
      updatedAt: now,
    }, env);
    db.exec("begin immediate");
    try {
      upsertConnectorOutboxJobRow(db, claimed);
      setConnectorOutboxMeta(db, "updated_at", now);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    await appendEvent({
      type: "connector_outbox_job_claimed",
      outboxJobId: claimed.id,
      tenantId: claimed.tenantId,
      connector: claimed.connector,
      chatId: claimed.chatId,
      threadId: claimed.threadId,
      sourceMessageId: claimed.sourceMessageId,
      deliveryType: claimed.deliveryType,
      claimedBy: claimed.claimedBy,
    }, env).catch(() => {});
    return { acquired: true, job: claimed };
  }
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const ttlMs = connectorOutboxClaimTtlMs(env);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return { acquired: false, reason: "connector_outbox_job_missing" };
  const job = store.jobs[index];
  if (connectorOutboxTerminalState(job.state)) {
    return { acquired: false, reason: `connector_outbox_${job.state}`, terminal: true, job };
  }
  if (!claimExpired(job, nowMs)) {
    const reason = clean(job.state).toLowerCase() === "failed_retryable"
      ? "connector_outbox_retry_scheduled"
      : "connector_outbox_claim_active";
    return { acquired: false, reason, job };
  }
  const claimed = normalizeConnectorOutboxJob({
    ...job,
    state: "claimed",
    claimedBy: clean(claimant) || `pid:${process.pid}`,
    claimedAt: now,
    claimExpiresAt: new Date(nowMs + ttlMs).toISOString(),
    attemptCount: Number(job.attemptCount || 0) + 1,
    updatedAt: now,
  }, env);
  store.jobs.splice(index, 1, claimed);
  await writeConnectorOutbox(store, env);
  await appendEvent({
    type: "connector_outbox_job_claimed",
    outboxJobId: claimed.id,
    tenantId: claimed.tenantId,
    connector: claimed.connector,
    chatId: claimed.chatId,
    threadId: claimed.threadId,
    sourceMessageId: claimed.sourceMessageId,
    deliveryType: claimed.deliveryType,
    claimedBy: claimed.claimedBy,
  }, env).catch(() => {});
  return { acquired: true, job: claimed };
}

export async function releaseConnectorOutboxClaim(jobIdOrKey = "", { reason = "" } = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    return withPostgresTransaction(pg, async (client) => {
      const job = await getConnectorOutboxJobRowPostgres(client, jobIdOrKey, env, { forUpdate: true });
      if (!job) return null;
      if (connectorOutboxTerminalState(job.state)) return job;
      const released = normalizeConnectorOutboxJob({
        ...job,
        state: "pending",
        claimedBy: "",
        claimedAt: "",
        claimExpiresAt: "",
        error: clean(reason || job.error),
        updatedAt: nowIso(),
      }, env);
      await upsertConnectorOutboxJobRowPostgres(client, released);
      await setConnectorOutboxMetaPostgres(client, "updated_at", released.updatedAt);
      return released;
    });
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const job = getConnectorOutboxJobRow(db, jobIdOrKey, env);
    if (!job) return null;
    if (connectorOutboxTerminalState(job.state)) return job;
    const released = normalizeConnectorOutboxJob({
      ...job,
      state: "pending",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      error: clean(reason || job.error),
      updatedAt: nowIso(),
    }, env);
    db.exec("begin immediate");
    try {
      upsertConnectorOutboxJobRow(db, released);
      setConnectorOutboxMeta(db, "updated_at", released.updatedAt);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    return released;
  }
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return null;
  const job = store.jobs[index];
  if (connectorOutboxTerminalState(job.state)) return job;
  const released = normalizeConnectorOutboxJob({
    ...job,
    state: "pending",
    claimedBy: "",
    claimedAt: "",
    claimExpiresAt: "",
    error: clean(reason || job.error),
    updatedAt: nowIso(),
  }, env);
  store.jobs.splice(index, 1, released);
  await writeConnectorOutbox(store, env);
  return released;
}

export async function markConnectorOutboxJob(jobIdOrKey = "", patch = {}, env = process.env) {
  const pg = await openConnectorOutboxPostgres(env);
  if (pg) {
    const updated = await withPostgresTransaction(pg, async (client) => {
      const current = await getConnectorOutboxJobRowPostgres(client, jobIdOrKey, env, { forUpdate: true });
      if (!current) return null;
      const state = clean(patch.state || current.state || "pending").toLowerCase();
      const next = normalizeConnectorOutboxJob({
        ...current,
        ...patch,
        state,
        claimedBy: connectorOutboxTerminalState(state) ? "" : patch.claimedBy ?? current.claimedBy,
        claimedAt: connectorOutboxTerminalState(state) ? "" : patch.claimedAt ?? current.claimedAt,
        claimExpiresAt: connectorOutboxTerminalState(state) ? "" : patch.claimExpiresAt ?? current.claimExpiresAt,
        terminalAt: connectorOutboxTerminalState(state) ? clean(patch.terminalAt) || nowIso() : clean(patch.terminalAt),
        updatedAt: nowIso(),
      }, env);
      await upsertConnectorOutboxJobRowPostgres(client, next);
      await pruneConnectorOutboxRowsPostgres(client, env);
      await setConnectorOutboxMetaPostgres(client, "updated_at", next.updatedAt);
      return next;
    });
    if (updated) {
      await appendEvent({
        type: "connector_outbox_job_updated",
        outboxJobId: updated.id,
        tenantId: updated.tenantId,
        connector: updated.connector,
        chatId: updated.chatId,
        threadId: updated.threadId,
        sourceMessageId: updated.sourceMessageId,
        deliveryType: updated.deliveryType,
        state: updated.state,
      }, env).catch(() => {});
    }
    return updated;
  }
  const db = await openConnectorOutboxDatabase(env);
  if (db) {
    const current = getConnectorOutboxJobRow(db, jobIdOrKey, env);
    if (!current) return null;
    const state = clean(patch.state || current.state || "pending").toLowerCase();
    const updated = normalizeConnectorOutboxJob({
      ...current,
      ...patch,
      state,
      claimedBy: connectorOutboxTerminalState(state) ? "" : patch.claimedBy ?? current.claimedBy,
      claimedAt: connectorOutboxTerminalState(state) ? "" : patch.claimedAt ?? current.claimedAt,
      claimExpiresAt: connectorOutboxTerminalState(state) ? "" : patch.claimExpiresAt ?? current.claimExpiresAt,
      terminalAt: connectorOutboxTerminalState(state) ? clean(patch.terminalAt) || nowIso() : clean(patch.terminalAt),
      updatedAt: nowIso(),
    }, env);
    db.exec("begin immediate");
    try {
      upsertConnectorOutboxJobRow(db, updated);
      pruneConnectorOutboxRows(db, env);
      setConnectorOutboxMeta(db, "updated_at", updated.updatedAt);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    await appendEvent({
      type: "connector_outbox_job_updated",
      outboxJobId: updated.id,
      tenantId: updated.tenantId,
      connector: updated.connector,
      chatId: updated.chatId,
      threadId: updated.threadId,
      sourceMessageId: updated.sourceMessageId,
      deliveryType: updated.deliveryType,
      state: updated.state,
    }, env).catch(() => {});
    return updated;
  }
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return null;
  const state = clean(patch.state || store.jobs[index].state || "pending").toLowerCase();
  const updated = normalizeConnectorOutboxJob({
    ...store.jobs[index],
    ...patch,
    state,
    claimedBy: connectorOutboxTerminalState(state) ? "" : patch.claimedBy ?? store.jobs[index].claimedBy,
    claimedAt: connectorOutboxTerminalState(state) ? "" : patch.claimedAt ?? store.jobs[index].claimedAt,
    claimExpiresAt: connectorOutboxTerminalState(state) ? "" : patch.claimExpiresAt ?? store.jobs[index].claimExpiresAt,
    terminalAt: connectorOutboxTerminalState(state) ? clean(patch.terminalAt) || nowIso() : clean(patch.terminalAt),
    updatedAt: nowIso(),
  }, env);
  store.jobs.splice(index, 1, updated);
  await writeConnectorOutbox(store, env);
  await appendEvent({
    type: "connector_outbox_job_updated",
    outboxJobId: updated.id,
    tenantId: updated.tenantId,
    connector: updated.connector,
    chatId: updated.chatId,
    threadId: updated.threadId,
    sourceMessageId: updated.sourceMessageId,
    deliveryType: updated.deliveryType,
    state: updated.state,
  }, env).catch(() => {});
  return updated;
}

function operatorPatchForAction(job = {}, action = "", options = {}) {
  const normalized = normalizeConnectorOutboxAction(action);
  const now = nowIso();
  const reason = clean(options.reason || options.error);
  const operator = clean(options.operator || options.operatorId || "operator");
  if (normalized === "retry" || normalized === "replay") {
    return {
      state: "pending",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      deliveredAt: "",
      failedAt: "",
      skippedAt: "",
      terminalAt: "",
      error: "",
      metadata: {
        ...(job.metadata || {}),
        ...(normalized === "replay" ? { replayCount: Number(job.metadata?.replayCount || 0) + 1 } : {}),
        [`${normalized}RequestedAt`]: now,
        [`${normalized}RequestedBy`]: operator,
        [`${normalized}FromState`]: clean(job.state || "pending"),
        ...(reason ? { [`${normalized}Reason`]: reason } : {}),
      },
    };
  }
  if (normalized === "suppress") {
    return {
      state: "suppressed",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      skippedAt: now,
      terminalAt: now,
      error: reason || "operator_suppressed",
      metadata: {
        ...(job.metadata || {}),
        suppressedBy: operator,
        suppressedAt: now,
      },
    };
  }
  if (normalized === "dead_letter") {
    return {
      state: "dead_letter",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      failedAt: clean(job.failedAt) || now,
      terminalAt: now,
      error: reason || clean(job.error) || "operator_dead_letter",
      metadata: {
        ...(job.metadata || {}),
        deadLetteredBy: operator,
        deadLetteredAt: now,
      },
    };
  }
  if (normalized === "mark_delivered") {
    return {
      state: "delivered",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      deliveredAt: clean(options.deliveredAt) || now,
      terminalAt: now,
      error: "",
      brokerAck: options.brokerAck && typeof options.brokerAck === "object" && !Array.isArray(options.brokerAck)
        ? options.brokerAck
        : {
            operatorMarked: true,
            operator,
            ...(reason ? { reason } : {}),
            markedAt: now,
          },
      metadata: {
        ...(job.metadata || {}),
        markedDeliveredBy: operator,
        markedDeliveredAt: now,
      },
    };
  }
  return null;
}

export async function applyConnectorOutboxJobAction(jobIdOrKey = "", action = "", options = {}, env = process.env) {
  const normalized = normalizeConnectorOutboxAction(action);
  if (!normalized) {
    const error = new Error("connector_outbox_action_invalid");
    error.statusCode = 400;
    throw error;
  }
  const db = await openConnectorOutboxDatabase(env);
  const target = clean(jobIdOrKey);
  const current = db
    ? getConnectorOutboxJobRow(db, target, env)
    : (await readConnectorOutbox(env)).jobs.find((job) => job.id === target || job.idempotencyKey === target);
  if (!current) {
    const error = new Error("connector_outbox_job_missing");
    error.statusCode = 404;
    throw error;
  }
  const patch = operatorPatchForAction(current, normalized, options);
  const job = await markConnectorOutboxJob(current.id, patch, env);
  await appendEvent({
    type: "connector_outbox_operator_action",
    outboxJobId: current.id,
    tenantId: current.tenantId,
    connector: current.connector,
    chatId: current.chatId,
    threadId: current.threadId,
    sourceMessageId: current.sourceMessageId,
    deliveryType: current.deliveryType,
    action: normalized,
    previousState: current.state,
    state: job?.state || "",
    operator: clean(options.operator || options.operatorId || "operator"),
  }, env).catch(() => {});
  return {
    ok: true,
    action: normalized,
    previousState: current.state,
    job,
  };
}
