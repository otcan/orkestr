export const PERSONAL_AGENT_SESSION_MIGRATION_ID = "personal-agent-sessions-v1";

const tableName = "personal_agent_sessions";
const requiredColumns = Object.freeze([
  "id", "conversation_id", "scope_kind", "scope_id", "role", "provider",
  "account_profile_id", "model_profile_json", "native_session_id", "fork_from_session_id",
  "lifecycle", "blocked_reason", "version", "lease_token", "lease_expires_at",
  "heartbeat_at", "created_at", "updated_at",
]);

function tableNames(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(row => row.name));
}

function compatibleSql(db) {
  const sql = db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(tableName)?.sql;
  if (!sql) return false;
  const normalized = sql.toLowerCase().replace(/["`\[\]]/g, "").replace(/\s+/g, " ");
  return [
    "check (scope_kind in ('global', 'project'))",
    "check ((scope_kind = 'global' and scope_id is null) or (scope_kind = 'project' and scope_id is not null))",
    "check (role in ('fast', 'deep', 'worker'))",
    "check (provider in ('codex', 'claude-code'))",
    "check (lifecycle in ('starting', 'ready', 'busy', 'blocked', 'stopped'))",
    "conversation_id text not null references personal_agent_conversations(id) on delete restrict",
  ].every(fragment => normalized.includes(fragment));
}

function triggerNames(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'trigger'").all().map(row => row.name));
}

export function planPersonalAgentSessionMigration(db) {
  const names = tableNames(db);
  const conversationColumns = names.has("personal_agent_conversations")
    ? new Set(db.prepare("pragma table_info(personal_agent_conversations)").all().map(row => row.name))
    : new Set();
  const prerequisiteMissing = !names.has("personal_agent_conversations") || !conversationColumns.has("id");
  const tablePresent = names.has(tableName);
  const columns = tablePresent ? new Set(db.prepare(`pragma table_info(${tableName})`).all().map(row => row.name)) : new Set();
  const triggers = triggerNames(db);
  const requiredTriggers = ["personal_agent_sessions_scope_insert", "personal_agent_sessions_scope_update"];
  const missingColumns = tablePresent ? requiredColumns.filter(column => !columns.has(column)) : [...requiredColumns];
  return {
    migrationId: PERSONAL_AGENT_SESSION_MIGRATION_ID,
    dryRun: true,
    prerequisiteMissing,
    tablePresent,
    missingColumns,
    schemaCompatible: !tablePresent || compatibleSql(db),
    missingTriggers: tablePresent ? requiredTriggers.filter(name => !triggers.has(name)) : requiredTriggers,
  };
}

export function migratePersonalAgentSessions(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentSessionMigration(db);
  if (dryRun) return plan;
  if (plan.prerequisiteMissing) throw new Error("personal_agent_session_conversations_required");
  if (plan.tablePresent && (plan.missingColumns.length || !plan.schemaCompatible || plan.missingTriggers.length)) {
    throw new Error("personal_agent_session_schema_incompatible");
  }

  db.exec("begin immediate");
  try {
    const current = planPersonalAgentSessionMigration(db);
    if (current.prerequisiteMissing || (current.tablePresent && (!current.schemaCompatible || current.missingColumns.length || current.missingTriggers.length))) {
      throw new Error("personal_agent_session_schema_incompatible");
    }
    db.exec(`create table if not exists ${tableName} (
      id text primary key,
      conversation_id text not null references personal_agent_conversations(id) on delete restrict,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      scope_id text,
      role text not null check (role in ('fast', 'deep', 'worker')),
      provider text not null check (provider in ('codex', 'claude-code')),
      account_profile_id text not null,
      model_profile_json text not null,
      native_session_id text,
      fork_from_session_id text references personal_agent_sessions(id) on delete set null,
      lifecycle text not null check (lifecycle in ('starting', 'ready', 'busy', 'blocked', 'stopped')),
      blocked_reason text,
      version integer not null default 0 check (version >= 0),
      lease_token text,
      lease_expires_at integer,
      heartbeat_at text,
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'global' and scope_id is null) or (scope_kind = 'project' and scope_id is not null)),
      check ((lifecycle = 'blocked' and blocked_reason is not null) or (lifecycle <> 'blocked' and blocked_reason is null)),
      check ((lease_token is null and lease_expires_at is null) or (lease_token is not null and lease_expires_at is not null))
    )`);
    db.exec(`create unique index if not exists personal_agent_sessions_active_role
      on personal_agent_sessions(conversation_id, role)
      where role in ('fast', 'deep') and lifecycle in ('starting', 'ready', 'busy', 'blocked')`);
    db.exec(`create unique index if not exists personal_agent_sessions_native_identity
      on personal_agent_sessions(provider, account_profile_id, native_session_id)
      where native_session_id is not null`);
    db.exec("create index if not exists personal_agent_sessions_scope_lifecycle on personal_agent_sessions(scope_kind, scope_id, lifecycle, updated_at)");
    db.exec("create index if not exists personal_agent_sessions_lease on personal_agent_sessions(lease_expires_at) where lease_token is not null");
    db.exec(`create trigger if not exists personal_agent_sessions_scope_insert
      before insert on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end`);
    db.exec(`create trigger if not exists personal_agent_sessions_scope_update
      before update of conversation_id, scope_kind, scope_id on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end`);
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, tablePresent: true, missingColumns: [] };
}
