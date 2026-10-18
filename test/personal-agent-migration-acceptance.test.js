import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { getRunAudit } from "../packages/core/src/agent-job-audit.js";
import { migratePersonalAgentEntities } from "../packages/core/src/agent-job-entities-migration.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { closeAgentJobDbs, getRun, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { fixtureSpec, offlineFixture } from "./fixtures/personal-agent-acceptance/fixtures.mjs";

const entityTables = ["personal_agent_projects", "personal_agent_tasks"];
const schema = (db) => db.prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type, name").all();
const tables = (db) => db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all().map(({ name }) => name);
const rows = (db, names) => Object.fromEntries(names.map((name) => [name,
  db.prepare(`select * from "${name.replaceAll('"', '""')}" order by rowid`).all(),
]));
const assertIntegrity = (db) => {
  assert.equal(db.prepare("pragma integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
};

async function seedLegacyEvidence(env) {
  const completed = await admitRun({ dedupeKey: "fixture-completed", spec: fixtureSpec({
    name: "migration-completed", script: [{ output: { summary: "Verified synthetic legacy record." } }],
  }) }, env);
  assert.equal((await driveRun(completed.run.id, {}, env)).state, "succeeded");
  const pending = await admitRun({ dedupeKey: "fixture-pending", spec: fixtureSpec({
    name: "migration-pending", tools: { approval_required: ["demo.pull_request.create"] },
    script: [{ tool: "demo.pull_request.create", args: { repository: "example/repository", head: "fixture", title: "Fixture only" } }],
  }) }, env);
  assert.equal((await driveRun(pending.run.id, {}, env)).state, "awaiting_approval");
  return { completed: completed.run.id, pending: pending.run.id };
}

test("PA-R10 [OP-03 OP-24]: on-disk migration, flag-off rollback and backup restore retain legacy evidence and new links", async (t) => {
  const env = await offlineFixture(t);
  const runs = await seedLegacyEvidence(env);
  const audit = await getRunAudit(runs.completed, env);
  let db = await openAgentJobDb(env);
  const legacyTables = tables(db);
  assert.ok(!legacyTables.some((name) => entityTables.includes(name)), "flag-off legacy schema stays untouched");
  const legacy = rows(db, legacyTables);
  await closeAgentJobDbs(); // Flush/close WAL before copying the fixture database.
  const backup = path.join(env.ORKESTR_HOME, "before-migration.sqlite");
  await fs.copyFile(env.ORKESTR_AGENT_JOBS_DB, backup);
  const backupBytes = await fs.readFile(backup);

  const enabled = { ...env, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  db = await openAgentJobDb(enabled);
  assert.deepEqual(rows(db, legacyTables), legacy);
  const at = "2026-01-01T00:00:00.000Z";
  // Fixture inserts use Lane A's actual schema; no test-owned task store/API.
  db.prepare(`insert into personal_agent_projects (id, idempotency_key, title, goal, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)`).run("prj_fixture", "fixture-project", "Synthetic project", "Verify a fixture artifact", at, at);
  db.prepare(`insert into personal_agent_tasks
    (id, project_id, idempotency_key, title, outcome, acceptance_json, state, thread_id, run_id, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("tsk_fixture", "prj_fixture", "fixture-task", "Check artifact",
    "Report evidence", '["fixture digest matches"]', "blocked", "fixture-thread", runs.pending, at, at);
  const entities = rows(db, entityTables);
  const beforeRerun = rows(db, tables(db));
  const beforeSchema = schema(db);
  const schemaVersion = db.prepare("pragma schema_version").get().schema_version;
  for (let pass = 0; pass < 2; pass += 1) migratePersonalAgentEntities(db, { dryRun: false });
  assert.deepEqual(rows(db, tables(db)), beforeRerun);
  assert.deepEqual(schema(db), beforeSchema);
  assert.equal(db.prepare("pragma schema_version").get().schema_version, schemaVersion);
  assertIntegrity(db);

  await closeAgentJobDbs();
  db = await openAgentJobDb(env); // Supported feature-disable rollback, not an older binary.
  assert.deepEqual(rows(db, entityTables), entities);
  assert.deepEqual(rows(db, legacyTables), legacy);
  assert.deepEqual(await getRunAudit(runs.completed, env), audit);
  assert.equal((await getRun(runs.pending, env)).state, "awaiting_approval");
  const rollbackRun = await admitRun({ dedupeKey: "rollback-legacy-operation", spec: fixtureSpec() }, env);
  await closeAgentJobDbs();
  db = await openAgentJobDb(enabled);
  assert.deepEqual(rows(db, entityTables), entities);
  assert.equal((await getRun(rollbackRun.run.id, enabled)).state, "pending");
  assertIntegrity(db);
  await closeAgentJobDbs();

  // Restore into a DIFFERENT fixture home; never replace post-backup work.
  const restoreHome = path.join(env.ORKESTR_HOME, "restored-copy");
  await fs.mkdir(restoreHome);
  const restored = { ...enabled, ORKESTR_HOME: restoreHome, ORKESTR_AGENT_JOBS_DB: path.join(restoreHome, "agent-jobs.sqlite") };
  await fs.copyFile(backup, restored.ORKESTR_AGENT_JOBS_DB);
  db = await openAgentJobDb(restored);
  assert.deepEqual(rows(db, legacyTables), legacy);
  assert.deepEqual(await getRunAudit(runs.completed, restored), audit);
  assert.deepEqual(rows(db, entityTables), { personal_agent_projects: [], personal_agent_tasks: [] });
  assertIntegrity(db);
  assert.deepEqual(await fs.readFile(backup), backupBytes, "restore must not change the backup");
  const current = await openAgentJobDb(enabled);
  assert.deepEqual(rows(current, entityTables), entities, "restore must not erase later project/task work");
  assert.ok(await getRun(rollbackRun.run.id, enabled));
  assert.deepEqual((await fs.readdir(restoreHome)).filter((name) => name.endsWith(".sqlite")), ["agent-jobs.sqlite"]);
});

test("PA-R11 [OP-03 OP-24]: SIGKILL during the real migration rolls back partial DDL and reruns safely", async (t) => {
  const env = await offlineFixture(t);
  await seedLegacyEvidence(env);
  let db = await openAgentJobDb(env);
  const legacyTables = tables(db);
  const beforeRows = rows(db, legacyTables);
  const beforeSchema = schema(db);
  await closeAgentJobDbs();
  const worker = fileURLToPath(new URL("./fixtures/personal-agent-acceptance/migration-crash.mjs", import.meta.url));
  const crashed = spawnSync(process.execPath, [worker], {
    encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH || "", TMPDIR: os.tmpdir(), NODE_TEST_CONTEXT: "child", ...env },
  });
  assert.equal(crashed.error, undefined);
  assert.match(crashed.stdout, /fixture_ddl_applied_before_commit/);
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  db = await openAgentJobDb(env);
  assert.deepEqual(schema(db), beforeSchema, "uncommitted project/task DDL must not survive process death");
  assert.deepEqual(rows(db, legacyTables), beforeRows);
  assertIntegrity(db);
  await closeAgentJobDbs();
  db = await openAgentJobDb({ ...env, ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  assert.deepEqual(rows(db, legacyTables), beforeRows);
  assert.deepEqual(rows(db, entityTables), { personal_agent_projects: [], personal_agent_tasks: [] });
  assertIntegrity(db);
});
