export const PERSONAL_AGENT_INGRESS_MIGRATION_ID = "personal-agent-ingress-inbox-v1";

// Only this migration ever creates these objects, from the fixed DDL below.
// An existing object is therefore trusted only when SQLite's stored
// definition is exactly what this DDL produces. Column collation, constraint
// shape and predicate token kinds all live in that text, so no SQL is parsed.
const tableDdl = Object.freeze({
  personal_agent_conversations: `create table if not exists personal_agent_conversations (
      id text primary key,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      project_id text references personal_agent_projects(id) on delete restrict,
      next_causal_sequence integer not null default 1 check (next_causal_sequence > 0),
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'global' and project_id is null) or (scope_kind = 'project' and project_id is not null))
    )`,
  personal_agent_messages: `create table if not exists personal_agent_messages (
      id text primary key,
      conversation_id text not null references personal_agent_conversations(id) on delete restrict,
      actor_user_id text not null,
      actor_origin text not null,
      channel text not null,
      idempotency_key text not null,
      payload_hash text not null,
      body text not null,
      task_id text references personal_agent_tasks(id) on delete restrict,
      run_id text references runs(id) on delete restrict,
      event_id text not null unique,
      event_cursor text not null,
      causal_sequence integer not null,
      created_at text not null,
      unique (conversation_id, actor_user_id, idempotency_key),
      unique (conversation_id, causal_sequence)
    )`,
  personal_agent_reasoning_inbox: `create table if not exists personal_agent_reasoning_inbox (
      id text primary key,
      conversation_id text not null references personal_agent_conversations(id) on delete restrict,
      message_id text not null unique references personal_agent_messages(id) on delete restrict,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      scope_id text,
      task_id text references personal_agent_tasks(id) on delete restrict,
      run_id text references runs(id) on delete restrict,
      priority integer not null default 0 check (priority between 0 and 2),
      causal_sequence integer not null,
      control_flags_json text not null default '{}',
      state text not null default 'queued' check (state in ('queued', 'running', 'blocked', 'processed', 'cancelled')),
      created_at text not null,
      updated_at text not null,
      unique (conversation_id, causal_sequence),
      check ((scope_kind = 'global' and scope_id is null) or (scope_kind = 'project' and scope_id is not null))
    )`,
});
const tableNames = Object.freeze(Object.keys(tableDdl));

// Indexes this migration owns. A wrong-definition index on its own table is
// rebuilt; a unique one is only rebuilt when existing rows already satisfy it.
const indexes = Object.freeze([
  {
    name: "personal_agent_conversations_global",
    table: "personal_agent_conversations",
    create: `create unique index if not exists personal_agent_conversations_global
      on personal_agent_conversations(scope_kind) where scope_kind = 'global'`,
    duplicates: "select 1 from personal_agent_conversations where scope_kind = 'global' group by scope_kind having count(*) > 1 limit 1",
  },
  {
    name: "personal_agent_conversations_project",
    table: "personal_agent_conversations",
    create: `create unique index if not exists personal_agent_conversations_project
      on personal_agent_conversations(project_id) where scope_kind = 'project'`,
    duplicates: "select 1 from personal_agent_conversations where scope_kind = 'project' group by project_id having count(*) > 1 limit 1",
  },
  {
    name: "personal_agent_messages_conversation_order",
    table: "personal_agent_messages",
    create: `create index if not exists personal_agent_messages_conversation_order
      on personal_agent_messages(conversation_id, causal_sequence)`,
  },
  {
    name: "personal_agent_reasoning_inbox_pending",
    table: "personal_agent_reasoning_inbox",
    create: `create index if not exists personal_agent_reasoning_inbox_pending
      on personal_agent_reasoning_inbox(state, priority desc, causal_sequence)`,
  },
]);

// SQLite's stored text for the DDL above, from a scratch in-memory database.
const canonicalSql = new WeakMap();
function canonical(db) {
  const Database = db.constructor;
  if (canonicalSql.has(Database)) return canonicalSql.get(Database);
  const scratch = new Database(":memory:");
  try {
    for (const ddl of Object.values(tableDdl)) scratch.exec(ddl);
    for (const index of indexes) scratch.exec(index.create);
    const stored = new Map(scratch.prepare("select name, sql from sqlite_master where sql is not null").all().map((row) => [row.name, row.sql]));
    canonicalSql.set(Database, stored);
    return stored;
  } finally {
    scratch.close();
  }
}

function stored(db, type, name) {
  return db.prepare("select tbl_name, sql from sqlite_master where type = ? and name = ?").get(type, name) || null;
}

// missing | valid | invalid (ours, rebuilt) | foreign (another table's; never touched)
function indexState(db, index) {
  const row = stored(db, "index", index.name);
  if (!row) return "missing";
  if (row.tbl_name !== index.table) return "foreign";
  return row.sql === canonical(db).get(index.name) ? "valid" : "invalid";
}

function inspect(db) {
  const expected = canonical(db);
  const present = new Map(tableNames.map((name) => [name, stored(db, "table", name)]));
  const anyPresent = [...present.values()].some(Boolean);
  const missingTables = tableNames.filter((name) => !present.get(name));
  const incompatibleTables = tableNames.filter((name) => present.get(name) && present.get(name).sql !== expected.get(name));
  const states = new Map(indexes.map((index) => [index.name, indexState(db, index)]));
  const foreignIndexes = indexes.filter((index) => states.get(index.name) === "foreign").map((index) => index.name);
  const invalidIndexes = indexes.filter((index) => states.get(index.name) === "invalid").map((index) => index.name);
  // A unique index still to be (re)built must not meet duplicate rows it would reject.
  const duplicateConflicts = present.get("personal_agent_conversations") && !incompatibleTables.includes("personal_agent_conversations")
    ? indexes.filter((index) => index.duplicates && states.get(index.name) !== "valid" && db.prepare(index.duplicates).get()).map((index) => index.name)
    : [];
  const structural = foreignIndexes.length === 0 && incompatibleTables.length === 0 && (!anyPresent || missingTables.length === 0);
  return { missingTables, incompatibleTables, invalidIndexes, foreignIndexes, duplicateConflicts, structural };
}

export function planPersonalAgentIngressMigration(db) {
  const state = inspect(db);
  return {
    migrationId: PERSONAL_AGENT_INGRESS_MIGRATION_ID,
    dryRun: true,
    missingTables: state.missingTables,
    incompatibleTables: state.incompatibleTables,
    invalidIndexes: state.invalidIndexes,
    foreignIndexes: state.foreignIndexes,
    duplicateConflicts: state.duplicateConflicts,
    schemaCompatible: state.structural && state.duplicateConflicts.length === 0,
  };
}

function assertMigratable(state) {
  if (!state.structural) throw new Error("personal_agent_ingress_schema_incompatible");
  if (state.duplicateConflicts.length) throw new Error("personal_agent_ingress_duplicate_conversations");
}

export function migratePersonalAgentIngress(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentIngressMigration(db);
  if (dryRun) return plan;
  assertMigratable(inspect(db));

  db.exec("begin immediate");
  try {
    assertMigratable(inspect(db));
    for (const ddl of Object.values(tableDdl)) db.exec(ddl);
    // Duplicates were refused above; the transaction restores any dropped
    // index if a rebuild fails.
    for (const index of indexes) {
      const state = indexState(db, index);
      if (state === "invalid") db.exec(`drop index ${index.name}`);
      if (state === "invalid" || state === "missing") db.exec(index.create);
    }
    const after = inspect(db);
    if (!after.structural || after.missingTables.length || indexes.some((index) => indexState(db, index) !== "valid")) {
      throw new Error("personal_agent_ingress_schema_incompatible");
    }
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, missingTables: [], incompatibleTables: [], invalidIndexes: [], foreignIndexes: [], duplicateConflicts: [] };
}
