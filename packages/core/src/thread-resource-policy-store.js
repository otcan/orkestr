import fs from "node:fs/promises";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { migrateLegacyDesktopGrants } from "./thread-resource-policy-sqlite-migration.js";
import { readThreadResourcePolicySqliteState as readState } from "./thread-resource-policy-sqlite-state.js";
import { assertTestStoragePath } from "../../storage/src/test-storage-isolation.js";
import {
  clearThreadResourcePolicyPostgresCache,
  closeThreadResourcePolicyPostgresPools,
  openThreadResourcePolicyPostgres,
  readThreadResourcePolicyPostgresState,
  setThreadResourcePolicyPostgresPoolFactory,
  withThreadResourcePolicyPostgresDeliveryFence,
  withThreadResourcePolicyPostgresTransaction,
} from "./thread-resource-policy-postgres.js";

const databases = new Map();
const databaseOpenPromises = new Map();
const transactionQueues = new Map();
let sqliteModulePromise = null;
const clean = (value = "") => String(value || "").trim();
const policyStoreModes = new Set(["sqlite", "postgres", "postgresql", "json"]);

export function threadResourcePolicyStoreMode(env = process.env) {
  const mode = clean(env.ORKESTR_THREAD_RESOURCE_POLICY_STORE || env.ORKESTR_THREAD_RESOURCE_STORE || env.ORKESTR_STORAGE || "sqlite").toLowerCase();
  return policyStoreModes.has(mode) ? mode : "invalid";
}

export const __threadResourcePolicyStoreTestInternals = Object.freeze({
  setPostgresPoolFactory(factory = null) {
    setThreadResourcePolicyPostgresPoolFactory(factory);
  },
  async clearPostgresCache() {
    await clearThreadResourcePolicyPostgresCache();
  },
  async closePostgresPools() {
    await closeThreadResourcePolicyPostgresPools();
  },
});

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
  if (mode === "invalid") throw Object.assign(new Error("thread_resource_policy_store_mode_invalid"), { statusCode: 503 });
  if (mode === "json") throw Object.assign(new Error("thread_resource_policy_transactional_store_required"), { statusCode: 503 });
  if (mode === "postgres" || mode === "postgresql") return openThreadResourcePolicyPostgres(env);
  const sqlite = await loadSqlite(mode);
  if (!sqlite) throw Object.assign(new Error("thread_resource_policy_transactional_store_required"), { statusCode: 503 });
  const paths = await ensureDataDirs(env);
  assertTestStoragePath(paths.threadResourcePolicyDb, env, "thread_resource_policy_sqlite");
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
      expires_at text,
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
    create table if not exists orkestr_mailbox_routes (
      id text primary key,
      resource_id text not null,
      status text not null,
      data_json text not null
    );
    create unique index if not exists idx_mailbox_routes_active_resource
      on orkestr_mailbox_routes(resource_id) where status = 'active';
    create table if not exists orkestr_mailbox_sources (
      id text primary key,
      dedupe_key text not null unique,
      resource_id text not null,
      data_json text not null
    );
    create table if not exists orkestr_mailbox_route_work (
      id text primary key,
      dedupe_key text not null unique,
      route_id text not null,
      state text not null,
      data_json text not null
    );
    create index if not exists idx_mailbox_route_work_claim
      on orkestr_mailbox_route_work(state, route_id);
    create table if not exists orkestr_mailbox_contexts (
      id text primary key,
      work_id text not null unique,
      thread_id text not null,
      status text not null,
      data_json text not null
    );
    create index if not exists idx_mailbox_contexts_pending
      on orkestr_mailbox_contexts(thread_id, status);
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
    create table if not exists orkestr_thread_resource_sessions (
      id text primary key,
      jti_hash text not null unique,
      token_id_hash text not null,
      bearer_hash text not null default '',
      audience text not null default '',
      scopes_json text not null default '[]',
      principal_kind text not null default 'external_instance',
      principal_id text not null default '',
      owner_user_id text not null default '',
      instance_id text not null default '',
      account_id text not null default '',
      account_service text not null default '',
      connector_service text not null default '',
      connector_account_id text not null default '',
      connector_conversation_id text not null default '',
      connector_binding_id text not null default '',
      connector_target_thread_id text not null default '',
      connector_operation_ref text not null default '',
      resource_type text not null,
      resource_id text not null,
      actions_json text not null,
      connector_tool text not null default '',
      connector_action text not null default '',
      thread_id text not null,
      grant_thread_id text not null default '',
      root_thread_id text not null,
      boundary_id text not null,
      policy_revision integer not null,
      grant_revision integer not null,
      resource_generation integer not null,
      state text not null,
      epoch integer not null default 1,
      issued_at text not null,
      expires_at text not null,
      last_used_at text,
      created_at text not null,
      updated_at text not null,
      invalidated_at text,
      invalidation_reason text
    );
    create index if not exists idx_thread_resource_sessions_state
      on orkestr_thread_resource_sessions(state, expires_at);
    create index if not exists idx_thread_resource_sessions_resource
      on orkestr_thread_resource_sessions(resource_type, resource_id, state);
  `);
  ensureColumn(db, "orkestr_thread_resource_policy", "inheritance_mode", "text not null default 'explicit'");
  ensureColumn(db, "orkestr_thread_resource_policy", "parent_snapshot_revision", "integer not null default 0");
  ensureColumn(db, "orkestr_thread_resources", "native_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resources", "status", "text not null default 'active'");
  ensureColumn(db, "orkestr_thread_resource_grants", "expires_at", "text");
  ensureColumn(db, "orkestr_mailbox_thread_deliveries", "epoch", "integer not null default 1");
  ensureColumn(db, "orkestr_mailbox_thread_listeners", "idempotency_key", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "claim_token", "text");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "claim_expires_at", "text");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "delivered_at", "text");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "resource_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "thread_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "permission", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "boundary_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "owner_user_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_audit_outbox", "change_ref", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "grant_thread_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "bearer_hash", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "audience", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "scopes_json", "text not null default '[]'");
  ensureColumn(db, "orkestr_thread_resource_sessions", "principal_kind", "text not null default 'external_instance'");
  ensureColumn(db, "orkestr_thread_resource_sessions", "principal_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "owner_user_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "instance_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "account_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "account_service", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_service", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_account_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_conversation_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_binding_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_target_thread_id", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_operation_ref", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_tool", "text not null default ''");
  ensureColumn(db, "orkestr_thread_resource_sessions", "connector_action", "text not null default ''");
  db.exec("create unique index if not exists idx_mailbox_thread_listener_idempotency_unique on orkestr_mailbox_thread_listeners(idempotency_key) where idempotency_key <> '';");
  db.exec("update orkestr_thread_resources set native_id = resource_key where native_id = ''; update orkestr_thread_resources set status = case when retired_at is not null then 'retired' else 'active' end where status = '';");
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`pragma table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function setMeta(db, key, value) {
  db.prepare("insert into orkestr_thread_resource_meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, String(value));
}

function replaceState(db, state = {}, auditOutboxUpserts = []) {
  db.exec("delete from orkestr_thread_resource_sessions; delete from orkestr_mailbox_contexts; delete from orkestr_mailbox_route_work; delete from orkestr_mailbox_sources; delete from orkestr_mailbox_routes; delete from orkestr_mailbox_thread_pump_leases; delete from orkestr_mailbox_thread_deliveries; delete from orkestr_mailbox_thread_listeners; delete from orkestr_thread_resource_grants; delete from orkestr_thread_resources; delete from orkestr_thread_resource_policy; delete from orkestr_thread_resource_ceilings; delete from orkestr_thread_resource_mutations;");
  const resource = db.prepare("insert into orkestr_thread_resources(resource_type, resource_id, native_id, resource_key, owner_user_id, boundary_id, generation, status, backend, created_at, updated_at, retired_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.resources || []) resource.run(item.resourceType, item.id, item.nativeId || item.resourceKey, item.resourceKey, item.ownerUserId, item.boundaryId, item.generation, item.status || (item.retiredAt ? "retired" : "active"), item.backend || "", item.createdAt, item.updatedAt, item.retiredAt || null);
  const policy = db.prepare("insert into orkestr_thread_resource_policy(thread_id, resource_type, revision, explicit_empty, inheritance_mode, parent_snapshot_revision, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.policies || []) policy.run(item.threadId, item.resourceType, item.revision, item.explicitEmpty ? 1 : 0, item.inheritanceMode || "explicit", item.parentSnapshotRevision || 0, item.createdAt, item.updatedAt);
  const grant = db.prepare("insert into orkestr_thread_resource_grants(id, thread_id, resource_type, resource_id, resource_key, owner_user_id, boundary_id, permissions_json, revision, source, created_at, updated_at, expires_at, revoked_at, revoked_by, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.grants || []) grant.run(item.id, item.threadId, item.resourceType, item.resourceId, item.resourceKey, item.ownerUserId, item.boundaryId, JSON.stringify(item.permissions || []), item.revision, item.source || "", item.createdAt, item.updatedAt, item.expiresAt || null, item.revokedAt || null, item.revokedBy || null, item.reason || null);
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
  const route = db.prepare("insert into orkestr_mailbox_routes(id, resource_id, status, data_json) values (?, ?, ?, ?)");
  for (const item of state.mailboxRoutes || []) route.run(item.id, item.resourceId, item.status, JSON.stringify(item));
  const source = db.prepare("insert into orkestr_mailbox_sources(id, dedupe_key, resource_id, data_json) values (?, ?, ?, ?)");
  for (const item of state.mailboxSources || []) source.run(item.id, item.dedupeKey, item.resourceId, JSON.stringify(item));
  const routeWork = db.prepare("insert into orkestr_mailbox_route_work(id, dedupe_key, route_id, state, data_json) values (?, ?, ?, ?, ?)");
  for (const item of state.mailboxRouteWork || []) routeWork.run(item.id, item.dedupeKey, item.routeId, item.state, JSON.stringify(item));
  const mailboxContext = db.prepare("insert into orkestr_mailbox_contexts(id, work_id, thread_id, status, data_json) values (?, ?, ?, ?, ?)");
  for (const item of state.mailboxContexts || []) mailboxContext.run(item.id, item.workId, item.threadId, item.status, JSON.stringify(item));
  const resourceSession = db.prepare("insert into orkestr_thread_resource_sessions(id, jti_hash, token_id_hash, bearer_hash, audience, scopes_json, principal_kind, principal_id, owner_user_id, instance_id, account_id, account_service, connector_service, connector_account_id, connector_conversation_id, connector_binding_id, connector_target_thread_id, connector_operation_ref, resource_type, resource_id, actions_json, connector_tool, connector_action, thread_id, grant_thread_id, root_thread_id, boundary_id, policy_revision, grant_revision, resource_generation, state, epoch, issued_at, expires_at, last_used_at, created_at, updated_at, invalidated_at, invalidation_reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of state.resourceSessions || []) {
    resourceSession.run(item.id, item.jtiHash, item.tokenIdHash, item.bearerHash || "", item.audience || "", JSON.stringify(item.scopes || []),
      item.principalKind || "external_instance", item.principalId || "", item.ownerUserId || "", item.instanceId || "", item.accountId || "", item.accountService || "",
      item.connectorService || "", item.connectorAccountId || "", item.connectorConversationId || "", item.connectorBindingId || "", item.connectorTargetThreadId || "", item.connectorOperationRef || "",
      item.resourceType, item.resourceId, JSON.stringify(item.actions || []), item.connectorTool || "", item.connectorAction || "", item.threadId, item.grantThreadId || item.threadId, item.rootThreadId, item.boundaryId,
      item.policyRevision || 0, item.grantRevision || 0, item.resourceGeneration || 1,
      item.state || "active", item.epoch || 1, item.issuedAt, item.expiresAt, item.lastUsedAt || null,
      item.createdAt, item.updatedAt, item.invalidatedAt || null, item.invalidationReason || null);
  }
  // Audit history is append-preserving. Policy state can be rebuilt wholesale,
  // but audit rows are only inserted or explicitly state-transitioned here.
  const auditOutbox = db.prepare(`
    insert into orkestr_thread_resource_audit_outbox(
      id, action, resource_type, resource_id, thread_id, permission, boundary_id, owner_user_id, change_ref,
      outcome, actor_user_id, reason, expires_at, policy_revision, state, claim_token, claim_expires_at, delivered_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      state = excluded.state,
      claim_token = excluded.claim_token,
      claim_expires_at = excluded.claim_expires_at,
      delivered_at = excluded.delivered_at
  `);
  for (const item of auditOutboxUpserts || []) {
    auditOutbox.run(item.id, item.action, item.resourceType || "", item.resourceId || "", item.threadId || "", item.permission || "", item.boundaryId || "", item.ownerUserId || "", item.changeRef || "",
      item.outcome, item.actorUserId, item.reason || null, item.expiresAt || null, item.policyRevision || 0, item.state || "pending", item.claimToken || null,
      item.claimExpiresAt || null, item.deliveredAt || null, item.createdAt);
  }
  setMeta(db, "revision", Number(state.revision || 0));
  setMeta(db, "updated_at", state.updatedAt || new Date().toISOString());
}

export async function withThreadResourcePolicyTransaction(operation, env = process.env) {
  const mode = threadResourcePolicyStoreMode(env);
  if (mode === "postgres" || mode === "postgresql") return withThreadResourcePolicyPostgresTransaction(operation, env);
  const db = await openThreadResourcePolicyDatabase(env);
  const previous = transactionQueues.get(db) || Promise.resolve();
  const run = previous.catch(() => undefined).then(() => {
    db.exec("begin immediate");
    try {
      const state = readState(db);
      const outcome = operation(state);
      if (outcome && typeof outcome.then === "function") throw new Error("thread_resource_policy_transaction_async_operation_forbidden");
      if (outcome?.state && outcome.persist !== false) replaceState(db, outcome.state, outcome.auditOutboxUpserts);
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

// This is deliberately separate from ordinary policy writes: an async
// callback is only permitted for the durable mailbox append fence, where the
// idempotent append must be ordered with listener/resource revocation.
export async function withThreadResourcePolicyDeliveryFence(operation, env = process.env) {
  const mode = threadResourcePolicyStoreMode(env);
  if (mode === "postgres" || mode === "postgresql") return withThreadResourcePolicyPostgresDeliveryFence(operation, env);
  const db = await openThreadResourcePolicyDatabase(env);
  const previous = transactionQueues.get(db) || Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    db.exec("begin immediate");
    try {
      const state = readState(db);
      const outcome = await operation(state);
      if (outcome?.state && outcome.persist !== false) replaceState(db, outcome.state, outcome.auditOutboxUpserts);
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
  const mode = threadResourcePolicyStoreMode(env);
  if (mode === "postgres" || mode === "postgresql") return readThreadResourcePolicyPostgresState(env);
  const db = await openThreadResourcePolicyDatabase(env);
  return readState(db);
}
