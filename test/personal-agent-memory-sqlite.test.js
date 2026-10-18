import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { openPersonalAgentMemoryService, openPersonalAgentMemoryStore } from "../packages/core/src/personal-agent-memory-sqlite.js";
import { memoryInput, memoryOwnerRequest as owner, memorySource } from "./fixtures/personal-agent-memory-store.js";

const ownerUserId = "owner-fixture";
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-memory-sqlite-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  t.after(async () => { await closeAgentJobDbs(); await fs.rm(home, { recursive: true, force: true }); });
  const service = await openPersonalAgentMemoryService({ ownerUserId, env });
  const db = await openAgentJobDb(env);
  for (const id of ["project-alpha", "project-beta"]) db.prepare("insert into personal_agent_projects (id,title,created_at,updated_at) values (?,?,'now','now')").run(id, "Synthetic project");
  db.prepare("insert into personal_agent_tasks (id,project_id,title,outcome,created_at,updated_at) values ('task-alpha','project-alpha','Synthetic task','Fixture outcome','now','now')").run();
  return { env, db, service };
}
function save(service, input = memoryInput(), action = "remember") {
  const proposal = service.propose(input, owner);
  return service.create(proposal, owner, { action, digest: proposal.digest });
}
const childImports = `
import fs from 'node:fs';
import { openPersonalAgentMemoryService } from ${JSON.stringify(new URL("../packages/core/src/personal-agent-memory-sqlite.js", import.meta.url).href)};
import { memoryInput, memoryOwnerRequest as owner } from ${JSON.stringify(new URL("./fixtures/personal-agent-memory-store.js", import.meta.url).href)};
const service = await openPersonalAgentMemoryService({ownerUserId:'owner-fixture'});
`;
function child(env, code, extra = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", childImports + code], {
    env: { PATH: process.env.PATH, HOME: env.ORKESTR_HOME, ...env, ...extra }, encoding: "utf8", timeout: 20000,
  });
}
function childResult(env, code, extra) {
  const result = child(env, code, extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("SQLite binding uses Agent Job's migrated file and preserves legacy jobs and task lifecycle", async t => {
  const { env, db, service } = await setup(t);
  db.prepare("insert into job_specs values ('fixture-hash','fixture-job','{}','now')").run();
  db.prepare("insert into jobs values ('fixture-job','fixture-hash','fixture','now','now')").run();
  const before = db.prepare("select * from jobs").all();
  const schema = db.prepare("select name,sql from sqlite_master order by name").all();
  const record = save(service, memoryInput({ sourceEventId: "event-fixture", sourceCursor: "cursor-fixture" })).record;
  assert.equal(db.prepare("select id from personal_agent_memories").get().id, record.id);
  assert.equal(db.prepare("pragma database_list").get().file, path.join(env.ORKESTR_HOME, "agent-jobs.sqlite"));
  assert.equal(db.prepare("pragma synchronous").get().synchronous, 2);
  assert.deepEqual(db.prepare("select * from jobs").all(), before);
  assert.deepEqual(db.prepare("select name,sql from sqlite_master order by name").all(), schema);
  assert.ok(db.prepare("pragma table_info(personal_agent_tasks)").all().some(row => row.name === "completion_json"));
  assert.equal(db.prepare("select count(*) as n from personal_agent_task_transitions").get().n, 0);
  await closeAgentJobDbs();
  const fresh = await openPersonalAgentMemoryService({ ownerUserId, env });
  assert.deepEqual(fresh.retrieve({}, owner), [record]);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.export(owner))), childResult(env, "console.log(JSON.stringify(service.export(owner)));", { ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "different-synthetic-model" }));
});

test("committed owner consent survives abrupt writer death and a fresh process", async t => {
  const { env } = await setup(t);
  await closeAgentJobDbs();
  const writer = child(env, `const proposal=service.propose(memoryInput(),owner);
    const result=service.create(proposal,owner,{action:'remember',digest:proposal.digest});
    fs.writeSync(1, JSON.stringify(result.record)); process.kill(process.pid,'SIGKILL');`);
  assert.equal(writer.signal, "SIGKILL", writer.stderr);
  const written = JSON.parse(writer.stdout);
  const recovered = childResult(env, "console.log(JSON.stringify(service.export(owner)));", { ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "another-synthetic-model" });
  assert.deepEqual(recovered.records, [written]);
});

test("SQLite correction and forget persist without old content in logical records or export", async t => {
  const { env, db, service } = await setup(t);
  const first = save(service).record;
  const oldForget = service.proposeForget(first.id, owner);
  const correction = service.proposeCorrection(first.id, { content: { statement: "Corrected synthetic fact" }, source: memorySource }, owner);
  const corrected = childResult(env, `console.log(JSON.stringify(service.correct(${JSON.stringify(correction)},owner,{action:'correct',digest:${JSON.stringify(correction.digest)}})));`);
  const secondService = await openPersonalAgentMemoryService({ ownerUserId, env });
  assert.throws(() => secondService.correct(correction, owner, { action: "correct", digest: correction.digest }), /correction_stale/);
  assert.throws(() => secondService.forget(oldForget, owner, { action: "forget", digest: oldForget.digest }), /forget_stale/);
  assert.ok(!JSON.stringify(db.prepare("select * from personal_agent_memories").all()).includes("teal"));
  await closeAgentJobDbs();
  assert.deepEqual(childResult(env, "console.log(JSON.stringify(service.export(owner)));").records, [corrected]);
  const fresh = await openPersonalAgentMemoryService({ ownerUserId, env });
  const forget = fresh.proposeForget(first.id, owner);
  fresh.forget(forget, owner, { action: "forget", digest: forget.digest });
  await closeAgentJobDbs();
  assert.deepEqual(childResult(env, "console.log(JSON.stringify(service.export(owner)));").records, []);
  const reopened = await openAgentJobDb(env);
  assert.equal(reopened.prepare("select count(*) as n from personal_agent_memories").get().n, 0);
  // Logical deletion only: no claim about old WAL pages, backups or power loss.
});

test("SQLite project/task scoping and external evidence require exact owner consent", async t => {
  const { service, db } = await setup(t);
  const global = save(service).record;
  const project = save(service, memoryInput({ idempotencyKey: "project-fixture", scope: { kind: "project", id: "project-alpha" }, category: "open_loop", content: { summary: "Synthetic follow-up", taskId: "task-alpha" }, source: { ...memorySource, sourceKind: "worker", actorId: "worker-fixture" } }), "approve").record;
  save(service, memoryInput({ idempotencyKey: "other-project", scope: { kind: "project", id: "project-beta" } }));
  assert.deepEqual(service.retrieve({}, owner).map(row => row.id), [global.id]);
  assert.deepEqual(service.retrieve({ projectId: "project-alpha" }, owner).map(row => row.id), [project.id, global.id]);
  assert.throws(() => save(service, memoryInput({ idempotencyKey: "wrong-task", scope: { kind: "project", id: "project-beta" }, source: { ...memorySource, taskId: "task-alpha" } })), /task_scope_mismatch/);
  const untrusted = service.propose(memoryInput({ idempotencyKey: "no-consent", source: { ...memorySource, sourceKind: "web", actorId: "web-fixture" } }), owner);
  assert.throws(() => service.create(untrusted, owner, { action: "remember", digest: untrusted.digest }), /owner_confirmation_required/);
  assert.throws(() => service.export({ orkestrPrincipal: { ...owner.orkestrPrincipal, userId: "different-owner" } }), /owner_required/);
  const context = service.context({ projectId: "project-alpha", maxBytes: 2200 }, owner);
  assert.ok(context.bytes <= 2200); assert.ok(!context.text.includes("project-beta"));
  assert.equal(db.prepare("select count(*) as n from personal_agent_memories").get().n, 3);
});

test("SQLite transaction rollback, duplicate keys and expired transaction handles fail closed", async t => {
  const { env, db, service } = await setup(t);
  const first = save(service); assert.equal(save(service).deduplicated, true);
  const store = await openPersonalAgentMemoryStore({ ownerUserId, env });
  const row = db.prepare("select * from personal_agent_memories").get();
  assert.throws(() => store.transaction(tx => { tx.insert({ ...row, id: "rollback-fixture", idempotency_key: "rollback-fixture" }); throw Error("fixture_failure"); }), /fixture_failure/);
  assert.equal(db.prepare("select count(*) as n from personal_agent_memories").get().n, 1);
  assert.throws(() => store.transaction(tx => tx.insert({ ...row, id: "duplicate-key" })), error => error.message === "memory_storage_failure" && !error.message.includes("teal"));
  assert.deepEqual(service.retrieve({}, owner), [first.record]);
  let leaked;
  store.transaction(tx => { leaked = tx; });
  assert.throws(() => leaked.delete(row.id), /transaction_closed/);
  assert.throws(() => store.transaction(async () => {}), /must_be_synchronous/);
  assert.throws(() => store.transaction(tx => { tx.delete(row.id); return Promise.resolve(); }), /must_be_synchronous/);
  assert.equal(service.retrieve({}, owner).length, 1);
});

test("feature off opens no home and disabling a migrated store blocks access while preserving data", async t => {
  const { env, service } = await setup(t);
  const nonexistent = path.join(env.ORKESTR_HOME, "must-not-exist");
  await assert.rejects(openPersonalAgentMemoryStore({ ownerUserId, env: { ORKESTR_HOME: nonexistent } }), /personal_agent_disabled/);
  await assert.rejects(fs.stat(nonexistent), { code: "ENOENT" });
  const record = save(service).record;
  const store = await openPersonalAgentMemoryStore({ ownerUserId, env });
  env.ORKESTR_PERSONAL_AGENT_ENABLED = "0";
  assert.throws(() => service.export(owner), /personal_agent_disabled/);
  assert.throws(() => store.transaction(tx => tx.list()), /personal_agent_disabled/);
  await closeAgentJobDbs();
  const disabled = await openAgentJobDb(env);
  assert.equal(disabled.prepare("select id from personal_agent_memories").get().id, record.id);
  assert.equal(disabled.prepare("select count(*) as n from jobs").get().n, 0);
  env.ORKESTR_PERSONAL_AGENT_ENABLED = "true";
  assert.deepEqual((await openPersonalAgentMemoryService({ ownerUserId, env })).retrieve({}, owner), [record]);
});

test("incompatible migrated storage is explicit unavailable with no fallback or replacement", async t => {
  const { env, db } = await setup(t);
  db.exec("drop table personal_agent_memories");
  await assert.rejects(openPersonalAgentMemoryStore({ ownerUserId, env }), /memory_store_unavailable/);
  assert.equal(db.prepare("select count(*) as n from sqlite_master where name='personal_agent_memories'").get().n, 0);
});


test("independent writers serialize identical retries into one durable consented record", async t => {
  const { env } = await setup(t);
  await closeAgentJobDbs();
  const code = childImports + `const proposal=service.propose(memoryInput(),owner);
    console.log(JSON.stringify(service.create(proposal,owner,{action:'remember',digest:proposal.digest})));`;
  const execute = promisify(execFile);
  const results = await Promise.all([1, 2].map(() => execute(process.execPath, ["--input-type=module", "--eval", code], {
    env: { PATH: process.env.PATH, HOME: env.ORKESTR_HOME, ...env }, timeout: 20000,
  })));
  const writes = results.map(result => JSON.parse(result.stdout));
  assert.deepEqual(writes.map(result => result.deduplicated).sort(), [false, true]);
  assert.deepEqual(writes[0].record, writes[1].record);
  assert.equal(childResult(env, "console.log(JSON.stringify(service.export(owner)));" ).records.length, 1);
});

test("a killed uncommitted writer leaves no partial memory on fresh-process recovery", async t => {
  const { env, db, service } = await setup(t);
  const first = save(service).record;
  const row = { ...db.prepare("select * from personal_agent_memories").get(), id: "uncommitted-fixture", idempotency_key: "uncommitted-fixture" };
  await closeAgentJobDbs();
  const result = child(env, `
    const {openPersonalAgentMemoryStore}=await import(${JSON.stringify(new URL("../packages/core/src/personal-agent-memory-sqlite.js", import.meta.url).href)});
    const store=await openPersonalAgentMemoryStore({ownerUserId:'owner-fixture'});
    store.transaction(tx=>{tx.insert(${JSON.stringify(row)});fs.writeSync(1,'inserted');process.kill(process.pid,'SIGKILL');});`);
  assert.equal(result.signal, "SIGKILL", result.stderr); assert.equal(result.stdout, "inserted");
  assert.deepEqual(childResult(env, "console.log(JSON.stringify(service.export(owner)));" ).records, [first]);
});


test("SQL-looking memory text is stored literally and corrupt consent fails closed", async t => {
  const { service, db } = await setup(t);
  const statement = "Synthetic fact: '); delete from personal_agent_memories; --";
  const record = save(service, memoryInput({ content: { statement } })).record;
  assert.equal(service.retrieve({}, owner)[0].content.statement, statement);
  db.prepare("update personal_agent_memories set consented_by=? where id=?").run("different-owner", record.id);
  assert.throws(() => service.retrieve({}, owner), /stored_record_invalid/);
  assert.throws(() => service.export(owner), /stored_record_invalid/);
});
