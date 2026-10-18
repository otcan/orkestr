import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migratePersonalAgentEntities } from "../packages/core/src/agent-job-entities-migration.js";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import {
  migratePersonalAgentMemory,
  planPersonalAgentMemoryMigration,
} from "../packages/core/src/personal-agent-memory-migration.js";

test("memory migration dry-runs without writes, then applies and reruns idempotently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const emptyPlan = planPersonalAgentMemoryMigration(db);
    assert.equal(emptyPlan.prerequisiteMissing, true);
    assert.deepEqual(db.prepare("select name from sqlite_master where type = 'table'").all(), []);

    migratePersonalAgentEntities(db, { dryRun: false });
    const plan = migratePersonalAgentMemory(db);
    assert.equal(plan.prerequisiteMissing, false);
    assert.equal(plan.tablePresent, false);
    assert.deepEqual(plan.missingColumns, [
      "id", "idempotency_key", "category", "scope_kind", "scope_id", "content_json",
      "provenance_json", "source_event_id", "source_cursor", "consented_by", "consented_at",
      "created_at", "updated_at",
    ]);
    assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'personal_agent_memories'").get().count, 0);

    const applied = migratePersonalAgentMemory(db, { dryRun: false });
    assert.equal(applied.tablePresent, true);
    assert.equal(applied.indexPresent, true);
    const columns = db.prepare("pragma table_info(personal_agent_memories)").all().map((row) => row.name);
    assert.deepEqual(columns, [
      "id", "idempotency_key", "category", "scope_kind", "scope_id", "content_json",
      "provenance_json", "source_event_id", "source_cursor", "consented_by", "consented_at",
      "created_at", "updated_at",
    ]);
    const before = db.prepare("select name, sql from sqlite_master where name like 'personal_agent_memories%'").all().map((row) => ({ ...row }));
    assert.deepEqual(migratePersonalAgentMemory(db, { dryRun: false }).missingColumns, []);
    assert.deepEqual(db.prepare("select name, sql from sqlite_master where name like 'personal_agent_memories%'").all().map((row) => ({ ...row })), before);
  } finally {
    db.close();
  }
});

test("memory constraints enforce categories, scope pairing, project summaries, and project references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("pragma foreign_keys = on");
    migratePersonalAgentEntities(db, { dryRun: false });
    migratePersonalAgentMemory(db, { dryRun: false });
    db.prepare(`insert into personal_agent_projects (id, title, created_at, updated_at)
      values ('prj_sample', 'Synthetic project', 'now', 'now')`).run();
    const insert = db.prepare(`insert into personal_agent_memories
      (id, category, scope_kind, scope_id, content_json, provenance_json, consented_by, consented_at, created_at, updated_at)
      values (?, ?, ?, ?, '{}', '{}', 'owner-fixture', 'now', 'now', 'now')`);
    insert.run("mem_owner", "preference", "owner", null);
    insert.run("mem_project", "project_summary", "project", "prj_sample");
    assert.throws(() => insert.run("mem_bad_category", "other", "owner", null), /CHECK constraint failed/);
    assert.throws(() => insert.run("mem_bad_scope", "fact", "owner", "prj_sample"), /CHECK constraint failed/);
    assert.throws(() => insert.run("mem_bad_summary", "project_summary", "owner", null), /CHECK constraint failed/);
    assert.throws(() => insert.run("mem_missing_project", "fact", "project", "prj_missing"), /FOREIGN KEY constraint failed/);
  } finally {
    db.close();
  }
});

test("incompatible pre-existing memory schema fails closed without changing it", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migratePersonalAgentEntities(db, { dryRun: false });
    db.exec("create table personal_agent_memories (legacy_marker text)");
    const plan = planPersonalAgentMemoryMigration(db);
    assert.equal(plan.tablePresent, true);
    assert.ok(plan.missingColumns.includes("category"));
    assert.throws(() => migratePersonalAgentMemory(db, { dryRun: false }), {
      message: "personal_agent_memory_schema_incompatible",
    });
    assert.deepEqual(db.prepare("pragma table_info(personal_agent_memories)").all().map((row) => row.name), ["legacy_marker"]);
  } finally {
    db.close();
  }
});

test("feature-off leaves memory absent; enabling an already-open store adds it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-memory-migration-toggle-"));
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  const off = await openAgentJobDb({ ORKESTR_HOME: home });
  assert.equal(off.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 0);
  const on = await openAgentJobDb({ ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  assert.equal(on, off);
  assert.deepEqual(on.prepare("select name from sqlite_master where type = 'table' and name like 'personal_agent_%' order by name").all().map((row) => row.name), ["personal_agent_conversations", "personal_agent_event_outbox", "personal_agent_memories", "personal_agent_messages", "personal_agent_projects", "personal_agent_reasoning_inbox", "personal_agent_sessions", "personal_agent_task_transitions", "personal_agent_tasks"]);
});

test("disabling the feature after migration preserves old Agent Job reads and memory data", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-memory-migration-rollback-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "true" };
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  const enabled = await openAgentJobDb(env);
  enabled.prepare(`insert into personal_agent_projects (id, title, created_at, updated_at)
    values ('prj_keep', 'Keep', 'now', 'now')`).run();
  enabled.prepare(`insert into personal_agent_memories
    (id, category, scope_kind, content_json, provenance_json, consented_by, consented_at, created_at, updated_at)
    values ('mem_keep', 'preference', 'owner', '{"theme":"compact"}', '{}', 'owner-fixture', 'now', 'now', 'now')`).run();
  await closeAgentJobDbs();

  const disabled = await openAgentJobDb({ ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "0" });
  assert.equal(disabled.prepare("select count(*) as count from personal_agent_memories where id = 'mem_keep'").get().count, 1);
  assert.equal(disabled.prepare("select count(*) as count from jobs").get().count, 0);
  assert.equal(disabled.prepare("select count(*) as count from personal_agent_memories").get().count, 1);
});
