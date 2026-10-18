export const PERSONAL_AGENT_MEMORY_MIGRATION_ID = "personal-agent-memory-v1";

const tableName = "personal_agent_memories";
const requiredColumns = Object.freeze([
  "id", "idempotency_key", "category", "scope_kind", "scope_id", "content_json",
  "provenance_json", "source_event_id", "source_cursor", "consented_by", "consented_at",
  "created_at", "updated_at",
]);
const indexName = "personal_agent_memories_scope_category";

function tables(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
}

function columns(db) {
  return new Set(db.prepare(`pragma table_info(${tableName})`).all().map((row) => row.name));
}

function indexes(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'index'").all().map((row) => row.name));
}

function compatibleTableSql(db) {
  const row = db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(tableName);
  if (!row?.sql) return false;
  const sql = row.sql.toLowerCase().replace(/[\"`\[\]]/g, "").replace(/\s+/g, " ");
  return [
    "check (category in ('preference', 'fact', 'decision', 'commitment', 'open_loop', 'project_summary'))",
    "check (scope_kind in ('owner', 'project'))",
    "check ((scope_kind = 'owner' and scope_id is null) or (scope_kind = 'project' and scope_id is not null))",
    "check (category <> 'project_summary' or scope_kind = 'project')",
    "foreign key (scope_id) references personal_agent_projects(id) on delete restrict",
  ].every((fragment) => sql.includes(fragment));
}

function compatibleIndex(db) {
  const columns = db.prepare(`pragma index_info('${indexName}')`).all().map((row) => row.name);
  return columns.join(",") === "scope_kind,scope_id,category,updated_at";
}

function incompatibleError() {
  return new Error("personal_agent_memory_schema_incompatible");
}

export function planPersonalAgentMemoryMigration(db) {
  const presentTables = tables(db);
  const projectColumns = presentTables.has("personal_agent_projects")
    ? new Set(db.prepare("pragma table_info(personal_agent_projects)").all().map((row) => row.name))
    : new Set();
  const prerequisiteMissing = !presentTables.has("personal_agent_projects") || !projectColumns.has("id");
  const tablePresent = presentTables.has(tableName);
  const presentColumns = tablePresent ? columns(db) : new Set();
  const memoryIndexes = indexes(db);
  const indexPresent = memoryIndexes.has(indexName);
  return {
    migrationId: PERSONAL_AGENT_MEMORY_MIGRATION_ID,
    dryRun: true,
    prerequisiteMissing,
    tablePresent,
    missingColumns: tablePresent ? requiredColumns.filter((name) => !presentColumns.has(name)) : [...requiredColumns],
    schemaCompatible: !tablePresent || compatibleTableSql(db),
    indexPresent,
    indexCompatible: !indexPresent || compatibleIndex(db),
  };
}

function ensureCompatible(db) {
  const presentTables = tables(db);
  const projectColumns = presentTables.has("personal_agent_projects")
    ? new Set(db.prepare("pragma table_info(personal_agent_projects)").all().map((row) => row.name))
    : new Set();
  if (!presentTables.has("personal_agent_projects") || !projectColumns.has("id")) throw incompatibleError();
  if (presentTables.has(tableName)) {
    const presentColumns = columns(db);
    if (requiredColumns.some((name) => !presentColumns.has(name)) || !compatibleTableSql(db)) throw incompatibleError();
  }
  if (indexes(db).has(indexName) && !compatibleIndex(db)) throw incompatibleError();
}

export function migratePersonalAgentMemory(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentMemoryMigration(db);
  if (dryRun) return plan;
  if (plan.prerequisiteMissing || (plan.tablePresent && (plan.missingColumns.length || !plan.schemaCompatible)) || !plan.indexCompatible) {
    throw incompatibleError();
  }

  db.exec("begin immediate");
  try {
    ensureCompatible(db);
    db.exec(`create table if not exists ${tableName} (
      id text primary key,
      idempotency_key text unique,
      category text not null check (category in
        ('preference', 'fact', 'decision', 'commitment', 'open_loop', 'project_summary')),
      scope_kind text not null check (scope_kind in ('owner', 'project')),
      scope_id text,
      content_json text not null,
      provenance_json text not null,
      source_event_id text,
      source_cursor text,
      consented_by text not null,
      consented_at text not null,
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'owner' and scope_id is null) or
             (scope_kind = 'project' and scope_id is not null)),
      check (category <> 'project_summary' or scope_kind = 'project'),
      foreign key (scope_id) references personal_agent_projects(id) on delete restrict
    )`);
    db.exec(`create index if not exists ${indexName}
      on ${tableName}(scope_kind, scope_id, category, updated_at)`);
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }

  return { ...plan, dryRun: false, tablePresent: true, missingColumns: [], indexPresent: true };
}
