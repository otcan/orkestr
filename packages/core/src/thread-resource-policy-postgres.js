const pools = new Map();
let pgModulePromise = null;
let poolFactoryForTest = null;

const clean = (value = "") => String(value || "").trim();
const tables = Object.freeze({
  policies: "orkestr_thread_resource_policy",
  resources: "orkestr_thread_resources",
  grants: "orkestr_thread_resource_grants",
  ceilings: "orkestr_thread_resource_ceilings",
  mutations: "orkestr_thread_resource_mutations",
  mailboxListeners: "orkestr_mailbox_thread_listeners",
  mailboxDeliveries: "orkestr_mailbox_thread_deliveries",
  mailboxPumpLeases: "orkestr_mailbox_thread_pump_leases",
  resourceSessions: "orkestr_thread_resource_sessions",
  policyAuditOutbox: "orkestr_thread_resource_audit_outbox",
});

export function setThreadResourcePolicyPostgresPoolFactory(factory = null) {
  poolFactoryForTest = typeof factory === "function" ? factory : null;
  void closeThreadResourcePolicyPostgresPools();
}

async function closePool(pool) {
  if (typeof pool?.end !== "function") return;
  await pool.end();
}

export async function closeThreadResourcePolicyPostgresPools() {
  const active = [...new Set(pools.values())];
  pools.clear();
  await Promise.allSettled(active.map((pool) => closePool(pool)));
}

export function clearThreadResourcePolicyPostgresCache() {
  return closeThreadResourcePolicyPostgresPools();
}

function policyStoreError(code, statusCode = 503, cause = null) {
  const error = new Error(code);
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
}

function knownPolicyStoreError(error) {
  return /^thread_resource_policy_[a-z0-9_]+$/.test(clean(error?.message));
}

function unavailable(error) {
  if (knownPolicyStoreError(error)) return error;
  return policyStoreError("thread_resource_policy_postgres_unavailable", 503, error);
}

async function loadPg() {
  try {
    pgModulePromise ||= import("pg");
    const module = await pgModulePromise;
    return module.Pool ? module : module.default || module;
  } catch (error) {
    throw policyStoreError("thread_resource_policy_postgres_driver_missing", 503, error);
  }
}

function postgresConnectionConfig(env = process.env) {
  const connectionString = clean(
    env.ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_URL ||
    env.ORKESTR_THREAD_RESOURCE_POLICY_DATABASE_URL ||
    env.ORKESTR_POSTGRES_URL ||
    env.DATABASE_URL,
  );
  if (connectionString) return { connectionString };
  return {
    host: clean(env.ORKESTR_THREAD_RESOURCE_POLICY_PGHOST || env.PGHOST || "127.0.0.1"),
    port: Number(env.ORKESTR_THREAD_RESOURCE_POLICY_PGPORT || env.PGPORT || 5432) || 5432,
    database: clean(env.ORKESTR_THREAD_RESOURCE_POLICY_PGDATABASE || env.PGDATABASE || env.PGUSER || "orkestr"),
    user: clean(env.ORKESTR_THREAD_RESOURCE_POLICY_PGUSER || env.PGUSER || "orkestr"),
    password: env.ORKESTR_THREAD_RESOURCE_POLICY_PGPASSWORD ?? env.PGPASSWORD,
  };
}

function poolCacheKey(env = process.env) {
  const config = postgresConnectionConfig(env);
  return config.connectionString || JSON.stringify({ host: config.host, port: config.port, database: config.database, user: config.user });
}

export async function openThreadResourcePolicyPostgres(env = process.env) {
  const key = poolCacheKey(env);
  let pool = pools.get(key);
  try {
    if (!pool) {
      if (poolFactoryForTest) pool = await poolFactoryForTest(postgresConnectionConfig(env), env);
      else {
        const pg = await loadPg();
        pool = new pg.Pool({
          ...postgresConnectionConfig(env),
          max: Math.max(1, Number(env.ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_POOL_SIZE || 5) || 5),
        });
      }
      pools.set(key, pool);
    }
    pool.__orkestrThreadResourcePolicyReady ||= ensureSchema(pool);
    await pool.__orkestrThreadResourcePolicyReady;
    return pool;
  } catch (error) {
    pools.delete(key);
    throw unavailable(error);
  }
}

// The PostgreSQL schema mirrors the policy state's entity boundaries. Entity
// data stays in JSONB so introducing a field has the same migration-free
// behavior as the SQLite state replacement path, while keys and unique indexes
// retain the safety invariants enforced by the SQLite schema.
async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists orkestr_thread_resource_meta (
      key text primary key,
      value text not null
    );
    create table if not exists orkestr_thread_resource_policy (
      thread_id text not null,
      resource_type text not null,
      data jsonb not null,
      primary key(thread_id, resource_type)
    );
    create table if not exists orkestr_thread_resources (
      resource_type text not null,
      resource_id text not null,
      data jsonb not null,
      primary key(resource_type, resource_id)
    );
    create table if not exists orkestr_thread_resource_grants (
      id text primary key,
      thread_id text not null,
      resource_type text not null,
      resource_id text not null,
      revoked_at text,
      data jsonb not null
    );
    create unique index if not exists idx_thread_resource_grant_active_unique
      on orkestr_thread_resource_grants(thread_id, resource_type, resource_id) where revoked_at is null;
    create table if not exists orkestr_thread_resource_ceilings (
      thread_id text not null,
      resource_type text not null,
      resource_id text not null,
      data jsonb not null,
      primary key(thread_id, resource_type, resource_id)
    );
    create table if not exists orkestr_thread_resource_mutations (
      action text not null,
      idempotency_key text not null,
      data jsonb not null,
      primary key(action, idempotency_key)
    );
    create table if not exists orkestr_mailbox_thread_listeners (
      id text primary key,
      resource_type text not null,
      resource_id text not null,
      thread_id text not null,
      filter_key text not null,
      idempotency_key text not null default '',
      status text not null,
      revoked_at text,
      data jsonb not null
    );
    create unique index if not exists idx_mailbox_thread_listener_active_unique
      on orkestr_mailbox_thread_listeners(resource_type, resource_id, thread_id, filter_key)
      where status = 'active' and revoked_at is null;
    create unique index if not exists idx_mailbox_thread_listener_idempotency_unique
      on orkestr_mailbox_thread_listeners(idempotency_key) where idempotency_key <> '';
    create table if not exists orkestr_mailbox_thread_deliveries (
      id text primary key,
      dedupe_key text not null unique,
      resource_type text not null,
      resource_id text not null,
      state text not null,
      data jsonb not null
    );
    create table if not exists orkestr_mailbox_thread_pump_leases (
      name text primary key,
      data jsonb not null
    );
    create table if not exists orkestr_thread_resource_sessions (
      id text primary key,
      jti_hash text not null unique,
      resource_type text not null,
      resource_id text not null,
      state text not null,
      data jsonb not null
    );
    create table if not exists orkestr_thread_resource_audit_outbox (
      id text primary key,
      action text not null,
      resource_type text not null default '',
      resource_id text not null default '',
      thread_id text not null default '',
      permission text not null default '',
      boundary_id text not null default '',
      owner_user_id text not null default '',
      change_ref text not null default '',
      outcome text not null,
      actor_user_id text not null,
      reason text,
      expires_at text,
      policy_revision integer not null,
      state text not null,
      claim_token text,
      claim_expires_at text,
      delivered_at text,
      created_at text not null
    );
    create index if not exists idx_thread_resource_audit_outbox_state
      on orkestr_thread_resource_audit_outbox(state, created_at);
  `);
  for (const [column, definition] of [
    ["resource_id", "text not null default ''"], ["thread_id", "text not null default ''"], ["permission", "text not null default ''"],
    ["boundary_id", "text not null default ''"], ["owner_user_id", "text not null default ''"], ["change_ref", "text not null default ''"],
  ]) await pool.query(`alter table orkestr_thread_resource_audit_outbox add column if not exists ${column} ${definition}`);
  // Deliberately do not import JSON/SQLite state: an operator must use an
  // explicit, evidence-reviewed migration rather than inferred legacy rows.
  await pool.query("insert into orkestr_thread_resource_meta(key, value) values ($1, $2) on conflict(key) do nothing", ["schema_version", "1"]);
  await pool.query("insert into orkestr_thread_resource_meta(key, value) values ($1, $2) on conflict(key) do nothing", ["legacy_import", "not_attempted"]);
}

function parseData(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function meta(client, key, fallback = "") {
  const result = await client.query("select value from orkestr_thread_resource_meta where key = $1", [key]);
  return result.rows[0]?.value ?? fallback;
}

async function rows(client, table) {
  const result = await client.query(`select data from ${table}`);
  return result.rows.map((row) => parseData(row.data));
}

async function readState(client) {
  // A checked-out pg client executes one statement at a time. Serial reads
  // retain this transaction's single snapshot without pg@9's deprecated
  // concurrent-query warning.
  const revision = await meta(client, "revision", "0");
  const updatedAt = await meta(client, "updated_at", "");
  const policies = await rows(client, tables.policies);
  const resources = await rows(client, tables.resources);
  const grants = await rows(client, tables.grants);
  const ceilings = await rows(client, tables.ceilings);
  const mutations = await rows(client, tables.mutations);
  const mailboxListeners = await rows(client, tables.mailboxListeners);
  const mailboxDeliveries = await rows(client, tables.mailboxDeliveries);
  const mailboxPumpLeases = await rows(client, tables.mailboxPumpLeases);
  const resourceSessions = await rows(client, tables.resourceSessions);
  const audit = await client.query(`select * from ${tables.policyAuditOutbox} order by created_at asc`);
  return {
    version: 1,
    revision: Number(revision || 0) || 0,
    updatedAt: updatedAt || null,
    policies, resources, grants, ceilings, mutations, mailboxListeners, mailboxDeliveries, mailboxPumpLeases, resourceSessions,
    policyAuditOutbox: audit.rows.map((row) => ({
      id: row.id, action: row.action, resourceType: row.resource_type || "", resourceId: row.resource_id || "", threadId: row.thread_id || "",
      permission: row.permission || "", boundaryId: row.boundary_id || "", ownerUserId: row.owner_user_id || "", changeRef: row.change_ref || "", outcome: row.outcome, actorUserId: row.actor_user_id,
      reason: row.reason || "", expiresAt: row.expires_at || null, policyRevision: Number(row.policy_revision || 0), state: row.state,
      claimToken: row.claim_token || null, claimExpiresAt: row.claim_expires_at || null, deliveredAt: row.delivered_at || null, createdAt: row.created_at,
    })),
  };
}

async function insert(client, table, columns = [], values = [], item = {}) {
  const allColumns = [...columns, "data"];
  const placeholders = allColumns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(`insert into ${table}(${allColumns.join(", ")}) values (${placeholders})`, [...values, JSON.stringify(item)]);
}

async function replaceState(client, state = {}, auditOutboxUpserts = []) {
  for (const table of [
    tables.resourceSessions, tables.mailboxPumpLeases, tables.mailboxDeliveries, tables.mailboxListeners,
    tables.grants, tables.resources, tables.policies, tables.ceilings, tables.mutations,
  ]) await client.query(`delete from ${table}`);
  for (const item of state.resources || []) await insert(client, tables.resources, ["resource_type", "resource_id"], [item.resourceType, item.id], item);
  for (const item of state.policies || []) await insert(client, tables.policies, ["thread_id", "resource_type"], [item.threadId, item.resourceType], item);
  for (const item of state.grants || []) await insert(client, tables.grants, ["id", "thread_id", "resource_type", "resource_id", "revoked_at"], [item.id, item.threadId, item.resourceType, item.resourceId, item.revokedAt || null], item);
  for (const item of state.ceilings || []) await insert(client, tables.ceilings, ["thread_id", "resource_type", "resource_id"], [item.threadId, item.resourceType, item.resourceId], item);
  for (const item of (state.mutations || []).slice(-1000)) await insert(client, tables.mutations, ["action", "idempotency_key"], [item.action, item.idempotencyKey], item);
  for (const item of state.mailboxListeners || []) await insert(client, tables.mailboxListeners, ["id", "resource_type", "resource_id", "thread_id", "filter_key", "idempotency_key", "status", "revoked_at"], [item.id, item.resourceType, item.resourceId, item.threadId, item.filterKey, item.idempotencyKey || "", item.status, item.revokedAt || null], item);
  for (const item of state.mailboxDeliveries || []) await insert(client, tables.mailboxDeliveries, ["id", "dedupe_key", "resource_type", "resource_id", "state"], [item.id, item.dedupeKey, item.resourceType, item.resourceId, item.state], item);
  for (const item of state.mailboxPumpLeases || []) await insert(client, tables.mailboxPumpLeases, ["name"], [item.name], item);
  for (const item of state.resourceSessions || []) await insert(client, tables.resourceSessions, ["id", "jti_hash", "resource_type", "resource_id", "state"], [item.id, item.jtiHash, item.resourceType, item.resourceId, item.state], item);

  // Security/audit rows are never part of wholesale state replacement. Existing
  // records can only advance their delivery bookkeeping under the same ID.
  for (const item of auditOutboxUpserts || []) {
    await client.query(`
      insert into ${tables.policyAuditOutbox}(
        id, action, resource_type, resource_id, thread_id, permission, boundary_id, owner_user_id, change_ref,
        outcome, actor_user_id, reason, expires_at, policy_revision, state, claim_token, claim_expires_at, delivered_at, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      on conflict(id) do update set
        state = excluded.state,
        claim_token = excluded.claim_token,
        claim_expires_at = excluded.claim_expires_at,
        delivered_at = excluded.delivered_at
    `, [item.id, item.action, item.resourceType || "", item.resourceId || "", item.threadId || "", item.permission || "", item.boundaryId || "", item.ownerUserId || "", item.changeRef || "",
      item.outcome, item.actorUserId, item.reason || null, item.expiresAt || null, item.policyRevision || 0, item.state || "pending", item.claimToken || null,
      item.claimExpiresAt || null, item.deliveredAt || null, item.createdAt]);
  }
  await client.query("insert into orkestr_thread_resource_meta(key, value) values ($1, $2) on conflict(key) do update set value = excluded.value", ["revision", String(Number(state.revision || 0))]);
  await client.query("insert into orkestr_thread_resource_meta(key, value) values ($1, $2) on conflict(key) do update set value = excluded.value", ["updated_at", state.updatedAt || new Date().toISOString()]);
}

function serializationConflict(error) {
  return error?.code === "40001" || /could not serialize/i.test(clean(error?.message));
}

async function withThreadResourcePolicyPostgresTransactionInternal(operation, env = process.env, { allowAsync = false } = {}) {
  const pool = await openThreadResourcePolicyPostgres(env);
  let lastConflict = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let client = null;
    let operationError = false;
    try {
      client = await pool.connect();
      await client.query("begin isolation level serializable");
      await client.query("insert into orkestr_thread_resource_meta(key, value) values ($1, $2) on conflict(key) do nothing", ["revision", "0"]);
      // One locked row makes whole-state replacement safe across processes.
      await client.query("select value from orkestr_thread_resource_meta where key = $1 for update", ["revision"]);
      const state = await readState(client);
      let outcome;
      try {
        outcome = operation(state);
        if (outcome && typeof outcome.then === "function") {
          if (!allowAsync) throw policyStoreError("thread_resource_policy_transaction_async_operation_forbidden", 500);
          outcome = await outcome;
        }
      } catch (error) {
        operationError = true;
        throw error;
      }
      if (outcome?.state && outcome.persist !== false) await replaceState(client, outcome.state, outcome.auditOutboxUpserts);
      await client.query("commit");
      return outcome;
    } catch (error) {
      await client?.query("rollback").catch(() => {});
      if (operationError) throw error;
      if (serializationConflict(error)) { lastConflict = error; continue; }
      throw unavailable(error);
    } finally {
      client?.release?.();
    }
  }
  throw policyStoreError("thread_resource_policy_transaction_conflict", 409, lastConflict);
}

export async function withThreadResourcePolicyPostgresTransaction(operation, env = process.env) {
  return withThreadResourcePolicyPostgresTransactionInternal(operation, env);
}

// Used only for the mailbox append boundary. The transaction holds the shared
// policy revision lock while an idempotent thread append is performed, so a
// concurrent listener revoke linearizes strictly before or after that append.
export async function withThreadResourcePolicyPostgresDeliveryFence(operation, env = process.env) {
  return withThreadResourcePolicyPostgresTransactionInternal(operation, env, { allowAsync: true });
}

export async function readThreadResourcePolicyPostgresState(env = process.env) {
  const pool = await openThreadResourcePolicyPostgres(env);
  let client = null;
  try {
    client = await pool.connect();
    await client.query("begin isolation level repeatable read read only");
    const state = await readState(client);
    await client.query("commit");
    return state;
  } catch (error) {
    await client?.query("rollback").catch(() => {});
    throw unavailable(error);
  } finally {
    client?.release?.();
  }
}
