// Persists a policy-store state into SQLite. With a baseline (the state the
// transaction started from) only changed rows are written: removed rows are
// deleted, changed rows are updated in place (keeping their rowid, so
// `select *` order matches a full rewrite) and new rows are appended. A table
// falls back to the full delete-and-reinsert when its order changed, its keys
// collide, or an in-place update trips a unique index. Rows in the DB are
// assumed to be what the encoders below produce, which holds because every
// write goes through them.
const json = (value, fallback) => JSON.stringify(value || fallback);
// `key` lists the item fields behind the leading primary-key columns.
const spec = (table, columns, key, rows, encode) => ({ table, columns, key, rows, encode });

const tables = [
  spec("orkestr_thread_resources", ["resource_type", "resource_id", "native_id", "resource_key", "owner_user_id", "boundary_id", "generation", "status", "backend", "created_at", "updated_at", "retired_at"], ["resourceType", "id"], (s) => s.resources,
    (item) => [item.resourceType, item.id, item.nativeId || item.resourceKey, item.resourceKey, item.ownerUserId, item.boundaryId, item.generation, item.status || (item.retiredAt ? "retired" : "active"), item.backend || "", item.createdAt, item.updatedAt, item.retiredAt || null]),
  spec("orkestr_thread_resource_policy", ["thread_id", "resource_type", "revision", "explicit_empty", "inheritance_mode", "parent_snapshot_revision", "created_at", "updated_at"], ["threadId", "resourceType"], (s) => s.policies,
    (item) => [item.threadId, item.resourceType, item.revision, item.explicitEmpty ? 1 : 0, item.inheritanceMode || "explicit", item.parentSnapshotRevision || 0, item.createdAt, item.updatedAt]),
  spec("orkestr_thread_resource_grants", ["id", "thread_id", "resource_type", "resource_id", "resource_key", "owner_user_id", "boundary_id", "permissions_json", "revision", "source", "created_at", "updated_at", "expires_at", "revoked_at", "revoked_by", "reason"], ["id"], (s) => s.grants,
    (item) => [item.id, item.threadId, item.resourceType, item.resourceId, item.resourceKey, item.ownerUserId, item.boundaryId, json(item.permissions, []), item.revision, item.source || "", item.createdAt, item.updatedAt, item.expiresAt || null, item.revokedAt || null, item.revokedBy || null, item.reason || null]),
  spec("orkestr_thread_resource_ceilings", ["thread_id", "resource_type", "resource_id", "permissions_json", "parent_thread_id", "created_at"], ["threadId", "resourceType", "resourceId"], (s) => s.ceilings,
    (item) => [item.threadId, item.resourceType, item.resourceId, json(item.permissions, []), item.parentThreadId, item.createdAt]),
  spec("orkestr_thread_resource_mutations", ["action", "idempotency_key", "result_json", "policy_revision", "created_at"], ["action", "idempotencyKey"], (s) => (s.mutations || []).slice(-1000),
    (item) => [item.action, item.idempotencyKey, json(item.result, {}), item.policyRevision || 0, item.createdAt]),
  spec("orkestr_mailbox_thread_listeners", ["id", "resource_type", "resource_id", "thread_id", "filter_key", "filter_json", "idempotency_key", "generation", "status", "grant_revision", "policy_revision", "resource_generation", "created_at", "updated_at", "revoked_at", "revoked_by", "reason"], ["id"], (s) => s.mailboxListeners,
    (item) => [item.id, item.resourceType, item.resourceId, item.threadId, item.filterKey, json(item.filter, {}), item.idempotencyKey || "", item.generation, item.status, item.grantRevision || 0, item.policyRevision || 0, item.resourceGeneration || 1, item.createdAt, item.updatedAt, item.revokedAt || null, item.revokedBy || null, item.reason || null]),
  spec("orkestr_mailbox_thread_deliveries", ["id", "dedupe_key", "resource_type", "resource_id", "mailbox_id", "listener_id", "listener_generation", "thread_id", "state", "epoch", "attempt_count", "max_attempts", "next_attempt_at", "claim_token", "claim_expires_at", "grant_revision", "policy_revision", "resource_generation", "message_key", "payload_json", "reason", "created_at", "updated_at", "delivered_at"], ["id"], (s) => s.mailboxDeliveries,
    (item) => [item.id, item.dedupeKey, item.resourceType, item.resourceId, item.mailboxId, item.listenerId || null, item.listenerGeneration || 0, item.threadId || null, item.state, item.epoch || 1, item.attemptCount || 0, item.maxAttempts || 1, item.nextAttemptAt || null, item.claimToken || null, item.claimExpiresAt || null, item.grantRevision || 0, item.policyRevision || 0, item.resourceGeneration || 1, item.messageKey, json(item.payload, {}), item.reason || null, item.createdAt, item.updatedAt, item.deliveredAt || null]),
  spec("orkestr_mailbox_thread_pump_leases", ["name", "token", "expires_at", "updated_at"], ["name"], (s) => s.mailboxPumpLeases,
    (item) => [item.name, item.token, item.expiresAt, item.updatedAt]),
  spec("orkestr_mailbox_routes", ["id", "resource_id", "status", "data_json"], ["id"], (s) => s.mailboxRoutes,
    (item) => [item.id, item.resourceId, item.status, JSON.stringify(item)]),
  spec("orkestr_mailbox_sources", ["id", "dedupe_key", "resource_id", "data_json"], ["id"], (s) => s.mailboxSources,
    (item) => [item.id, item.dedupeKey, item.resourceId, JSON.stringify(item)]),
  spec("orkestr_mailbox_route_work", ["id", "dedupe_key", "route_id", "state", "data_json"], ["id"], (s) => s.mailboxRouteWork,
    (item) => [item.id, item.dedupeKey, item.routeId, item.state, JSON.stringify(item)]),
  spec("orkestr_mailbox_contexts", ["id", "work_id", "thread_id", "status", "data_json"], ["id"], (s) => s.mailboxContexts,
    (item) => [item.id, item.workId, item.threadId, item.status, JSON.stringify(item)]),
  spec("orkestr_thread_resource_sessions", ["id", "jti_hash", "token_id_hash", "bearer_hash", "audience", "scopes_json", "principal_kind", "principal_id", "owner_user_id", "instance_id", "account_id", "account_service", "connector_service", "connector_account_id", "connector_conversation_id", "connector_binding_id", "connector_target_thread_id", "connector_operation_ref", "resource_type", "resource_id", "actions_json", "connector_tool", "connector_action", "thread_id", "grant_thread_id", "root_thread_id", "boundary_id", "policy_revision", "grant_revision", "resource_generation", "state", "epoch", "issued_at", "expires_at", "last_used_at", "created_at", "updated_at", "invalidated_at", "invalidation_reason"], ["id"], (s) => s.resourceSessions,
    (item) => [item.id, item.jtiHash, item.tokenIdHash, item.bearerHash || "", item.audience || "", json(item.scopes, []),
      item.principalKind || "external_instance", item.principalId || "", item.ownerUserId || "", item.instanceId || "", item.accountId || "", item.accountService || "",
      item.connectorService || "", item.connectorAccountId || "", item.connectorConversationId || "", item.connectorBindingId || "", item.connectorTargetThreadId || "", item.connectorOperationRef || "",
      item.resourceType, item.resourceId, json(item.actions, []), item.connectorTool || "", item.connectorAction || "", item.threadId, item.grantThreadId || item.threadId, item.rootThreadId, item.boundaryId,
      item.policyRevision || 0, item.grantRevision || 0, item.resourceGeneration || 1, item.state || "active", item.epoch || 1, item.issuedAt, item.expiresAt, item.lastUsedAt || null,
      item.createdAt, item.updatedAt, item.invalidatedAt || null, item.invalidationReason || null]),
];

const statements = new WeakMap();

function prepared(db, table) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  if (!cache.has(table.table)) {
    const keys = table.columns.slice(0, table.key.length);
    const rest = table.columns.slice(table.key.length);
    const where = keys.map((column) => `${column} = ?`).join(" and ");
    cache.set(table.table, {
      insert: db.prepare(`insert into ${table.table}(${table.columns.join(", ")}) values (${table.columns.map(() => "?").join(", ")})`),
      update: rest.length ? db.prepare(`update ${table.table} set ${rest.map((column) => `${column} = ?`).join(", ")} where ${where}`) : null,
      remove: db.prepare(`delete from ${table.table} where ${where}`),
      clear: db.prepare(`delete from ${table.table}`),
    });
  }
  return cache.get(table.table);
}

function indexRows(table, state) {
  const rows = new Map();
  for (const item of table.rows(state) || []) {
    const key = JSON.stringify(table.key.map((field) => item?.[field]));
    if (rows.has(key)) return null;
    rows.set(key, item);
  }
  return rows;
}

// Order-sensitive structural equality: equal items encode to equal rows
// (including JSON column key order), without stringifying large payloads.
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const proto = Object.getPrototypeOf(a);
  if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== Array.prototype && proto !== null)) return false;
  const keys = Object.keys(a);
  const other = Object.keys(b);
  if (keys.length !== other.length) return false;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== other[i] || !sameValue(a[keys[i]], b[keys[i]])) return false;
  }
  return true;
}

function rewriteTable(db, table, state) {
  const sql = prepared(db, table);
  sql.clear.run();
  for (const item of table.rows(state) || []) sql.insert.run(...table.encode(item));
}

// Kept rows must stay in baseline order and every new row must follow them,
// otherwise in-place updates plus appends would not reproduce the read order.
function keepsOrder(before, after) {
  const kept = [...before.keys()].filter((key) => after.has(key));
  let index = 0;
  for (const key of after.keys()) {
    if (index < kept.length) { if (key !== kept[index]) return false; index += 1; }
    else if (before.has(key)) return false;
  }
  return true;
}

function diffTable(db, table, state, baseline) {
  const before = indexRows(table, baseline);
  const after = indexRows(table, state);
  if (!before || !after || !keepsOrder(before, after)) return rewriteTable(db, table, state);
  const sql = prepared(db, table);
  try {
    for (const [key, item] of before) if (!after.has(key)) sql.remove.run(...table.key.map((field) => item[field]));
    for (const [key, item] of after) {
      const old = before.get(key);
      if (!old) sql.insert.run(...table.encode(item));
      else if (!sameValue(old, item)) {
        const values = table.encode(item);
        sql.update.run(...values.slice(table.key.length), ...values.slice(0, table.key.length));
      }
    }
  } catch {
    // A failed statement is undone on its own; rebuilding the table resolves
    // transient unique-index swaps exactly like the full rewrite does.
    rewriteTable(db, table, state);
  }
}

export function writeSqliteState(db, state = {}, baseline = null, auditOutboxUpserts = []) {
  for (const table of tables) {
    if (baseline) diffTable(db, table, state, baseline);
    else rewriteTable(db, table, state);
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
  const setMeta = db.prepare("insert into orkestr_thread_resource_meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value");
  setMeta.run("revision", String(Number(state.revision || 0)));
  setMeta.run("updated_at", String(state.updatedAt || new Date().toISOString()));
}
