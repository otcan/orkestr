function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function meta(db, key, fallback = "") {
  const row = db.prepare("select value from orkestr_thread_resource_meta where key = ?").get(key);
  return row ? row.value : fallback;
}

const accessTables = new Set(["policies", "resources", "grants", "ceilings"]);

// Only what an access decision reads: revision, policies, resources, grants
// and ceilings (the other collections are empty). Authorization runs for
// every desktop asset and websocket, so it must not load the mailbox,
// mutation, audit and session tables.
export function readThreadResourceAccessSqliteState(db) {
  return readTables(db, accessTables);
}

export function readThreadResourcePolicySqliteState(db) {
  return readTables(db);
}

function readTables(db, only = null) {
  const rows = (name, sql) => (!only || only.has(name) ? db.prepare(sql).all() : []);
  return {
    version: 1,
    revision: Number(meta(db, "revision", "0")) || 0,
    updatedAt: meta(db, "updated_at", "") || null,
    policies: rows("policies", "select * from orkestr_thread_resource_policy").map((row) => ({ threadId: row.thread_id, resourceType: row.resource_type, revision: Number(row.revision || 0), explicitEmpty: Boolean(row.explicit_empty), inheritanceMode: row.inheritance_mode || "explicit", parentSnapshotRevision: Number(row.parent_snapshot_revision || 0), createdAt: row.created_at, updatedAt: row.updated_at })),
    resources: rows("resources", "select * from orkestr_thread_resources").map((row) => ({ id: row.resource_id, nativeId: row.native_id || row.resource_key, resourceType: row.resource_type, resourceKey: row.resource_key, ownerUserId: row.owner_user_id, boundaryId: row.boundary_id, generation: Number(row.generation || 1), status: row.status || (row.retired_at ? "retired" : "active"), backend: row.backend || "", createdAt: row.created_at, updatedAt: row.updated_at, retiredAt: row.retired_at || null })),
    grants: rows("grants", "select * from orkestr_thread_resource_grants").map((row) => ({ id: row.id, threadId: row.thread_id, resourceType: row.resource_type, resourceId: row.resource_id, resourceKey: row.resource_key, ownerUserId: row.owner_user_id, boundaryId: row.boundary_id, permissions: parseJson(row.permissions_json, []), revision: Number(row.revision || 1), source: row.source || "", createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at || null, revokedAt: row.revoked_at || null, revokedBy: row.revoked_by || null, reason: row.reason || null })),
    ceilings: rows("ceilings", "select * from orkestr_thread_resource_ceilings").map((row) => ({ threadId: row.thread_id, resourceType: row.resource_type, resourceId: row.resource_id, permissions: parseJson(row.permissions_json, []), parentThreadId: row.parent_thread_id, createdAt: row.created_at })),
    mutations: rows("mutations", "select * from orkestr_thread_resource_mutations").map((row) => ({ action: row.action, idempotencyKey: row.idempotency_key, result: parseJson(row.result_json, {}), policyRevision: Number(row.policy_revision || 0), createdAt: row.created_at })),
    mailboxListeners: rows("mailboxListeners", "select * from orkestr_mailbox_thread_listeners").map((row) => ({
      id: row.id, resourceType: row.resource_type, resourceId: row.resource_id, threadId: row.thread_id,
      filterKey: row.filter_key, filter: parseJson(row.filter_json, {}), idempotencyKey: row.idempotency_key || "", generation: Number(row.generation || 1),
      status: row.status, grantRevision: Number(row.grant_revision || 0), policyRevision: Number(row.policy_revision || 0),
      resourceGeneration: Number(row.resource_generation || 1), createdAt: row.created_at, updatedAt: row.updated_at,
      revokedAt: row.revoked_at || null, revokedBy: row.revoked_by || null, reason: row.reason || null,
    })),
    mailboxDeliveries: rows("mailboxDeliveries", "select * from orkestr_mailbox_thread_deliveries").map((row) => ({
      id: row.id, dedupeKey: row.dedupe_key, resourceType: row.resource_type, resourceId: row.resource_id,
      mailboxId: row.mailbox_id, listenerId: row.listener_id || null, listenerGeneration: Number(row.listener_generation || 0),
      threadId: row.thread_id || null, state: row.state, epoch: Number(row.epoch || 1), attemptCount: Number(row.attempt_count || 0), maxAttempts: Number(row.max_attempts || 1),
      nextAttemptAt: row.next_attempt_at || null, claimToken: row.claim_token || null, claimExpiresAt: row.claim_expires_at || null,
      grantRevision: Number(row.grant_revision || 0), policyRevision: Number(row.policy_revision || 0), resourceGeneration: Number(row.resource_generation || 1),
      messageKey: row.message_key, payload: parseJson(row.payload_json, {}), reason: row.reason || null,
      createdAt: row.created_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at || null,
    })),
    mailboxPumpLeases: rows("mailboxPumpLeases", "select * from orkestr_mailbox_thread_pump_leases").map((row) => ({ name: row.name, token: row.token, expiresAt: row.expires_at, updatedAt: row.updated_at })),
    mailboxRoutes: rows("mailboxRoutes", "select * from orkestr_mailbox_routes").map((row) => parseJson(row.data_json, {})),
    mailboxSources: rows("mailboxSources", "select * from orkestr_mailbox_sources").map((row) => parseJson(row.data_json, {})),
    mailboxRouteWork: rows("mailboxRouteWork", "select * from orkestr_mailbox_route_work").map((row) => parseJson(row.data_json, {})),
    mailboxContexts: rows("mailboxContexts", "select * from orkestr_mailbox_contexts").map((row) => parseJson(row.data_json, {})),
    policyAuditOutbox: rows("policyAuditOutbox", "select * from orkestr_thread_resource_audit_outbox order by created_at asc").map((row) => ({
      id: row.id, action: row.action, resourceType: row.resource_type || "", resourceId: row.resource_id || "", threadId: row.thread_id || "",
      permission: row.permission || "", boundaryId: row.boundary_id || "", ownerUserId: row.owner_user_id || "", changeRef: row.change_ref || "", outcome: row.outcome,
      actorUserId: row.actor_user_id, reason: row.reason || "", expiresAt: row.expires_at || null,
      policyRevision: Number(row.policy_revision || 0), state: row.state, claimToken: row.claim_token || null,
      claimExpiresAt: row.claim_expires_at || null, deliveredAt: row.delivered_at || null, createdAt: row.created_at,
    })),
    resourceSessions: rows("resourceSessions", "select * from orkestr_thread_resource_sessions").map((row) => ({
      id: row.id, jtiHash: row.jti_hash, tokenIdHash: row.token_id_hash, bearerHash: row.bearer_hash || "", audience: row.audience || "",
      scopes: parseJson(row.scopes_json, []), principalKind: row.principal_kind || "external_instance", principalId: row.principal_id || "",
      ownerUserId: row.owner_user_id || "", instanceId: row.instance_id || "", accountId: row.account_id || "", accountService: row.account_service || "",
      resourceType: row.resource_type, resourceId: row.resource_id, actions: parseJson(row.actions_json, []),
      connectorService: row.connector_service || "", connectorAccountId: row.connector_account_id || "", connectorConversationId: row.connector_conversation_id || "",
      connectorBindingId: row.connector_binding_id || "", connectorTargetThreadId: row.connector_target_thread_id || "", connectorOperationRef: row.connector_operation_ref || "",
      connectorTool: row.connector_tool || "", connectorAction: row.connector_action || "",
      threadId: row.thread_id, grantThreadId: row.grant_thread_id || row.thread_id, rootThreadId: row.root_thread_id, boundaryId: row.boundary_id,
      policyRevision: Number(row.policy_revision || 0), grantRevision: Number(row.grant_revision || 0),
      resourceGeneration: Number(row.resource_generation || 1), state: row.state, epoch: Number(row.epoch || 1),
      issuedAt: row.issued_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at || null,
      createdAt: row.created_at, updatedAt: row.updated_at, invalidatedAt: row.invalidated_at || null,
      invalidationReason: row.invalidation_reason || null,
    })),
  };
}
