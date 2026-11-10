import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeAgentJobDbs } from "../packages/core/src/agent-job-store.js";
import { dispatchPersonalAgentEvents } from "../packages/core/src/personal-agent-events.js";
import { acceptPersonalAgentMessage } from "../packages/core/src/personal-agent-ingress.js";
import {
  migratePersonalAgentIngress,
  planPersonalAgentIngressMigration,
} from "../packages/core/src/personal-agent-ingress-migration.js";

// Existing ingress objects are trusted by definition, never by name alone.
// Synthetic in-memory schemas only.

function freshDb(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Minimal parents for the ingress foreign keys.
  db.exec("create table personal_agent_projects (id text primary key); create table personal_agent_tasks (id text primary key); create table runs (id text primary key)");
  db.exec("insert into personal_agent_projects (id) values ('prj_a')");
  return db;
}

function migrated(t) {
  const db = freshDb(t);
  migratePersonalAgentIngress(db, { dryRun: false });
  return db;
}

function insertConversation(db, id, scopeKind = "global", projectId = null) {
  db.prepare(`insert into personal_agent_conversations (id, scope_kind, project_id, next_causal_sequence, created_at, updated_at)
    values (?, ?, ?, 1, 'now', 'now')`).run(id, scopeKind, projectId);
}

function indexSql(db, name) {
  return db.prepare("select sql from sqlite_master where type = 'index' and name = ?").get(name)?.sql || null;
}

const replacements = {
  "non-unique namesake": "create index personal_agent_conversations_global on personal_agent_conversations(scope_kind)",
  "unique on the wrong column": "create unique index personal_agent_conversations_global on personal_agent_conversations(id) where scope_kind = 'global'",
  "unique without the global predicate": "create unique index personal_agent_conversations_global on personal_agent_conversations(scope_kind, id)",
  // Literals compare under BINARY: neither of these matches 'global' rows.
  "uppercase-literal": "create unique index personal_agent_conversations_global on personal_agent_conversations(scope_kind) where scope_kind = 'GLOBAL'",
  "spaced-literal": "create unique index personal_agent_conversations_global on personal_agent_conversations(scope_kind) where scope_kind = 'g l o b a l'",
  "case-insensitive": "create unique index personal_agent_conversations_global on personal_agent_conversations(scope_kind collate nocase) where scope_kind = 'global'",
};

for (const [label, replacement] of Object.entries(replacements)) {
  test(`a ${label} global index is reported and repaired, so only one global conversation can exist`, (t) => {
    const db = migrated(t);
    db.exec("drop index personal_agent_conversations_global");
    db.exec(replacement);
    const plan = planPersonalAgentIngressMigration(db);
    assert.deepEqual(plan.invalidIndexes, ["personal_agent_conversations_global"]);
    assert.deepEqual(plan.duplicateConflicts, []);
    migratePersonalAgentIngress(db, { dryRun: false });
    assert.deepEqual(planPersonalAgentIngressMigration(db).invalidIndexes, []);
    insertConversation(db, "pac_one");
    assert.throws(() => insertConversation(db, "pac_two"), /UNIQUE constraint failed/);
  });
}

test("a project index with the wrong predicate is repaired to one conversation per project", (t) => {
  const db = migrated(t);
  db.exec("drop index personal_agent_conversations_project");
  db.exec("create unique index personal_agent_conversations_project on personal_agent_conversations(project_id) where scope_kind = 'global'");
  assert.deepEqual(planPersonalAgentIngressMigration(db).invalidIndexes, ["personal_agent_conversations_project"]);
  migratePersonalAgentIngress(db, { dryRun: false });
  insertConversation(db, "pac_p1", "project", "prj_a");
  assert.throws(() => insertConversation(db, "pac_p2", "project", "prj_a"), /UNIQUE constraint failed/);
});

test("pre-existing duplicate globals fail explicitly and leave data and schema untouched", (t) => {
  const db = migrated(t);
  db.exec("drop index personal_agent_conversations_global");
  db.exec(replacements["non-unique namesake"]);
  insertConversation(db, "pac_one");
  insertConversation(db, "pac_two");
  const before = indexSql(db, "personal_agent_conversations_global");
  const plan = planPersonalAgentIngressMigration(db);
  assert.equal(plan.schemaCompatible, false);
  assert.deepEqual(plan.duplicateConflicts, ["personal_agent_conversations_global"]);
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_duplicate_conversations" });
  assert.deepEqual(db.prepare("select id from personal_agent_conversations order by id").all().map((row) => row.id), ["pac_one", "pac_two"]);
  assert.equal(indexSql(db, "personal_agent_conversations_global"), before, "the failed repair rolls back");
});

test("a dropped mandatory global index with duplicates fails explicitly instead of a raw constraint error", (t) => {
  const db = migrated(t);
  db.exec("drop index personal_agent_conversations_global");
  insertConversation(db, "pac_one");
  insertConversation(db, "pac_two");
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_duplicate_conversations" });
  assert.equal(indexSql(db, "personal_agent_conversations_global"), null);
});

test("a message table without its idempotency uniqueness is incompatible, not silently accepted", (t) => {
  const db = migrated(t);
  db.exec("pragma foreign_keys = OFF");
  db.exec("drop table personal_agent_reasoning_inbox");
  db.exec("drop table personal_agent_messages");
  db.exec(`create table personal_agent_messages (id text primary key, conversation_id text not null, actor_user_id text not null,
    actor_origin text not null, channel text not null, idempotency_key text not null, payload_hash text not null, body text not null,
    task_id text, run_id text, event_id text not null unique, event_cursor text not null, causal_sequence integer not null,
    created_at text not null, unique (conversation_id, causal_sequence))`);
  const plan = planPersonalAgentIngressMigration(db);
  assert.equal(plan.schemaCompatible, false);
  assert.deepEqual(plan.incompatibleTables, ["personal_agent_messages"]);
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_schema_incompatible" });
});

test("a valid schema plans no repairs and stays byte-identical on re-apply", (t) => {
  const db = migrated(t);
  const schema = () => db.prepare("select type, name, sql from sqlite_master order by type, name").all();
  const before = schema();
  const plan = planPersonalAgentIngressMigration(db);
  assert.deepEqual([plan.schemaCompatible, plan.invalidIndexes, plan.incompatibleTables, plan.duplicateConflicts], [true, [], [], []]);
  migratePersonalAgentIngress(db, { dryRun: false });
  assert.deepEqual(schema(), before);
});

test("the maximum client idempotency key is accepted and replays to the same receipt", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pa-ingress-key-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  t.after(async () => {
    // Settle queued event dispatch before removing its home.
    await dispatchPersonalAgentEvents(env);
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  const owner = { orkestrPrincipal: { kind: "user", userId: "owner-fixture", role: "admin" } };
  const input = { scope: { kind: "global" }, message: "fixture message", idempotencyKey: "k".repeat(512) };
  const first = await acceptPersonalAgentMessage(owner, input, env);
  assert.equal(first.accepted, true);
  const replay = await acceptPersonalAgentMessage(owner, input, env);
  assert.equal(replay.replayed, true);
  assert.equal(replay.inboxItemId, first.inboxItemId);
  await assert.rejects(() => acceptPersonalAgentMessage(owner, { ...input, idempotencyKey: "k".repeat(513) }, env),
    { code: "personal_agent_ingress_idempotency_required" });
});

test("a differently spelled equivalent index is rebuilt to the canonical definition", (t) => {
  const canonicalSql = indexSql(migrated(t), "personal_agent_conversations_global");
  const db = migrated(t);
  db.exec("drop index personal_agent_conversations_global");
  db.exec(`CREATE UNIQUE INDEX "personal_agent_conversations_global" ON personal_agent_conversations ( "scope_kind" COLLATE BINARY )
    WHERE   "Scope_Kind"='global'`);
  assert.deepEqual(planPersonalAgentIngressMigration(db).invalidIndexes, ["personal_agent_conversations_global"]);
  migratePersonalAgentIngress(db, { dryRun: false });
  assert.equal(indexSql(db, "personal_agent_conversations_global"), canonicalSql);
});

test("a case-insensitive project index is repaired so case-distinct projects keep separate conversations", (t) => {
  const db = migrated(t);
  db.exec("insert into personal_agent_projects (id) values ('case-sensitive'), ('CASE-SENSITIVE')");
  db.exec("drop index personal_agent_conversations_project");
  db.exec("create unique index personal_agent_conversations_project on personal_agent_conversations(project_id collate nocase) where scope_kind = 'project'");
  assert.deepEqual(planPersonalAgentIngressMigration(db).invalidIndexes, ["personal_agent_conversations_project"]);
  migratePersonalAgentIngress(db, { dryRun: false });
  insertConversation(db, "pac_lower", "project", "case-sensitive");
  insertConversation(db, "pac_upper", "project", "CASE-SENSITIVE");
  assert.throws(() => insertConversation(db, "pac_again", "project", "case-sensitive"), /UNIQUE constraint failed/);
});

test("a case-insensitive replay identity constraint is incompatible", (t) => {
  const db = migrated(t);
  db.exec("pragma foreign_keys = OFF");
  db.exec("drop table personal_agent_reasoning_inbox");
  db.exec("drop table personal_agent_messages");
  db.exec(`create table personal_agent_messages (id text primary key, conversation_id text not null, actor_user_id text not null,
    actor_origin text not null, channel text not null, idempotency_key text not null collate nocase, payload_hash text not null, body text not null,
    task_id text, run_id text, event_id text not null unique, event_cursor text not null, causal_sequence integer not null,
    created_at text not null, unique (conversation_id, actor_user_id, idempotency_key), unique (conversation_id, causal_sequence))`);
  const plan = planPersonalAgentIngressMigration(db);
  assert.equal(plan.schemaCompatible, false);
  assert.deepEqual(plan.incompatibleTables, ["personal_agent_messages"]);
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_schema_incompatible" });
});

test("a namesake index owned by another table fails closed and is never dropped", (t) => {
  const db = migrated(t);
  db.exec("drop index personal_agent_conversations_global");
  db.exec("create table unrelated_fixture (id text)");
  db.exec("create unique index personal_agent_conversations_global on unrelated_fixture(id)");
  const before = indexSql(db, "personal_agent_conversations_global");
  const plan = planPersonalAgentIngressMigration(db);
  assert.equal(plan.schemaCompatible, false);
  assert.deepEqual(plan.foreignIndexes, ["personal_agent_conversations_global"]);
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_schema_incompatible" });
  assert.equal(indexSql(db, "personal_agent_conversations_global"), before);
  db.exec("insert into unrelated_fixture (id) values ('x')");
  assert.throws(() => db.exec("insert into unrelated_fixture (id) values ('x')"), /UNIQUE constraint failed/);
});

// Worker 2 round 3: shapes that defeat any parsed notion of equivalence.
function recreate(db, table, ddl) {
  db.exec("pragma foreign_keys = OFF");
  if (table === "personal_agent_messages") db.exec("drop table personal_agent_reasoning_inbox");
  if (table === "personal_agent_conversations") {
    db.exec("drop table personal_agent_reasoning_inbox");
    db.exec("drop table personal_agent_messages");
  }
  db.exec(`drop table ${table}`);
  db.exec(ddl);
}

function refusesUnchanged(db) {
  const schema = () => db.prepare("select type, name, sql from sqlite_master order by type, name").all();
  const before = schema();
  assert.equal(planPersonalAgentIngressMigration(db).schemaCompatible, false);
  assert.throws(() => migratePersonalAgentIngress(db, { dryRun: false }), { message: "personal_agent_ingress_schema_incompatible" });
  assert.deepEqual(schema(), before, "a refused migration changes nothing");
}

test("a quoted-identifier predicate cannot impersonate the 'global' literal", (t) => {
  const db = migrated(t);
  db.exec(`alter table personal_agent_conversations add column "'global'" text`);
  db.exec("drop index personal_agent_conversations_global");
  db.exec(`create unique index personal_agent_conversations_global on personal_agent_conversations(scope_kind) where scope_kind = "'global'"`);
  assert.deepEqual(planPersonalAgentIngressMigration(db).incompatibleTables, ["personal_agent_conversations"]);
  refusesUnchanged(db);
});

test("a NOCASE project column is refused even with an explicitly BINARY index", (t) => {
  const db = migrated(t);
  recreate(db, "personal_agent_conversations", `create table personal_agent_conversations (id text primary key,
    scope_kind text not null check (scope_kind in ('global', 'project')), project_id text collate nocase references personal_agent_projects(id),
    next_causal_sequence integer not null default 1, created_at text not null, updated_at text not null)`);
  db.exec("create unique index personal_agent_conversations_project on personal_agent_conversations(project_id collate binary) where scope_kind = 'project'");
  assert.deepEqual(planPersonalAgentIngressMigration(db).incompatibleTables, ["personal_agent_conversations"]);
  refusesUnchanged(db);
});

test("a NOCASE idempotency column is refused even with an explicitly BINARY unique constraint", (t) => {
  const db = migrated(t);
  recreate(db, "personal_agent_messages", `create table personal_agent_messages (id text primary key, conversation_id text not null,
    actor_user_id text not null, actor_origin text not null, channel text not null, idempotency_key text not null collate nocase,
    payload_hash text not null, body text not null, task_id text, run_id text, event_id text not null unique, event_cursor text not null,
    causal_sequence integer not null, created_at text not null,
    unique (conversation_id, actor_user_id, idempotency_key collate binary), unique (conversation_id, causal_sequence))`);
  assert.ok(planPersonalAgentIngressMigration(db).incompatibleTables.includes("personal_agent_messages"));
  refusesUnchanged(db);
});

test("a single column named like the joined replay key does not stand in for the composite constraint", (t) => {
  const db = migrated(t);
  recreate(db, "personal_agent_messages", `create table personal_agent_messages (id text primary key, conversation_id text not null,
    actor_user_id text not null, actor_origin text not null, channel text not null, idempotency_key text not null,
    payload_hash text not null, body text not null, task_id text, run_id text, event_id text not null unique, event_cursor text not null,
    causal_sequence integer not null, created_at text not null, "actor_user_id,conversation_id,idempotency_key" text unique,
    unique (conversation_id, causal_sequence))`);
  assert.ok(planPersonalAgentIngressMigration(db).incompatibleTables.includes("personal_agent_messages"));
  refusesUnchanged(db);
});
