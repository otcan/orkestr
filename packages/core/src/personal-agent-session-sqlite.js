import crypto from "node:crypto";
import { openAgentJobDb, tx } from "./agent-job-store.js";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { migratePersonalAgentSessions } from "./personal-agent-session-migration.js";

const columns = [
  "id", "conversation_id", "scope_kind", "scope_id", "role", "provider", "account_profile_id",
  "model_profile_json", "native_session_id", "fork_from_session_id", "lifecycle", "blocked_reason",
  "version", "lease_token", "lease_expires_at", "heartbeat_at", "created_at", "updated_at",
];

function sessionError(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id, conversationId: row.conversation_id, scopeKind: row.scope_kind, scopeId: row.scope_id,
    role: row.role, provider: row.provider, accountProfileId: row.account_profile_id,
    modelProfile: JSON.parse(row.model_profile_json), nativeSessionId: row.native_session_id,
    forkFromSessionId: row.fork_from_session_id, lifecycle: row.lifecycle, blockedReason: row.blocked_reason,
    version: row.version, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function openPersonalAgentSessionStore({ env = process.env, now = Date.now } = {}) {
  if (!personalAgentFeature(env)) throw sessionError("personal_agent_disabled", 404);
  const db = await openAgentJobDb(env);
  const plan = migratePersonalAgentSessions(db, { dryRun: true });
  if (plan.prerequisiteMissing) throw sessionError("personal_agent_session_conversations_required", 503);
  migratePersonalAgentSessions(db, { dryRun: false });
  const getStatement = db.prepare("select * from personal_agent_sessions where id = ?");
  const insertStatement = db.prepare(`insert into personal_agent_sessions (${columns.join(",")}) values (${columns.map(() => "?").join(",")})`);
  const conversationStatement = db.prepare("select id, scope_kind, project_id from personal_agent_conversations where id = ?");
  const insertLeaseStatement = db.prepare(`update personal_agent_sessions set lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
    where id = ? and version = ? and lease_token is null and lifecycle <> 'busy'`);
  const updateStatement = db.prepare(`update personal_agent_sessions set
    lifecycle = ?, blocked_reason = ?, native_session_id = ?, heartbeat_at = ?, model_profile_json = ?,
    lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
    where id = ? and version = ? and lease_token = ? and lease_expires_at > ?`);
  const listStatement = db.prepare(`select * from personal_agent_sessions
    where conversation_id = ? and scope_kind = ? and scope_id is ? order by created_at, id`);

  const store = {
    conversation(conversationId) {
      const row = conversationStatement.get(conversationId);
      return row ? { id: row.id, scopeKind: row.scope_kind, scopeId: row.scope_kind === "project" ? row.project_id : null } : null;
    },
    create(input) {
      const row = {
        id: input.id,
        conversation_id: input.conversationId,
        scope_kind: input.scopeKind,
        scope_id: input.scopeId ?? null,
        role: input.role,
        provider: input.provider,
        account_profile_id: input.accountProfileId,
        model_profile_json: JSON.stringify(input.modelProfile ?? {}),
        native_session_id: input.nativeSessionId ?? null,
        fork_from_session_id: input.forkFromSessionId ?? null,
        lifecycle: input.lifecycle ?? "starting",
        blocked_reason: input.blockedReason ?? null,
        version: 0,
        lease_token: null,
        lease_expires_at: null,
        heartbeat_at: input.heartbeatAt ?? null,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      };
      return tx(db, () => {
        insertStatement.run(...columns.map(key => row[key]));
        return toSession(getStatement.get(row.id));
      });
    },
    get(sessionId) { return toSession(getStatement.get(sessionId)); },
    list({ conversationId, scopeKind, scopeId = null, roles, lifecycles } = {}) {
      let rows = listStatement.all(conversationId, scopeKind, scopeId);
      if (roles) rows = rows.filter(row => roles.includes(row.role));
      if (lifecycles) rows = rows.filter(row => lifecycles.includes(row.lifecycle));
      return rows.map(toSession);
    },
    acquireLease(sessionId, { expectedVersion, ttlMs }) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw sessionError("personal_agent_session_invalid_lease_ttl", 400);
      const at = now();
      const token = crypto.randomBytes(24).toString("base64url");
      return tx(db, () => {
        const current = getStatement.get(sessionId);
        if (!current) throw sessionError("personal_agent_session_not_found", 404);
        const result = insertLeaseStatement.run(token, at + ttlMs, new Date(at).toISOString(), sessionId, expectedVersion);
        if (result.changes !== 1) return null;
        return { session: toSession(getStatement.get(sessionId)), leaseToken: token };
      });
    },
    update(sessionId, { expectedVersion, leaseToken, patch }) {
      const at = now();
      return tx(db, () => {
        const current = getStatement.get(sessionId);
        if (!current) throw sessionError("personal_agent_session_not_found", 404);
        const next = {
          lifecycle: patch.lifecycle ?? current.lifecycle,
          blockedReason: patch.blockedReason === undefined ? current.blocked_reason : patch.blockedReason,
          nativeSessionId: patch.nativeSessionId === undefined ? current.native_session_id : patch.nativeSessionId,
          heartbeatAt: patch.heartbeatAt === undefined ? current.heartbeat_at : patch.heartbeatAt,
          modelProfileJson: patch.modelProfile === undefined ? current.model_profile_json : JSON.stringify(patch.modelProfile),
          leaseToken: patch.releaseLease ? null : leaseToken,
          leaseExpiresAt: patch.releaseLease ? null : at + (patch.leaseTtlMs ?? Math.max(1, current.lease_expires_at - at)),
        };
        if (!Number.isSafeInteger(next.leaseExpiresAt) && next.leaseExpiresAt !== null) throw sessionError("personal_agent_session_invalid_lease_ttl", 400);
        const result = updateStatement.run(
          next.lifecycle, next.blockedReason, next.nativeSessionId, next.heartbeatAt, next.modelProfileJson,
          next.leaseToken, next.leaseExpiresAt, new Date(at).toISOString(), sessionId, expectedVersion, leaseToken, at,
        );
        if (result.changes !== 1) return null;
        return toSession(getStatement.get(sessionId));
      });
    },
  };
  return Object.freeze(store);
}
