import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";
import {
  clean,
  connectorOutboxPostgresMode,
  connectorOutboxRetentionLimit,
  jobColumns,
  mergeConnectorOutboxJobs,
  nowIso,
  rowToConnectorOutboxJob,
  terminalStates,
} from "./connector-outbox.js";

const pgPoolCache = new Map();
let pgModulePromise = null;
let postgresPoolFactoryForTest = null;

export function setConnectorOutboxPostgresPoolFactory(factory = null) {
  postgresPoolFactoryForTest = typeof factory === "function" ? factory : null;
  pgPoolCache.clear();
}

export function clearConnectorOutboxPostgresCache() {
  pgPoolCache.clear();
}

async function loadPg() {
  try {
    pgModulePromise ||= import("pg");
    const module = await pgModulePromise;
    return module.Pool ? module : module.default || module;
  } catch (error) {
    const wrapped = new Error("connector_outbox_postgres_driver_missing");
    wrapped.statusCode = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

function postgresConnectionConfig(env = process.env) {
  const connectionString = clean(
    env.ORKESTR_CONNECTOR_OUTBOX_POSTGRES_URL ||
    env.ORKESTR_CONNECTOR_OUTBOX_DATABASE_URL ||
    env.ORKESTR_POSTGRES_URL ||
    env.DATABASE_URL,
  );
  if (connectionString) return { connectionString };
  return {
    host: clean(env.ORKESTR_CONNECTOR_OUTBOX_PGHOST || env.PGHOST || "127.0.0.1"),
    port: Number(env.ORKESTR_CONNECTOR_OUTBOX_PGPORT || env.PGPORT || 5432) || 5432,
    database: clean(env.ORKESTR_CONNECTOR_OUTBOX_PGDATABASE || env.PGDATABASE || env.PGUSER || "orkestr"),
    user: clean(env.ORKESTR_CONNECTOR_OUTBOX_PGUSER || env.PGUSER || "orkestr"),
    password: env.ORKESTR_CONNECTOR_OUTBOX_PGPASSWORD ?? env.PGPASSWORD,
  };
}

function postgresPoolCacheKey(env = process.env) {
  const config = postgresConnectionConfig(env);
  return config.connectionString || JSON.stringify({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
  });
}

export async function openConnectorOutboxPostgres(env = process.env) {
  if (!connectorOutboxPostgresMode(env)) return null;
  const key = postgresPoolCacheKey(env);
  let pool = pgPoolCache.get(key);
  if (!pool) {
    if (postgresPoolFactoryForTest) {
      pool = await postgresPoolFactoryForTest(postgresConnectionConfig(env), env);
    } else {
      const pg = await loadPg();
      pool = new pg.Pool({
        ...postgresConnectionConfig(env),
        max: Math.max(1, Number(env.ORKESTR_CONNECTOR_OUTBOX_POSTGRES_POOL_SIZE || 5) || 5),
      });
    }
    pgPoolCache.set(key, pool);
  }
  pool.__orkestrConnectorOutboxReady ||= (async () => {
    await ensurePostgresConnectorOutboxSchema(pool);
    await migrateJsonConnectorOutboxToPostgresIfNeeded(pool, env);
  })();
  await pool.__orkestrConnectorOutboxReady;
  return pool;
}

async function ensurePostgresConnectorOutboxSchema(pool) {
  await pool.query(`
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
      data jsonb not null
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

async function migrateJsonConnectorOutboxToPostgresIfNeeded(pool, env = process.env) {
  const migrated = await pool.query("select value from orkestr_connector_outbox_meta where key = $1", ["json_migrated_at"]);
  const count = await pool.query("select count(*)::int as count from orkestr_connector_outbox");
  if (migrated.rows.length || Number(count.rows[0]?.count || 0) > 0) return;
  const paths = await ensureDataDirs(env);
  const payload = await readJson(paths.connectorOutbox, { schemaVersion: 1, jobs: [] });
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  if (jobs.length) await replaceConnectorOutboxRowsPostgres(pool, mergeConnectorOutboxJobs(jobs, [], env), env);
  await setConnectorOutboxMetaPostgres(pool, "json_migrated_at", nowIso());
}

export async function setConnectorOutboxMetaPostgres(client, key, value) {
  await client.query(`
    insert into orkestr_connector_outbox_meta(key, value)
    values ($1, $2)
    on conflict(key) do update set value = excluded.value
  `, [key, value]);
}

function pgPlaceholders(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => `$${index + offset + 1}`).join(", ");
}

export async function upsertConnectorOutboxJobRowPostgres(client, job) {
  await client.query(`
    insert into orkestr_connector_outbox(
      id, idempotency_key, tenant_id, owner_user_id, connector, account_id,
      chat_id, thread_id, source_message_id, source_revision, delivery_type,
      state, claim_expires_at, created_at, updated_at, terminal_at, data
    ) values (${pgPlaceholders(17)})
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
  `, jobColumns(job));
}

export async function withPostgresTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceConnectorOutboxRowsPostgres(pool, jobs = [], env = process.env) {
  return withPostgresTransaction(pool, async (client) => {
    await client.query("delete from orkestr_connector_outbox");
    for (const job of mergeConnectorOutboxJobs(jobs, [], env)) await upsertConnectorOutboxJobRowPostgres(client, job);
    await pruneConnectorOutboxRowsPostgres(client, env);
    await setConnectorOutboxMetaPostgres(client, "updated_at", nowIso());
  });
}

function terminalStatePgPlaceholders(offset = 0) {
  return pgPlaceholders(terminalStates.size, offset);
}

export async function pruneConnectorOutboxRowsPostgres(client, env = process.env) {
  const limit = connectorOutboxRetentionLimit(env);
  const states = [...terminalStates];
  const rows = await client.query(`
    select id from orkestr_connector_outbox
    where state in (${terminalStatePgPlaceholders()})
    order by coalesce(nullif(updated_at, ''), nullif(terminal_at, ''), nullif(created_at, '')) desc, id desc
    offset $${states.length + 1}
  `, [...states, limit]);
  if (!rows.rows.length) return 0;
  await client.query(
    `delete from orkestr_connector_outbox where id in (${pgPlaceholders(rows.rows.length)})`,
    rows.rows.map((row) => row.id),
  );
  return rows.rows.length;
}

export function connectorOutboxWherePostgres(filters = {}, offset = 0) {
  const clauses = [];
  const values = [];
  const add = (column, value) => {
    const text = clean(value);
    if (!text) return;
    values.push(text);
    clauses.push(`${column} = $${values.length + offset}`);
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
    const placeholders = states.map((_, index) => `$${values.length + index + offset + 1}`);
    clauses.push(`state in (${placeholders.join(", ")})`);
    values.push(...states);
  }
  return {
    sql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    values,
  };
}

export async function getConnectorOutboxJobRowPostgres(client, jobIdOrKey = "", env = process.env, { forUpdate = false } = {}) {
  const target = clean(jobIdOrKey);
  if (!target) return null;
  const row = await client.query(
    `select data from orkestr_connector_outbox where id = $1 or idempotency_key = $2 limit 1${forUpdate ? " for update" : ""}`,
    [target, target],
  );
  return row.rows[0] ? rowToConnectorOutboxJob(row.rows[0], env) : null;
}
