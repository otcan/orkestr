export const PERSONAL_AGENT_INGRESS_MIGRATION_ID = "personal-agent-ingress-inbox-v1";

const tableNames = Object.freeze([
  "personal_agent_conversations",
  "personal_agent_messages",
  "personal_agent_reasoning_inbox",
]);

const requiredColumns = Object.freeze({
  personal_agent_conversations: ["id", "scope_kind", "project_id", "next_causal_sequence", "created_at", "updated_at"],
  personal_agent_messages: ["id", "conversation_id", "actor_user_id", "actor_origin", "channel", "idempotency_key", "payload_hash", "body", "task_id", "run_id", "event_id", "event_cursor", "causal_sequence", "created_at"],
  personal_agent_reasoning_inbox: ["id", "conversation_id", "message_id", "scope_kind", "scope_id", "task_id", "run_id", "priority", "causal_sequence", "control_flags_json", "state", "created_at", "updated_at"],
});

// Table-level uniqueness that routing, replay and ordering depend on. These
// live inside CREATE TABLE, so a table without them cannot be repaired here.
const requiredUnique = Object.freeze({
  personal_agent_conversations: [["id"]],
  personal_agent_messages: [["id"], ["event_id"], ["conversation_id", "actor_user_id", "idempotency_key"], ["conversation_id", "causal_sequence"]],
  personal_agent_reasoning_inbox: [["id"], ["message_id"], ["conversation_id", "causal_sequence"]],
});

// Canonical conversation routing relies on these partial unique indexes. An
// existing index is trusted by its definition, never by its name alone.
const canonicalIndexes = Object.freeze([
  {
    name: "personal_agent_conversations_global",
    columns: ["scope_kind"],
    predicate: ["scope_kind", "=", "'global'"],
    create: `create unique index personal_agent_conversations_global
      on personal_agent_conversations(scope_kind) where scope_kind = 'global'`,
    duplicates: "select 1 from personal_agent_conversations where scope_kind = 'global' group by scope_kind having count(*) > 1 limit 1",
  },
  {
    name: "personal_agent_conversations_project",
    columns: ["project_id"],
    predicate: ["scope_kind", "=", "'project'"],
    create: `create unique index personal_agent_conversations_project
      on personal_agent_conversations(project_id) where scope_kind = 'project'`,
    duplicates: "select 1 from personal_agent_conversations where scope_kind = 'project' group by project_id having count(*) > 1 limit 1",
  },
]);

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function tables(db) {
  return new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
}

function columnsOf(db, table) {
  return new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
}

// Key columns with their collation. Identity uses BINARY comparison, so a
// NOCASE (or any other) key changes which values count as duplicates.
function indexKeys(db, name) {
  return db.prepare(`pragma index_xinfo(${literal(name)})`).all()
    .filter((row) => row.key === 1).sort((a, b) => a.seqno - b.seqno)
    .map((row) => ({ name: row.name, binary: String(row.coll || "").toUpperCase() === "BINARY" }));
}

function uniqueIndexes(db, table) {
  return db.prepare(`pragma index_list(${table})`).all()
    .filter((index) => index.unique === 1)
    .map((index) => ({ name: index.name, partial: index.partial === 1, keys: indexKeys(db, index.name) }));
}

// SQL tokens with string literals kept byte-exact ('GLOBAL' is not
// 'global' under BINARY); identifiers and keywords are case-folded.
function sqlTokens(sql) {
  const text = String(sql || "");
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const j = text.indexOf(close, i + 1);
      tokens.push(text.slice(i + 1, j < 0 ? text.length : j).toLowerCase());
      i = j < 0 ? text.length : j + 1;
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push(text.slice(i, j).toLowerCase());
      i = j;
    } else {
      const pair = text.slice(i, i + 2);
      const operator = ["==", "!=", "<>", "<=", ">=", "||"].includes(pair) ? pair : c;
      tokens.push(operator === "==" ? "=" : operator);
      i += operator.length;
    }
  }
  return tokens;
}

function predicateTokens(sql) {
  const tokens = sqlTokens(sql);
  const where = tokens.indexOf("where");
  return where < 0 ? [] : tokens.slice(where + 1);
}

// missing | valid | invalid (ours, repairable) | foreign (another table's; never touched)
function canonicalIndexState(db, spec) {
  const row = db.prepare("select tbl_name, sql from sqlite_master where type = 'index' and name = ?").get(spec.name);
  if (!row) return "missing";
  if (row.tbl_name !== "personal_agent_conversations") return "foreign";
  const listed = db.prepare("pragma index_list(personal_agent_conversations)").all().find((index) => index.name === spec.name);
  const keys = indexKeys(db, spec.name);
  const valid = listed?.unique === 1 && listed.partial === 1 && keys.every((key) => key.binary)
    && keys.map((key) => key.name).join(",") === spec.columns.join(",")
    && JSON.stringify(predicateTokens(row.sql)) === JSON.stringify(spec.predicate);
  return valid ? "valid" : "invalid";
}

function inspect(db) {
  const present = tables(db);
  const anyPresent = tableNames.some((name) => present.has(name));
  const missingTables = tableNames.filter((name) => !present.has(name));
  const missingColumns = Object.fromEntries(tableNames.map((table) => {
    const columns = present.has(table) ? columnsOf(db, table) : new Set();
    return [table, requiredColumns[table].filter((name) => !columns.has(name))];
  }));
  const missingConstraints = [];
  for (const table of tableNames.filter((name) => present.has(name))) {
    const unique = uniqueIndexes(db, table)
      .filter((index) => !index.partial && index.keys.every((key) => key.name && key.binary))
      .map((index) => index.keys.map((key) => key.name).sort().join(","));
    for (const columns of requiredUnique[table]) {
      if (!unique.includes([...columns].sort().join(","))) missingConstraints.push(`${table}(${columns.join(",")})`);
    }
  }
  const states = new Map(canonicalIndexes.map((spec) => [spec.name, canonicalIndexState(db, spec)]));
  const foreignIndexes = canonicalIndexes.filter((spec) => states.get(spec.name) === "foreign").map((spec) => spec.name);
  const conversations = present.has("personal_agent_conversations") && missingColumns.personal_agent_conversations.length === 0;
  const invalidIndexes = conversations ? canonicalIndexes.filter((spec) => states.get(spec.name) === "invalid").map((spec) => spec.name) : [];
  // Any index still to be (re)built must not meet duplicate data it would reject.
  const duplicateConflicts = conversations
    ? canonicalIndexes.filter((spec) => states.get(spec.name) !== "valid" && db.prepare(spec.duplicates).get()).map((spec) => spec.name)
    : [];
  const structural = foreignIndexes.length === 0 && (!anyPresent || (missingTables.length === 0
    && Object.values(missingColumns).every((names) => names.length === 0) && missingConstraints.length === 0));
  return { missingTables, missingColumns, missingConstraints, invalidIndexes, foreignIndexes, duplicateConflicts, structural };
}

export function planPersonalAgentIngressMigration(db) {
  const state = inspect(db);
  return {
    migrationId: PERSONAL_AGENT_INGRESS_MIGRATION_ID,
    dryRun: true,
    missingTables: state.missingTables,
    missingColumns: Object.fromEntries(Object.entries(state.missingColumns).map(([table, names]) => [table, tables(db).has(table) ? names : [...requiredColumns[table]]])),
    missingConstraints: state.missingConstraints,
    invalidIndexes: state.invalidIndexes,
    foreignIndexes: state.foreignIndexes,
    duplicateConflicts: state.duplicateConflicts,
    schemaCompatible: state.structural && state.duplicateConflicts.length === 0,
  };
}

function assertMigratable(state) {
  if (state.duplicateConflicts.length) throw new Error("personal_agent_ingress_duplicate_conversations");
  if (!state.structural) throw new Error("personal_agent_ingress_schema_incompatible");
}

export function migratePersonalAgentIngress(db, { dryRun = true } = {}) {
  const plan = planPersonalAgentIngressMigration(db);
  if (dryRun) return plan;
  assertMigratable(inspect(db));

  db.exec("begin immediate");
  try {
    assertMigratable(inspect(db));
    db.exec(`create table if not exists personal_agent_conversations (
      id text primary key,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      project_id text references personal_agent_projects(id) on delete restrict,
      next_causal_sequence integer not null default 1 check (next_causal_sequence > 0),
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'global' and project_id is null) or (scope_kind = 'project' and project_id is not null))
    )`);
    // Replace a wrong-definition namesake; duplicates were refused above, and
    // the transaction restores the original index if anything fails.
    for (const spec of canonicalIndexes) {
      const state = canonicalIndexState(db, spec);
      if (state === "invalid") db.exec(`drop index ${spec.name}`);
      if (state === "invalid" || state === "missing") db.exec(spec.create);
    }
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
    const after = inspect(db);
    if (!after.structural || after.invalidIndexes.length || canonicalIndexes.some((spec) => canonicalIndexState(db, spec) !== "valid")) {
      throw new Error("personal_agent_ingress_schema_incompatible");
    }
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  }
  return { ...plan, dryRun: false, missingTables: [], missingColumns: Object.fromEntries(tableNames.map((name) => [name, []])), missingConstraints: [], invalidIndexes: [], foreignIndexes: [], duplicateConflicts: [] };
}
