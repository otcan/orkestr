// Additive Personal Agent entity schema. This stays in Agent Job's existing
// SQLite database; execution state remains in the existing runs/effects tables.
export const PERSONAL_AGENT_ENTITY_MIGRATION_ID = "personal-agent-project-task-v1";

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
