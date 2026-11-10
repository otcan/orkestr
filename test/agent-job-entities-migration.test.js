import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import {
  migratePersonalAgentEntities,
  migratePersonalAgentTaskLifecycle,
  planPersonalAgentEntityMigration,
} from "../packages/core/src/agent-job-entities-migration.js";

test("Personal Agent entity migration dry-runs, applies, and reruns idempotently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const plan = planPersonalAgentEntityMigration(db);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.missingTables, ["personal_agent_projects", "personal_agent_tasks"]);
    assert.deepEqual(db.prepare("select name from sqlite_master where type = 'table'").all(), []);

    const applied = migratePersonalAgentEntities(db, { dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.deepEqual(applied.missingTables, []);
    assert.deepEqual(planPersonalAgentEntityMigration(db).missingTables, []);
    assert.doesNotThrow(() => migratePersonalAgentEntities(db, { dryRun: false }));
    assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 2);

    db.prepare(`insert into personal_agent_projects (id, idempotency_key, title, created_at, updated_at)
      values ('prj_fixture', 'project-request-1', 'Sanitized sample', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`insert into personal_agent_tasks (id, project_id, idempotency_key, title, outcome, created_at, updated_at)
      values ('tsk_fixture', 'prj_fixture', 'task-request-1', 'Check fixture', 'Verified result', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    assert.throws(() => db.prepare(`insert into personal_agent_tasks
      (id, project_id, title, outcome, state, created_at, updated_at)
      values ('tsk_invalid', 'prj_fixture', 'Invalid', 'Nope', 'done', 'now', 'now')`).run(), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test("failed partial migration rolls back DDL without deleting the incompatible table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("create table personal_agent_tasks (legacy_marker text)");
    assert.throws(() => migratePersonalAgentEntities(db, { dryRun: false }));
    const names = db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name);
    assert.deepEqual(names, ["personal_agent_tasks"]);
    assert.deepEqual(db.prepare("pragma table_info(personal_agent_tasks)").all().map((row) => row.name), ["legacy_marker"]);
    const lifecyclePlan = migratePersonalAgentTaskLifecycle(db);
    assert.ok(lifecyclePlan.missingRequiredColumns.includes("id"));
    assert.throws(() => migratePersonalAgentTaskLifecycle(db, { dryRun: false }), /personal_agent_task_lifecycle_schema_incompatible/);
    assert.deepEqual(db.prepare("pragma table_info(personal_agent_tasks)").all().map((row) => row.name), ["legacy_marker"]);
  } finally {
    db.close();
  }
});

test("migration preserves sanitized legacy Agent Job records and old-schema reads", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table runs (id text primary key, job text not null, state text not null, created_at text not null);
      create table effects (effect_key text primary key, run_id text not null, state text not null);
      create table approvals (id text primary key, run_id text not null, state text not null);
      insert into runs values ('run_fixture', 'sample-job', 'running', '2026-01-01T00:00:00.000Z');
      insert into effects values ('effect_fixture', 'run_fixture', 'completed');
      insert into approvals values ('approval_fixture', 'run_fixture', 'approved');
    `);

    const before = {
      runs: db.prepare("select id, job, state from runs").all(),
      effects: db.prepare("select effect_key, run_id, state from effects").all(),
      approvals: db.prepare("select id, run_id, state from approvals").all(),
    };
    migratePersonalAgentEntities(db, { dryRun: false });
    const after = {
      runs: db.prepare("select id, job, state from runs").all(),
      effects: db.prepare("select effect_key, run_id, state from effects").all(),
      approvals: db.prepare("select id, run_id, state from approvals").all(),
    };
    assert.deepEqual(after, before);
    assert.equal(db.prepare("select count(*) as count from personal_agent_projects").get().count, 0);
    assert.equal(db.prepare("select count(*) as count from personal_agent_tasks").get().count, 0);
  } finally {
    db.close();
  }
});

test("task lifecycle migration upgrades an existing task table additively and reruns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migratePersonalAgentEntities(db, { dryRun: false });
    db.exec(`insert into personal_agent_projects (id, title, created_at, updated_at) values ('prj_old', 'Old', 'now', 'now');
      insert into personal_agent_tasks (id, project_id, title, outcome, created_at, updated_at) values ('tsk_old', 'prj_old', 'Old task', 'Outcome', 'now', 'now')`);
    const dryRun = migratePersonalAgentTaskLifecycle(db);
    assert.deepEqual(dryRun.missingColumns, ["contract_json", "completion_json"]);
    assert.equal(dryRun.transitionTablePresent, false);
    migratePersonalAgentTaskLifecycle(db, { dryRun: false });
    migratePersonalAgentTaskLifecycle(db, { dryRun: false });
    assert.deepEqual({ ...db.prepare("select id, state, contract_json, completion_json from personal_agent_tasks").get() }, {
      id: "tsk_old", state: "queued", contract_json: "{}", completion_json: null,
    });
    assert.equal(db.prepare("select count(*) as count from personal_agent_task_transitions").get().count, 0);
  } finally {
    db.close();
  }
});

test("Agent Job store leaves its schema unchanged while the Personal Agent feature is off", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-migration-off-"));
  try {
    const db = await openAgentJobDb({ ORKESTR_HOME: home });
    assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 0);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("turning on the feature migrates an already-open Agent Job store", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-migration-toggle-"));
  try {
    const disabled = await openAgentJobDb({ ORKESTR_HOME: home });
    assert.equal(disabled.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 0);
    const enabled = await openAgentJobDb({ ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "true" });
    assert.equal(enabled, disabled);
    assert.deepEqual(enabled.prepare("select name from sqlite_master where type = 'table' and name like 'personal_agent_%' order by name").all().map((row) => row.name), ["personal_agent_conversations", "personal_agent_event_outbox", "personal_agent_memories", "personal_agent_messages", "personal_agent_projects", "personal_agent_reasoning_inbox", "personal_agent_sessions", "personal_agent_task_transitions", "personal_agent_tasks"]);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Agent Job store creates and reopens the additive entity schema", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-migration-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const first = await openAgentJobDb(env);
    assert.equal(first.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'personal_agent_projects'").get().count, 1);
    assert.equal(first.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'personal_agent_tasks'").get().count, 1);
    await closeAgentJobDbs();

    const reopened = await openAgentJobDb(env);
    assert.deepEqual(reopened.prepare("select name from sqlite_master where type = 'table' and name like 'personal_agent_%' order by name").all().map((row) => row.name), [
      "personal_agent_conversations",
      "personal_agent_event_outbox",
      "personal_agent_memories",
      "personal_agent_messages",
      "personal_agent_projects",
      "personal_agent_reasoning_inbox",
      "personal_agent_sessions",
      "personal_agent_task_transitions",
      "personal_agent_tasks",
    ]);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});
