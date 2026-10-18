export const PERSONAL_AGENT_INGRESS_MIGRATION_ID = "personal-agent-ingress-inbox-v1";

const tableNames = Object.freeze([
  "personal_agent_conversations",
  "personal_agent_messages",
  "personal_agent_reasoning_inbox",
]);

function tables(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
}

function compatible(db) {
  const present = tables(db);
  if (!tableNames.some((name) => present.has(name))) return true;
  if (!tableNames.every((name) => present.has(name))) return false;
  const expected = {
    personal_agent_conversations: ["id", "scope_kind", "project_id", "next_causal_sequence", "created_at", "updated_at"],
    personal_agent_messages: ["id", "conversation_id", "actor_user_id", "actor_origin", "channel", "idempotency_key", "payload_hash", "body", "task_id", "run_id", "event_id", "event_cursor", "causal_sequence", "created_at"],
    personal_agent_reasoning_inbox: ["id", "conversation_id", "message_id", "scope_kind", "scope_id", "task_id", "run_id", "priority", "causal_sequence", "control_flags_json", "state", "created_at", "updated_at"],
  };
  return Object.entries(expected).every(([table, names]) => {
    const columns = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    return names.every((name) => columns.has(name));
  });
}

export function planPersonalAgentIngressMigration(db) {
  const present = tables(db);
  const anyPresent = tableNames.some((name) => present.has(name));
  const missingTables = tableNames.filter((name) => !present.has(name));
  const requiredColumns = {
    personal_agent_conversations: ["id", "scope_kind", "project_id", "next_causal_sequence", "created_at", "updated_at"],
    personal_agent_messages: ["id", "conversation_id", "actor_user_id", "actor_origin", "channel", "idempotency_key", "payload_hash", "body", "task_id", "run_id", "event_id", "event_cursor", "causal_sequence", "created_at"],
    personal_agent_reasoning_inbox: ["id", "conversation_id", "message_id", "scope_kind", "scope_id", "task_id", "run_id", "priority", "causal_sequence", "control_flags_json", "state", "created_at", "updated_at"],
  };
  const missingColumns = Object.fromEntries(Object.entries(requiredColumns).map(([table, names]) => [
    table,
    present.has(table) ? names.filter((name) => !new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name)).has(name)) : [...names],
  ]));
  return {
    migrationId: PERSONAL_AGENT_INGRESS_MIGRATION_ID,
    dryRun: true,
    missingTables,
    missingColumns,
    schemaCompatible: compatible(db),
  };
}

export function migratePersonalAgentIngress(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentIngressMigration(db);
  if (dryRun) return plan;
  if (!plan.schemaCompatible) {
    throw new Error("personal_agent_ingress_schema_incompatible");
  }

  db.exec("begin immediate");
  try {
    if (!compatible(db)) throw new Error("personal_agent_ingress_schema_incompatible");
    db.exec(`create table if not exists personal_agent_conversations (
      id text primary key,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      project_id text references personal_agent_projects(id) on delete restrict,
      next_causal_sequence integer not null default 1 check (next_causal_sequence > 0),
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'global' and project_id is null) or (scope_kind = 'project' and project_id is not null))
    )`);
    db.exec(`create unique index if not exists personal_agent_conversations_global
      on personal_agent_conversations(scope_kind) where scope_kind = 'global'`);
    db.exec(`create unique index if not exists personal_agent_conversations_project
      on personal_agent_conversations(project_id) where scope_kind = 'project'`);
    db.exec(`create table if not exists personal_agent_messages (
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
    )`);
    db.exec(`create index if not exists personal_agent_messages_conversation_order
      on personal_agent_messages(conversation_id, causal_sequence)`);
    db.exec(`create table if not exists personal_agent_reasoning_inbox (
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
    )`);
    db.exec(`create index if not exists personal_agent_reasoning_inbox_pending
      on personal_agent_reasoning_inbox(state, priority desc, causal_sequence)`);
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, missingTables: [], missingColumns: Object.fromEntries(tableNames.map((name) => [name, []])) };
}
