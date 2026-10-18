export const PERSONAL_AGENT_EVENTS_MIGRATION_ID = "personal-agent-events-outbox-v1";

const tableName = "personal_agent_event_outbox";
const requiredColumns = Object.freeze([
  "seq", "event_id", "source", "idempotency_key", "payload_hash", "payload_json", "created_at", "dispatched_at",
]);

function tableExists(db) {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(tableName));
}

function tableColumns(db) {
  return new Set(db.prepare(`pragma table_info(${tableName})`).all().map((row) => row.name));
}

function indexes(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'index'").all().map((row) => row.name));
}

function pendingIndexCompatible(db) {
  const columns = db.prepare("pragma index_info('personal_agent_event_outbox_pending')").all().map((row) => row.name);
  return columns.join(",") === "dispatched_at,seq";
}

function compatible(db) {
  if (!tableExists(db)) return true;
  const sql = String(db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(tableName)?.sql || "")
    .toLowerCase().replace(/["`\[\]]/g, "").replace(/\s+/g, " ");
  const columns = tableColumns(db);
  return requiredColumns.every((column) => columns.has(column)) &&
    sql.includes("unique (source, idempotency_key)") &&
    sql.includes("primary key autoincrement");
}

export function planPersonalAgentEventsMigration(db) {
  const present = tableExists(db);
  return {
    migrationId: PERSONAL_AGENT_EVENTS_MIGRATION_ID,
    dryRun: true,
    tablePresent: present,
    missingColumns: present ? requiredColumns.filter((name) => !tableColumns(db).has(name)) : [...requiredColumns],
    schemaCompatible: compatible(db),
    pendingIndexPresent: indexes(db).has("personal_agent_event_outbox_pending"),
    pendingIndexCompatible: !indexes(db).has("personal_agent_event_outbox_pending") || pendingIndexCompatible(db),
  };
}

export function migratePersonalAgentEvents(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentEventsMigration(db);
  if (dryRun) return plan;
  if (!plan.schemaCompatible || (plan.tablePresent && plan.missingColumns.length) || !plan.pendingIndexCompatible) {
    throw new Error("personal_agent_events_schema_incompatible");
  }

  db.exec("begin immediate");
  try {
    if (!compatible(db)) throw new Error("personal_agent_events_schema_incompatible");
    db.exec(`create table if not exists ${tableName} (
      seq integer primary key autoincrement,
      event_id text not null unique,
      source text not null,
      idempotency_key text not null,
      payload_hash text not null,
      payload_json text,
      created_at text not null,
      dispatched_at text,
      unique (source, idempotency_key)
    )`);
    db.exec(`create index if not exists personal_agent_event_outbox_pending
      on ${tableName}(dispatched_at, seq)`);
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, tablePresent: true, missingColumns: [], pendingIndexPresent: true };
}
