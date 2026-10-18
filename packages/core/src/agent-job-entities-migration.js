// Additive Personal Agent entity schema. This stays in Agent Job's existing
// SQLite database; execution state remains in the existing runs/effects tables.
export const PERSONAL_AGENT_ENTITY_MIGRATION_ID = "personal-agent-project-task-v1";
export const PERSONAL_AGENT_TASK_LIFECYCLE_MIGRATION_ID = "personal-agent-task-lifecycle-v1";

const statements = Object.freeze([
  `create table if not exists personal_agent_projects (
    id text primary key,
    idempotency_key text unique,
    title text not null,
    goal text,
    state text not null default 'active' check (state in ('active', 'completed', 'archived')),
    data_json text not null default '{}',
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists personal_agent_tasks (
    id text primary key,
    project_id text not null references personal_agent_projects(id) on delete restrict,
    idempotency_key text,
    title text not null,
    outcome text not null,
    acceptance_json text not null default '[]',
    state text not null default 'queued' check (state in ('queued', 'running', 'blocked', 'needs_approval', 'succeeded', 'failed', 'cancelled')),
    thread_id text,
    run_id text,
    data_json text not null default '{}',
    created_at text not null,
    updated_at text not null,
    unique (project_id, idempotency_key)
  )`,
  "create index if not exists personal_agent_projects_state on personal_agent_projects(state, updated_at)",
  "create index if not exists personal_agent_tasks_project_state on personal_agent_tasks(project_id, state, updated_at)",
  "create index if not exists personal_agent_tasks_thread on personal_agent_tasks(thread_id)",
  "create index if not exists personal_agent_tasks_run on personal_agent_tasks(run_id)",
]);

function existingTables(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
}

export function planPersonalAgentEntityMigration(db) {
  const tables = existingTables(db);
  return {
    migrationId: PERSONAL_AGENT_ENTITY_MIGRATION_ID,
    dryRun: true,
    requiredTables: ["personal_agent_projects", "personal_agent_tasks"],
    missingTables: ["personal_agent_projects", "personal_agent_tasks"].filter((name) => !tables.has(name)),
    statements: statements.length,
  };
}

export function migratePersonalAgentEntities(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentEntityMigration(db);
  if (dryRun) return plan;

  db.exec("begin immediate");
  try {
    for (const statement of statements) db.exec(statement);
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, missingTables: [] };
}

function taskColumns(db) {
  return new Set(db.prepare("pragma table_info(personal_agent_tasks)").all().map((row) => row.name));
}

export function migratePersonalAgentTaskLifecycle(db, { dryRun = true } = {}) {
  const tables = existingTables(db);
  if (!tables.has("personal_agent_tasks")) {
    return {
      migrationId: PERSONAL_AGENT_TASK_LIFECYCLE_MIGRATION_ID,
      dryRun,
      missingPrerequisite: "personal_agent_tasks",
      missingColumns: ["contract_json", "completion_json"],
      transitionTablePresent: false,
    };
  }

  const columns = taskColumns(db);
  const missingRequiredColumns = ["id", "project_id", "title", "outcome", "acceptance_json", "state", "created_at", "updated_at"]
    .filter((name) => !columns.has(name));
  const missingColumns = ["contract_json", "completion_json"].filter((name) => !columns.has(name));
  const transitionTablePresent = tables.has("personal_agent_task_transitions");
  const plan = {
    migrationId: PERSONAL_AGENT_TASK_LIFECYCLE_MIGRATION_ID,
    dryRun,
    missingRequiredColumns,
    missingColumns,
    transitionTablePresent,
  };
  if (missingRequiredColumns.length) {
    if (!dryRun) throw new Error("personal_agent_task_lifecycle_schema_incompatible");
    return plan;
  }
  if (dryRun) return plan;

  db.exec("begin immediate");
  try {
    const currentColumns = taskColumns(db);
    const currentMissingRequired = ["id", "project_id", "title", "outcome", "acceptance_json", "state", "created_at", "updated_at"]
      .filter((name) => !currentColumns.has(name));
    if (currentMissingRequired.length) throw new Error("personal_agent_task_lifecycle_schema_incompatible");
    if (!currentColumns.has("contract_json")) {
      db.exec("alter table personal_agent_tasks add column contract_json text not null default '{}'");
    }
    if (!currentColumns.has("completion_json")) {
      db.exec("alter table personal_agent_tasks add column completion_json text");
    }
    db.exec(`create table if not exists personal_agent_task_transitions (
      task_id text not null references personal_agent_tasks(id) on delete restrict,
      seq integer not null,
      from_state text,
      to_state text not null check (to_state in ('queued', 'running', 'blocked', 'needs_approval', 'succeeded', 'failed', 'cancelled')),
      actor_json text not null,
      reason text,
      evidence_json text not null default '{}',
      idempotency_key text,
      created_at text not null,
      primary key (task_id, seq),
      unique (task_id, idempotency_key)
    )`);
    db.exec("create index if not exists personal_agent_task_transitions_created on personal_agent_task_transitions(task_id, created_at)");
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, missingRequiredColumns: [], missingColumns: [], transitionTablePresent: true };
}
