import fs from "node:fs/promises";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";

const databases = new Map();
const databaseOpenPromises = new Map();
const transactionQueues = new Map();
let sqliteModulePromise = null;
const clean = (value = "") => String(value || "").trim();

export function threadResourcePolicyStoreMode(env = process.env) {
  return clean(env.ORKESTR_THREAD_RESOURCE_POLICY_STORE || env.ORKESTR_THREAD_RESOURCE_STORE || env.ORKESTR_STORAGE || "sqlite").toLowerCase();
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

export async function openThreadResourcePolicyDatabase(env = process.env) {
  const mode = threadResourcePolicyStoreMode(env);
  if (mode === "json") throw Object.assign(new Error("thread_resource_policy_transactional_store_required"), { statusCode: 503 });
  // The current clustered store abstraction does not yet expose a PostgreSQL
  // transaction adapter. Refuse a configured PostgreSQL mode rather than
  // silently downgrading policy to process-local or file state.
  if (mode === "postgres" || mode === "postgresql") throw Object.assign(new Error("thread_resource_policy_postgres_backend_not_configured"), { statusCode: 501 });
  const sqlite = await loadSqlite(mode);
  if (!sqlite) throw Object.assign(new Error("thread_resource_policy_transactional_store_required"), { statusCode: 503 });
  const paths = await ensureDataDirs(env);
  if (databases.has(paths.threadResourcePolicyDb)) return databases.get(paths.threadResourcePolicyDb);
  if (databaseOpenPromises.has(paths.threadResourcePolicyDb)) return databaseOpenPromises.get(paths.threadResourcePolicyDb);
  const opening = (async () => {
    const existed = await fs.stat(paths.threadResourcePolicyDb).then((stat) => stat.size > 0, () => false);
    let db = null;
    try {
      db = new sqlite.DatabaseSync(paths.threadResourcePolicyDb);
      db.exec("pragma journal_mode = WAL");
      db.exec("pragma synchronous = NORMAL");
      db.exec("pragma busy_timeout = 5000");
      ensureSchema(db);
      await migrateLegacyDesktopGrants(db, paths, existed);
      databases.set(paths.threadResourcePolicyDb, db);
      return db;
    } catch (error) {
      try { db?.close(); } catch {}
      databases.delete(paths.threadResourcePolicyDb);
      throw error;
    }
  })();
  databaseOpenPromises.set(paths.threadResourcePolicyDb, opening);
  try {
    return await opening;
  } finally {
    if (databaseOpenPromises.get(paths.threadResourcePolicyDb) === opening) databaseOpenPromises.delete(paths.threadResourcePolicyDb);
  }
}

function ensureSchema(db) {
  db.exec(`
    create table if not exists orkestr_thread_resource_meta (
      key text primary key,
      value text not null
    );
    create table if not exists orkestr_thread_resource_policy (
      thread_id text not null,
      resource_type text not null,
      revision integer not null default 0,
      explicit_empty integer not null default 0,
      inheritance_mode text not null default 'explicit',
      parent_snapshot_revision integer not null default 0,
      created_at text not null,
      updated_at text not null,
      primary key(thread_id, resource_type)
    );
    create table if not exists orkestr_thread_resources (
      resource_type text not null,
      resource_id text not null,
      native_id text not null default '',
      resource_key text not null,
      owner_user_id text not null,
      boundary_id text not null,
      generation integer not null default 1,
      status text not null default 'active',
      backend text,
      created_at text not null,
      updated_at text not null,
      retired_at text,
      primary key(resource_type, resource_id)
    );
    create table if not exists orkestr_thread_resource_grants (
      id text primary key,
      thread_id text not null,
      resource_type text not null,
      resource_id text not null,
      resource_key text not null,
      owner_user_id text not null,
      boundary_id text not null,
      permissions_json text not null,
      revision integer not null,
      source text,
      created_at text not null,
      updated_at text not null,
      revoked_at text,
      revoked_by text,
      reason text
    );
    create unique index if not exists idx_thread_resource_grant_active_unique
      on orkestr_thread_resource_grants(thread_id, resource_type, resource_id) where revoked_at is null;
    create index if not exists idx_thread_resource_grants_thread_type
      on orkestr_thread_resource_grants(thread_id, resource_type, revoked_at);
    create table if not exists orkestr_thread_resource_ceilings (
      thread_id text not null,
      resource_type text not null,
      resource_id text not null,
      permissions_json text not null,
      parent_thread_id text not null,
      created_at text not null,
      primary key(thread_id, resource_type, resource_id)
    );
    create table if not exists orkestr_thread_resource_mutations (
      action text not null,
      idempotency_key text not null,
      result_json text not null,
      policy_revision integer not null,
      created_at text not null,
      primary key(action, idempotency_key)
    );
    create table if not exists orkestr_mailbox_thread_listeners (
      id text primary key,
      resource_type text not null,
      resource_id text not null,
      thread_id text not null,
      filter_key text not null,
      filter_json text not null,
      idempotency_key text not null default '',
      generation integer not null,
      status text not null,
      grant_revision integer not null,
      policy_revision integer not null,
      resource_generation integer not null,
      created_at text not null,
      updated_at text not null,
      revoked_at text,
      revoked_by text,
      reason text
    );
    create unique index if not exists idx_mailbox_thread_listener_active_unique
      on orkestr_mailbox_thread_listeners(resource_type, resource_id, thread_id, filter_key)
      where status = 'active' and revoked_at is null;
    create index if not exists idx_mailbox_thread_listeners_resource
      on orkestr_mailbox_thread_listeners(resource_type, resource_id, status);
    create table if not exists orkestr_mailbox_thread_deliveries (
      id text primary key,
      dedupe_key text not null unique,
      resource_type text not null,
      resource_id text not null,
      mailbox_id text not null,
      listener_id text,
      listener_generation integer not null,
      thread_id text,
      state text not null,
      epoch integer not null default 1,
      attempt_count integer not null default 0,
      max_attempts integer not null,
      next_attempt_at text,
      claim_token text,
      claim_expires_at text,
      grant_revision integer not null,
      policy_revision integer not null,
      resource_generation integer not null,
      message_key text not null,
      payload_json text not null,
      reason text,
      created_at text not null,
      updated_at text not null,
      delivered_at text
    );
    create index if not exists idx_mailbox_thread_deliveries_claim
      on orkestr_mailbox_thread_deliveries(state, next_attempt_at, created_at);
    create index if not exists idx_mailbox_thread_deliveries_resource
      on orkestr_mailbox_thread_deliveries(resource_type, resource_id, state);
    create table if not exists orkestr_mailbox_thread_pump_leases (
      name text primary key,
      token text not null,
      expires_at text not null,
      updated_at text not null
    );
  `);
  ensureColumn(db, "orkestr_thread_resource_policy", "inheritance_mode", "text not null default 'explicit'");
  ensureColumn(db, "orkestr_thread_resource_policy", "parent_snapshot_revision", "integer not null default 0");
  ensureColumn(db, "orkestr_thread_resources", "native_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resources", "status", "text not null default 'active'");
  ensureColumn(db, "orkestr_mailbox_thread_deliveries", "epoch", "integer not null default 1");
  ensureColumn(db, "orkestr_mailbox_thread_listeners", "idempotency_key", "text not null default ''");
  db.exec("create unique index if not exists idx_mailbox_thread_listener_idempotency_unique on orkestr_mailbox_thread_listeners(idempotency_key) where idempotency_key <> '';");
  db.exec("update orkestr_thread_resources set native_id = resource_key where native_id = ''; update orkestr_thread_resources set status = case when retired_at is not null then 'retired' else 'active' end where status = '';");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`pragma table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function parseJson(value, fallback) {
  try { const parsed = JSON.parse(String(value || "")); return parsed == null ? fallback : parsed; } catch { return fallback; }
}

function meta(db, key, fallback = "") {
  const row = db.prepare("select value from orkestr_thread_resource_meta where key = ?").get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare("insert into orkestr_thread_resource_meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, String(value));
}

function readState(db) {
  return {
    version: 1,
    revision: Number(meta(db, "revision", "0")) || 0,
    updatedAt: meta(db, "updated_at", "") || null,
    policies: db.prepare("select * from orkestr_thread_resource_policy").all().map((row) => ({ threadId: row.thread_id, resourceType: row.resource_type, revision: Number(row.revision || 0), explicitEmpty: Boolean(row.explicit_empty), inheritanceMode: row.inheritance_mode || "explicit", parentSnapshotRevision: Number(row.parent_snapshot_revision || 0), createdAt: row.created_at, updatedAt: row.updated_at })),
    resources: db.prepare("select * from orkestr_thread_resources").all().map((row) => ({ id: row.resource_id, nativeId: row.native_id || row.resource_key, resourceType: row.resource_type, resourceKey: row.resource_key, ownerUserId: row.owner_user_id, boundaryId: row.boundary_id, generation: Number(row.generation || 1), status: row.status || (row.retired_at ? "retired" : "active"), backend: row.backend || "", createdAt: row.created_at, updatedAt: row.updated_at, retiredAt: row.retired_at || null })),
    grants: db.prepare("select * from orkestr_thread_resource_grants").all().map((row) => ({ id: row.id, threadId: row.thread_id, resourceType: row.resource_type, resourceId: row.resource_id, resourceKey: row.resource_key, ownerUserId: row.owner_user_id, boundaryId: row.boundary_id, permissions: parseJson(row.permissions_json, []), revision: Number(row.revision || 1), source: row.source || "", createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at || null, revokedBy: row.revoked_by || null, reason: row.reason || null })),
    ceilings: db.prepare("select * from orkestr_thread_resource_ceilings").all().map((row) => ({ threadId: row.thread_id, resourceType: row.resource_type, resourceId: row.resource_id, permissions: parseJson(row.permissions_json, []), parentThreadId: row.parent_thread_id, createdAt: row.created_at })),
    mutations: db.prepare("select * from orkestr_thread_resource_mutations").all().map((row) => ({ action: row.action, idempotencyKey: row.idempotency_key, result: parseJson(row.result_json, {}), policyRevision: Number(row.policy_revision || 0), createdAt: row.created_at })),
    mailboxListeners: db.prepare("select * from orkestr_mailbox_thread_listeners").all().map((row) => ({
      id: row.id, resourceType: row.resource_type, resourceId: row.resource_id, threadId: row.thread_id,
      filterKey: row.filter_key, filter: parseJson(row.filter_json, {}), idempotencyKey: row.idempotency_key || "", generation: Number(row.generation || 1),
      status: row.status, grantRevision: Number(row.grant_revision || 0), policyRevision: Number(row.policy_revision || 0),
      resourceGeneration: Number(row.resource_generation || 1), createdAt: row.created_at, updatedAt: row.updated_at,
      revokedAt: row.revoked_at || null, revokedBy: row.revoked_by || null, reason: row.reason || null,
    })),
    mailboxDeliveries: db.prepare("select * from orkestr_mailbox_thread_deliveries").all().map((row) => ({
      id: row.id, dedupeKey: row.dedupe_key, resourceType: row.resource_type, resourceId: row.resource_id,
      mailboxId: row.mailbox_id, listenerId: row.listener_id || null, listenerGeneration: Number(row.listener_generation || 0),
      threadId: row.thread_id || null, state: row.state, epoch: Number(row.epoch || 1), attemptCount: Number(row.attempt_count || 0), maxAttempts: Number(row.max_attempts || 1),
      nextAttemptAt: row.next_attempt_at || null, claimToken: row.claim_token || null, claimExpiresAt: row.claim_expires_at || null,
      grantRevision: Number(row.grant_revision || 0), policyRevision: Number(row.policy_revision || 0), resourceGeneration: Number(row.resource_generation || 1),
      messageKey: row.message_key, payload: parseJson(row.payload_json, {}), reason: row.reason || null,
      createdAt: row.created_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at || null,
    })),
    mailboxPumpLeases: db.prepare("select * from orkestr_mailbox_thread_pump_leases").all().map((row) => ({ name: row.name, token: row.token, expiresAt: row.expires_at, updatedAt: row.updated_at })),
  };
}

function replaceState(db, state = {}) {
  db.exec("delete from orkestr_mailbox_thread_pump_leases; delete from orkestr_mailbox_thread_deliveries; delete from orkestr_mailbox_thread_listeners; delete from orkestr_thread_resource_grants; delete from orkestr_thread_resources; delete from orkestr_thread_resource_policy; delete from orkestr_thread_resource_ceilings; delete from orkestr_thread_resource_mutations;");
  const resource = db.prepare("insert into orkestr_thread_resources(resource_type, resource_id, native_id, resource_key, owner_user_id, boundary_id, generation, status, backend, created_at, updated_at, retired_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.resources || []) resource.run(item.resourceType, item.id, item.nativeId || item.resourceKey, item.resourceKey, item.ownerUserId, item.boundaryId, item.generation, item.status || (item.retiredAt ? "retired" : "active"), item.backend || "", item.createdAt, item.updatedAt, item.retiredAt || null);
  const policy = db.prepare("insert into orkestr_thread_resource_policy(thread_id, resource_type, revision, explicit_empty, inheritance_mode, parent_snapshot_revision, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.policies || []) policy.run(item.threadId, item.resourceType, item.revision, item.explicitEmpty ? 1 : 0, item.inheritanceMode || "explicit", item.parentSnapshotRevision || 0, item.createdAt, item.updatedAt);
  const grant = db.prepare("insert into orkestr_thread_resource_grants(id, thread_id, resource_type, resource_id, resource_key, owner_user_id, boundary_id, permissions_json, revision, source, created_at, updated_at, revoked_at, revoked_by, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.grants || []) grant.run(item.id, item.threadId, item.resourceType, item.resourceId, item.resourceKey, item.ownerUserId, item.boundaryId, JSON.stringify(item.permissions || []), item.revision, item.source || "", item.createdAt, item.updatedAt, item.revokedAt || null, item.revokedBy || null, item.reason || null);
  const ceiling = db.prepare("insert into orkestr_thread_resource_ceilings(thread_id, resource_type, resource_id, permissions_json, parent_thread_id, created_at) values (?, ?, ?, ?, ?, ?)");
  for (const item of state.ceilings || []) ceiling.run(item.threadId, item.resourceType, item.resourceId, JSON.stringify(item.permissions || []), item.parentThreadId, item.createdAt);
  const mutation = db.prepare("insert into orkestr_thread_resource_mutations(action, idempotency_key, result_json, policy_revision, created_at) values (?, ?, ?, ?, ?)");
  for (const item of (state.mutations || []).slice(-1000)) mutation.run(item.action, item.idempotencyKey, JSON.stringify(item.result || {}), item.policyRevision || 0, item.createdAt);
  const listener = db.prepare("insert into orkestr_mailbox_thread_listeners(id, resource_type, resource_id, thread_id, filter_key, filter_json, idempotency_key, generation, status, grant_revision, policy_revision, resource_generation, created_at, updated_at, revoked_at, revoked_by, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.mailboxListeners || []) listener.run(item.id, item.resourceType, item.resourceId, item.threadId, item.filterKey, JSON.stringify(item.filter || {}), item.idempotencyKey || "", item.generation, item.status, item.grantRevision || 0, item.policyRevision || 0, item.resourceGeneration || 1, item.createdAt, item.updatedAt, item.revokedAt || null, item.revokedBy || null, item.reason || null);
  const delivery = db.prepare("insert into orkestr_mailbox_thread_deliveries(id, dedupe_key, resource_type, resource_id, mailbox_id, listener_id, listener_generation, thread_id, state, epoch, attempt_count, max_attempts, next_attempt_at, claim_token, claim_expires_at, grant_revision, policy_revision, resource_generation, message_key, payload_json, reason, created_at, updated_at, delivered_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.mailboxDeliveries || []) delivery.run(item.id, item.dedupeKey, item.resourceType, item.resourceId, item.mailboxId, item.listenerId || null, item.listenerGeneration || 0, item.threadId || null, item.state, item.epoch || 1, item.attemptCount || 0, item.maxAttempts || 1, item.nextAttemptAt || null, item.claimToken || null, item.claimExpiresAt || null, item.grantRevision || 0, item.policyRevision || 0, item.resourceGeneration || 1, item.messageKey, JSON.stringify(item.payload || {}), item.reason || null, item.createdAt, item.updatedAt, item.deliveredAt || null);
  const pumpLease = db.prepare("insert into orkestr_mailbox_thread_pump_leases(name, token, expires_at, updated_at) values (?, ?, ?, ?)");
  for (const item of state.mailboxPumpLeases || []) pumpLease.run(item.name, item.token, item.expiresAt, item.updatedAt);
  setMeta(db, "revision", Number(state.revision || 0));
  setMeta(db, "updated_at", state.updatedAt || new Date().toISOString());
}

export async function withThreadResourcePolicyTransaction(operation, env = process.env) {
  const db = await openThreadResourcePolicyDatabase(env);
  const previous = transactionQueues.get(db) || Promise.resolve();
  const run = previous.catch(() => undefined).then(() => {
    db.exec("begin immediate");
    try {
      const state = readState(db);
      const outcome = operation(state);
      if (outcome && typeof outcome.then === "function") throw new Error("thread_resource_policy_transaction_async_operation_forbidden");
      if (outcome?.state && outcome.persist !== false) replaceState(db, outcome.state);
      db.exec("commit");
      return outcome;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  });
  transactionQueues.set(db, run.then(() => undefined, () => undefined));
  return run;
}

export async function readThreadResourcePolicyState(env = process.env) {
  const db = await openThreadResourcePolicyDatabase(env);
  return readState(db);
}

async function migrateLegacyDesktopGrants(db, paths, existed) {
  if (meta(db, "legacy_desktop_migrated_at", "")) return;
  const count = Number(db.prepare("select count(*) as count from orkestr_thread_resource_grants").get().count || 0);
  if (existed && count > 0) { setMeta(db, "legacy_desktop_migrated_at", new Date().toISOString()); return; }
  const legacy = await readJson(paths.desktopAccess, {});
  if (!Array.isArray(legacy?.grants) || !legacy.grants.length) { setMeta(db, "legacy_desktop_migrated_at", new Date().toISOString()); return; }
  const now = new Date().toISOString();
  const resources = new Map((legacy.resources || []).map((item) => [item.id, item]));
  db.exec("begin immediate");
  try {
    const upsertResource = db.prepare("insert or ignore into orkestr_thread_resources(resource_type, resource_id, resource_key, owner_user_id, boundary_id, generation, backend, created_at, updated_at, retired_at) values ('desktop', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPolicy = db.prepare("insert or ignore into orkestr_thread_resource_policy(thread_id, resource_type, revision, explicit_empty, created_at, updated_at) values (?, 'desktop', ?, 0, ?, ?)");
    const insertGrant = db.prepare("insert or ignore into orkestr_thread_resource_grants(id, thread_id, resource_type, resource_id, resource_key, owner_user_id, boundary_id, permissions_json, revision, source, created_at, updated_at, revoked_at, revoked_by, reason) values (?, ?, 'desktop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const legacyGrant of legacy.grants) {
      const resource = resources.get(legacyGrant.desktopId || legacyGrant.resourceId) || {};
      const resourceId = clean(legacyGrant.desktopId || legacyGrant.resourceId || resource.id);
      const resourceKey = clean(legacyGrant.desktopSlug || legacyGrant.slug || resource.slug);
      if (!resourceId || !resourceKey || !clean(legacyGrant.threadId)) continue;
      const owner = clean(legacyGrant.ownerUserId || resource.ownerUserId || "admin"); const boundary = clean(legacyGrant.boundaryId || resource.boundaryId || "local");
      upsertResource.run(resourceId, resourceKey, owner, boundary, Number(resource.generation || 1) || 1, resource.backend || "desktop", resource.createdAt || now, resource.updatedAt || now, resource.retiredAt || null);
      insertPolicy.run(legacyGrant.threadId, Number(legacy.revision || 1) || 1, now, now);
      insertGrant.run(clean(legacyGrant.id) || `${legacyGrant.threadId}:${resourceId}`, legacyGrant.threadId, resourceId, resourceKey, owner, boundary, JSON.stringify(legacyGrant.permissions || ["discover", "acquire", "operate", "share"]), Number(legacyGrant.revision || 1) || 1, legacyGrant.source || "legacy", legacyGrant.createdAt || now, legacyGrant.updatedAt || now, legacyGrant.revokedAt || null, legacyGrant.revokedBy || null, legacyGrant.reason || null);
    }
    setMeta(db, "revision", Number(legacy.revision || 0) || 0);
    setMeta(db, "updated_at", legacy.updatedAt || now);
    setMeta(db, "legacy_desktop_migrated_at", now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback"); throw error;
  }
}
