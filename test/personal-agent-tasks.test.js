import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import {
  createPersonalAgentTask,
  getPersonalAgentTask,
  listPersonalAgentTaskTransitions,
  transitionPersonalAgentTask,
} from "../packages/core/src/personal-agent-tasks.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-task-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  const db = await openAgentJobDb(env);
  db.prepare(`insert into personal_agent_projects (id, title, created_at, updated_at)
    values ('prj_fixture', 'Fixture project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, db };
}

const contract = {
  projectId: "prj_fixture",
  idempotencyKey: "request-1",
  title: "Verify the fixture",
  outcome: "A verified result is recorded",
  nextAction: "Run the fixture check",
  acceptanceCriteria: [{ id: "verified", description: "The result is checked" }],
  scope: { permissions: ["read_fixture"], resources: ["fixture-1"] },
  dependencies: [],
  assignedWorker: "worker-fixture",
  priority: "normal",
  budget: { maxAttempts: 2, maxRuntimeMs: 30_000 },
};

test("task creation validates and durably stores the explicit contract idempotently", async (t) => {
  const { env, db } = await fixture(t);
  const first = await createPersonalAgentTask(contract, env);
  assert.equal(first.created, true);
  assert.equal(first.task.state, "queued");
  assert.equal(first.task.outcome, contract.outcome);
  assert.deepEqual(first.task.acceptanceCriteria, contract.acceptanceCriteria);
  assert.deepEqual(first.task.scope, contract.scope);
  assert.equal((await createPersonalAgentTask(contract, env)).created, false);
  assert.equal(db.prepare("select count(*) as count from personal_agent_tasks").get().count, 1);
  assert.equal((await listPersonalAgentTaskTransitions(first.task.id, env)).length, 1);
  await assert.rejects(() => createPersonalAgentTask({ ...contract, outcome: "Different" }, env), { code: "personal_agent_task_idempotency_conflict" });
});

test("task contracts reject missing acceptance, scope, permissions, and invalid budgets", async (t) => {
  const { env } = await fixture(t);
  for (const invalid of [
    { ...contract, acceptanceCriteria: [] },
    { ...contract, scope: null },
    { ...contract, scope: { permissions: "read" } },
    { ...contract, budget: { maxAttempts: 0, maxRuntimeMs: 1000 } },
  ]) {
    await assert.rejects(() => createPersonalAgentTask({ ...invalid, idempotencyKey: undefined }, env));
  }
});

test("lifecycle enforces allowed transitions, reasons, terminal immutability, and idempotency", async (t) => {
  const { env } = await fixture(t);
  const task = (await createPersonalAgentTask(contract, env)).task;
  const actor = { kind: "system", id: "controller", origin: "agent_job" };
  await assert.rejects(() => transitionPersonalAgentTask({ taskId: task.id, to: "succeeded", actor, reason: "worker said done" }, env), {
    code: "personal_agent_task_transition_not_allowed",
  });
  await assert.rejects(() => transitionPersonalAgentTask({ taskId: task.id, to: "blocked", actor }, env), {
    code: "personal_agent_task_transition_reason_required",
  });
  const start = { taskId: task.id, to: "running", actor, idempotencyKey: "start-1" };
  assert.equal((await transitionPersonalAgentTask(start, env)).task.state, "running");
  assert.equal((await transitionPersonalAgentTask({
    idempotencyKey: "start-1",
    actor: { origin: "agent_job", kind: "system", id: "controller" },
    to: "running",
    taskId: task.id,
  }, env)).replayed, true);
  await assert.rejects(() => transitionPersonalAgentTask({ ...start, to: "blocked" }, env), {
    code: "personal_agent_task_idempotency_conflict",
  });
  const finish = await transitionPersonalAgentTask({
    taskId: task.id,
    to: "succeeded",
    actor,
    completion: {
      status: "succeeded",
      summary: "Verified",
      acceptanceResults: [{ criterionId: "verified", passed: true }],
    },
    evidence: { verified: true, verifiedBy: "test-verifier", references: ["artifact:fixture"] },
  }, env);
  assert.equal(finish.task.state, "succeeded");
  await assert.rejects(() => transitionPersonalAgentTask({ taskId: task.id, to: "failed", actor, reason: "late update" }, env), {
    code: "personal_agent_task_transition_not_allowed",
  });
  assert.deepEqual((await listPersonalAgentTaskTransitions(task.id, env)).map(({ from, to }) => [from, to]), [
    [null, "queued"], ["queued", "running"], ["running", "succeeded"],
  ]);
});

test("worker completion text or incomplete evidence cannot mark a task succeeded", async (t) => {
  const { env, db } = await fixture(t);
  const task = (await createPersonalAgentTask(contract, env)).task;
  const system = { kind: "system", id: "controller", origin: "agent_job" };
  await transitionPersonalAgentTask({ taskId: task.id, to: "running", actor: system }, env);
  const completion = { status: "succeeded", summary: "done", acceptanceResults: [{ criterionId: "verified", passed: true }] };
  await assert.rejects(() => transitionPersonalAgentTask({
    taskId: task.id,
    to: "succeeded",
    actor: { kind: "worker", id: "worker-fixture", origin: "thread" },
    completion,
    evidence: { verified: true, verifiedBy: "verifier", references: ["artifact:1"] },
  }, env), { code: "personal_agent_task_completion_unverified" });
  await assert.rejects(() => transitionPersonalAgentTask({
    taskId: task.id,
    to: "succeeded",
    actor: system,
    completion: { ...completion, acceptanceResults: [] },
    evidence: { verified: true, verifiedBy: "verifier", references: ["artifact:1"] },
  }, env), { code: "personal_agent_task_acceptance_not_satisfied" });
  await assert.rejects(() => transitionPersonalAgentTask({
    taskId: task.id,
    to: "succeeded",
    actor: system,
    completion,
    evidence: { verified: true, verifiedBy: "verifier", references: [] },
  }, env), { code: "personal_agent_task_completion_unverified" });
  assert.equal((await getPersonalAgentTask(task.id, env)).state, "running");
  assert.equal(db.prepare("select count(*) as count from personal_agent_task_transitions where task_id = ?").get(task.id).count, 2);
});

test("legacy OP-03 tasks retain their column-backed fields and cannot succeed without criteria", async (t) => {
  const { env, db } = await fixture(t);
  db.prepare(`insert into personal_agent_tasks
    (id, project_id, title, outcome, acceptance_json, state, created_at, updated_at)
    values ('tsk_legacy', 'prj_fixture', 'Legacy task', 'Legacy outcome', '[]', 'running', 'now', 'now')`).run();
  const legacy = await getPersonalAgentTask("tsk_legacy", env);
  assert.equal(legacy.title, "Legacy task");
  assert.equal(legacy.outcome, "Legacy outcome");
  assert.deepEqual(legacy.acceptanceCriteria, []);
  await assert.rejects(() => transitionPersonalAgentTask({
    taskId: legacy.id,
    to: "succeeded",
    actor: { kind: "system", id: "controller", origin: "agent_job" },
    completion: { status: "succeeded", summary: "Done", acceptanceResults: [] },
    evidence: { verified: true, verifiedBy: "verifier", references: ["artifact:legacy"] },
  }, env), { code: "personal_agent_task_acceptance_not_satisfied" });
  assert.equal((await getPersonalAgentTask(legacy.id, env)).state, "running");
});

test("task APIs remain unavailable and do not create Personal Agent tables while disabled", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-personal-agent-task-off-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "false" };
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  await assert.rejects(() => createPersonalAgentTask(contract, env), { statusCode: 404, code: "personal_agent_disabled" });
  const db = await openAgentJobDb(env);
  assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 0);
});
