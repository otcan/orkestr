export const PERSONAL_AGENT_SESSION_MIGRATION_ID = "personal-agent-sessions-v1";

const tableName = "personal_agent_sessions";
const requiredColumns = Object.freeze([
  "id", "conversation_id", "scope_kind", "scope_id", "role", "provider",
  "account_profile_id", "model_profile_json", "native_session_id", "fork_from_session_id",
  "lifecycle", "blocked_reason", "version", "lease_token", "lease_expires_at",
  "heartbeat_at", "created_at", "updated_at",
]);

// These literal DDL strings are a compatibility contract; do not reformat them.
const tableDdl = `create table if not exists personal_agent_sessions (
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
    )`;

const indexes = Object.freeze([
  {
    name: "personal_agent_sessions_active_role",
    table: tableName,
    unique: true,
    create: `create unique index if not exists personal_agent_sessions_active_role
      on personal_agent_sessions(conversation_id, role)
      where role in ('fast', 'deep') and lifecycle in ('starting', 'ready', 'busy', 'blocked')`,
  },
  {
    name: "personal_agent_sessions_native_identity",
    table: tableName,
    unique: true,
    create: `create unique index if not exists personal_agent_sessions_native_identity
      on personal_agent_sessions(provider, account_profile_id, native_session_id)
      where native_session_id is not null`,
  },
  {
    name: "personal_agent_sessions_scope_lifecycle",
    table: tableName,
    create: `create index if not exists personal_agent_sessions_scope_lifecycle on personal_agent_sessions(scope_kind, scope_id, lifecycle, updated_at)`,
  },
  {
    name: "personal_agent_sessions_lease",
    table: tableName,
    create: `create index if not exists personal_agent_sessions_lease on personal_agent_sessions(lease_expires_at) where lease_token is not null`,
  },
]);

const triggers = Object.freeze([
  {
    name: "personal_agent_sessions_scope_insert",
    table: tableName,
    create: `create trigger personal_agent_sessions_scope_insert
      before insert on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end`,
  },
  {
    name: "personal_agent_sessions_scope_update",
    table: tableName,
    create: `create trigger personal_agent_sessions_scope_update
      before update of conversation_id, scope_kind, scope_id on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end`,
  },
]);

const canonicalSql = new WeakMap();
function canonical(db) {
  const Database = db.constructor;
  if (canonicalSql.has(Database)) return canonicalSql.get(Database);
  const scratch = new Database(":memory:");
  try {
    scratch.exec("create table personal_agent_conversations (id text primary key, scope_kind text not null, project_id text)");
    scratch.exec(tableDdl);
    for (const index of indexes) scratch.exec(index.create);
    for (const trigger of triggers) scratch.exec(trigger.create);
    const stored = new Map(scratch.prepare("select name, sql from sqlite_master where sql is not null").all().map(row => [row.name, row.sql]));
    canonicalSql.set(Database, stored);
    return stored;
  } finally {
    scratch.close();
  }
}

function stored(db, type, name) {
  return db.prepare("select tbl_name, sql from sqlite_master where type = ? and name = ?").get(type, name) || null;
}

function objectState(db, type, object) {
  const row = stored(db, type, object.name);
  if (!row) return "missing";
  if (row.tbl_name !== object.table) return "foreign";
  return row.sql === canonical(db).get(object.name) ? "valid" : "invalid";
}

function tableNames(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(row => row.name));
}

function inspect(db) {
  const names = tableNames(db);
  const conversationColumns = names.has("personal_agent_conversations")
    ? new Set(db.prepare("pragma table_info(personal_agent_conversations)").all().map(row => row.name))
    : new Set();
  const prerequisiteMissing = !names.has("personal_agent_conversations") || !conversationColumns.has("id");
  const tablePresent = names.has(tableName);
  const columns = tablePresent ? new Set(db.prepare(`pragma table_info(${tableName})`).all().map(row => row.name)) : new Set();
  const missingColumns = tablePresent ? requiredColumns.filter(column => !columns.has(column)) : [...requiredColumns];
  const table = tablePresent ? stored(db, "table", tableName) : null;
  const tableCompatible = !tablePresent || table.sql === canonical(db).get(tableName);
  const indexStates = new Map(indexes.map(index => [index.name, objectState(db, "index", index)]));
  const triggerStates = new Map(triggers.map(trigger => [trigger.name, objectState(db, "trigger", trigger)]));
  const foreignNamesakes = [
    ...indexes.filter(index => indexStates.get(index.name) === "foreign").map(index => index.name),
    ...triggers.filter(trigger => triggerStates.get(trigger.name) === "foreign").map(trigger => trigger.name),
  ];
  return {
    prerequisiteMissing,
    tablePresent,
    missingColumns,
    tableCompatible,
    indexStates,
    triggerStates,
    foreignNamesakes,
    schemaCompatible: (!tablePresent || (tableCompatible && missingColumns.length === 0)) && foreignNamesakes.length === 0,
  };
}

export function planPersonalAgentSessionMigration(db) {
  const state = inspect(db);
  return {
    migrationId: PERSONAL_AGENT_SESSION_MIGRATION_ID,
    dryRun: true,
    prerequisiteMissing: state.prerequisiteMissing,
    tablePresent: state.tablePresent,
    missingColumns: state.missingColumns,
    schemaCompatible: state.schemaCompatible,
    incompatibleObjects: state.foreignNamesakes,
    invalidIndexes: indexes.filter(index => state.indexStates.get(index.name) === "invalid").map(index => index.name),
    missingTriggers: triggers.filter(trigger => state.triggerStates.get(trigger.name) !== "valid").map(trigger => trigger.name),
  };
}

function assertCompatible(state) {
  if (state.prerequisiteMissing) throw new Error("personal_agent_session_conversations_required");
  if (!state.schemaCompatible) throw new Error("personal_agent_session_schema_incompatible");
}

function assertExistingRowsValid(db, state) {
  if (!state.tablePresent) return;
  const scopeMismatch = db.prepare(`select 1 from personal_agent_sessions s
    left join personal_agent_conversations c on c.id = s.conversation_id
    where c.id is null or c.scope_kind <> s.scope_kind
      or (s.scope_kind = 'global' and s.scope_id is not null)
      or (s.scope_kind = 'project' and (s.scope_id is null or c.project_id <> s.scope_id))
    limit 1`).get();
  if (scopeMismatch) throw new Error("personal_agent_session_scope_mismatch");

  const activeRoleIndex = indexes.find(index => index.name === "personal_agent_sessions_active_role");
  if (state.indexStates.get(activeRoleIndex.name) !== "valid") {
    const duplicates = db.prepare(`select 1 from personal_agent_sessions
      where role in ('fast', 'deep') and lifecycle in ('starting', 'ready', 'busy', 'blocked')
      group by conversation_id, role having count(*) > 1 limit 1`).get();
    if (duplicates) throw new Error("personal_agent_session_active_role_duplicates");
  }
}

export function migratePersonalAgentSessions(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentSessionMigration(db);
  if (dryRun) return plan;
  assertCompatible(inspect(db));

  db.exec("begin immediate");
  try {
    const current = inspect(db);
    assertCompatible(current);
    assertExistingRowsValid(db, current);
    if (!current.tablePresent) db.exec(tableDdl);

    for (const index of indexes) {
      const state = objectState(db, "index", index);
      if (state === "foreign") throw new Error("personal_agent_session_schema_incompatible");
      if (state === "invalid") db.exec(`drop index ${index.name}`);
      if (state === "invalid" || state === "missing") db.exec(index.create);
    }
    for (const trigger of triggers) {
      const state = objectState(db, "trigger", trigger);
      if (state === "foreign") throw new Error("personal_agent_session_schema_incompatible");
      if (state === "invalid") db.exec(`drop trigger ${trigger.name}`);
      if (state === "invalid" || state === "missing") db.exec(trigger.create);
    }

    const after = inspect(db);
    if (!after.schemaCompatible || indexes.some(index => objectState(db, "index", index) !== "valid")
      || triggers.some(trigger => objectState(db, "trigger", trigger) !== "valid")) {
      throw new Error("personal_agent_session_schema_incompatible");
    }
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, tablePresent: true, missingColumns: [], missingTriggers: [], invalidIndexes: [], incompatibleObjects: [] };
}
