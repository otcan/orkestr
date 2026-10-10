// Runtime guarantees G1-G5 (docs/spec/runtime-guarantees.md), offline.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { registerAgentJobAdapter, simulatedJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { handleAgentJobTrigger } from "../packages/core/src/agent-job-http.js";
import { decideApproval, listApprovals, listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { startAgentJobScheduler } from "../packages/core/src/agent-job-scheduler.js";
import { getRun, listAttemptsSync, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { driveToEnd, makeSpec, prScript, pullRequests, runWorker, tempEnv } from "./fixtures/agent-job-fixtures.js";

const admin = { kind: "user", role: "admin", userId: "admin" };

async function attempts(runId, env) {
  return listAttemptsSync(await openAgentJobDb(env), runId);
}

test("G1: an admitted run that crashed before running resumes on server start and finishes", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt-1" }, env);
  await assert.rejects(driveRun(run.id, { faults: [{ at: "attempt_started" }] }, env), /injected_crash/);
  assert.equal((await getRun(run.id, env)).state, "running");

  const tasks = [];
  const scheduler = startAgentJobScheduler(env, { track: (task) => (tasks.push(task), task), intervalMs: 60_000 });
  try {
    while (tasks.length) await Promise.allSettled(tasks.splice(0));
    assert.equal((await getRun(run.id, env)).state, "awaiting_approval");
    const [approval] = await listApprovals({ runId: run.id, state: "pending" }, env);
    await decideApproval(approval.approvalId, { decision: "approved", by: "test" }, env);
    await scheduler.tick();
    while (tasks.length) await Promise.allSettled(tasks.splice(0));
  } finally {
    scheduler.stop();
  }
  const final = await getRun(run.id, env);
  assert.equal(final.state, "succeeded");
  assert.deepEqual((await attempts(run.id, env)).map((a) => a.endReason), ["interrupted", "approval_wait", "completed"]);
});

test("G2: the same webhook delivered twice produces one run, also over HTTP", async () => {
  const env = await tempEnv();
  await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "register" }, env);
  const body = { delivery_id: "example-delivery-1", issue: 7 };
  const first = await handleAgentJobTrigger({ name: "example-job", query: { hook: "issue-opened" }, body, principal: admin }, env);
  const second = await handleAgentJobTrigger({ name: "example-job", query: { hook: "issue-opened" }, body: { ...body, retry: 1 }, principal: admin }, env);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.deduplicated, true);
  assert.equal(second.body.runId, first.body.runId);

  const api1 = await handleAgentJobTrigger({ name: "example-job", headers: { "idempotency-key": "k-1" }, principal: admin }, env);
  const api2 = await handleAgentJobTrigger({ name: "example-job", headers: { "Idempotency-Key": "k-1" }, principal: admin }, env);
  assert.equal(api2.body.runId, api1.body.runId);
  const denied = await handleAgentJobTrigger({ name: "example-job", principal: { role: "user", userId: "u1" } }, env);
  assert.equal(denied.statusCode, 403);
  const machine = await handleAgentJobTrigger({ name: "example-job", machineAuth: "agent_job_trigger", body: { event: {} } }, env);
  assert.equal(machine.statusCode, 202);
  const missing = await handleAgentJobTrigger({ name: "no-such-job", principal: admin }, env);
  assert.equal(missing.statusCode, 404);
});

test("G2: concurrent duplicate deliveries from separate processes admit exactly one run", async () => {
  const env = await tempEnv();
  const spec = makeSpec();
  await admitRun({ spec, type: "api", dedupeKey: "register" }, env);
  const event = { type: "webhook", name: "issue-opened", body: { delivery_id: "example-delivery-concurrent" } };
  const results = await Promise.all(Array.from({ length: 4 }, () => runWorker(env, "admit", { job: "example-job", ...event })));
  assert.ok(results.every((result) => result.result?.ok), JSON.stringify(results));
  assert.equal(new Set(results.map((result) => result.result.runId)).size, 1);
  assert.equal(results.filter((result) => !result.result.deduplicated).length, 1);
});

test("G2: webhooks without event_id dedupe on the body hash", async () => {
  const env = await tempEnv();
  const spec = makeSpec({ triggers: [{ type: "webhook", name: "push", secret_ref: "vault://example-webhook-secret" }] });
  const a = await admitRun({ spec, type: "webhook", name: "push", body: { ref: "main", n: 1 } }, env);
  const b = await admitRun({ spec, type: "webhook", name: "push", body: { n: 1, ref: "main" } }, env);
  const c = await admitRun({ spec, type: "webhook", name: "push", body: { ref: "main", n: 2 } }, env);
  assert.equal(b.run.id, a.run.id);
  assert.notEqual(c.run.id, a.run.id);
  await assert.rejects(admitRun({ spec, type: "api" }, env), /trigger_not_declared/);
});

const createPoints = ["tool_requested", "effect_intended", "effect_dispatched", "effect_performed", "effect_committed"];

for (const point of createPoints) {
  test(`G3: crash at ${point} of the pull request effect still opens exactly one pull request`, async () => {
    const env = await tempEnv();
    const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
    const result = await driveToEnd(run.id, env, { faults: [{ at: point, tool: "demo.pull_request.create", attempts: [1] }] });
    assert.equal(result.state, "succeeded");
    const prs = await pullRequests(env);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].merges, 1);
    assert.equal((await attempts(run.id, env))[0].endReason, "interrupted");
  });
}

test("G3: randomized crashes at every checkpoint never duplicate the pull request", async () => {
  const points = ["attempt_started", ...createPoints, "approval_requested", "final_output"];
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let index = 0; index < 30; index += 1) {
    const env = await tempEnv();
    const faults = [{ at: points[random(points.length)], attempts: [1 + random(3)] }, { at: points[random(points.length)], attempts: [1 + random(3)] }];
    const { run } = await admitRun({ spec: makeSpec({ runtime: { max_attempts: 10 } }), type: "api", dedupeKey: `evt-${index}` }, env);
    const result = await driveToEnd(run.id, env, { faults, rounds: 20 });
    const prs = await pullRequests(env);
    assert.equal(result.state, "succeeded", JSON.stringify({ faults, result }));
    assert.equal(prs.length, 1, JSON.stringify(faults));
    assert.equal(prs[0].merges, 1, JSON.stringify(faults));
  }
});

const noteScript = [{ tool: "demo.notify.send", args: { text: "hello" } }, { output: { summary: "noted" } }];

async function sentNotes(env) {
  const text = await fs.readFile(path.join(env.ORKESTR_HOME, "simulated", "sent-notes.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
}

for (const point of ["effect_dispatched", "effect_performed"]) {
  test(`G4: an at-most-once effect crashed at ${point} becomes unknown and blocks; deny skips it`, async () => {
    const env = await tempEnv();
    const { run } = await admitRun({ spec: makeSpec({ script: noteScript }), type: "api", dedupeKey: "evt" }, env);
    await assert.rejects(driveRun(run.id, { faults: [{ at: point }] }, env), /injected_crash/);
    const before = await sentNotes(env);
    for (let round = 0; round < 3; round += 1) {
      const parked = await driveRun(run.id, {}, env);
      assert.equal(parked.state, "awaiting_approval");
      assert.equal(parked.reason, "effect_unknown");
    }
    assert.equal(await sentNotes(env), before, "an unknown effect must never be re-executed automatically");
    const [effect] = await listRunEffects(run.id, env);
    assert.equal(effect.state, "unknown");
    const [approval] = await listApprovals({ runId: run.id, state: "pending" }, env);
    await decideApproval(approval.approvalId, { decision: "denied", by: "test" }, env);
    assert.equal((await driveRun(run.id, {}, env)).state, "succeeded");
    assert.equal(await sentNotes(env), before);
    assert.equal((await listRunEffects(run.id, env))[0].outcome, "skipped");
  });
}

test("G4: approving the retry of an unknown effect executes it exactly once more", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec({ script: noteScript }), type: "api", dedupeKey: "evt" }, env);
  await assert.rejects(driveRun(run.id, { faults: [{ at: "effect_performed" }] }, env), /injected_crash/);
  assert.equal(await sentNotes(env), 1);
  const result = await driveToEnd(run.id, env);
  assert.equal(result.state, "succeeded");
  assert.equal(await sentNotes(env), 2);
  assert.equal((await listRunEffects(run.id, env))[0].state, "committed");
});

test("G5: repeated crashes at the same point end in recovery_loop after max_attempts", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
  const result = await driveToEnd(run.id, env, { faults: [{ at: "tool_requested", tool: "demo.repo.read" }] });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "recovery_loop");
  assert.equal((await attempts(run.id, env)).length, 3);
});

test("G5: retryable provider errors stop at max_attempts; task errors do not retry", async () => {
  const env = await tempEnv();
  const failing = [{ fail: { kind: "provider", message: "rate limit" }, on_attempts: [1, 2, 3, 4] }, ...prScript];
  const { run } = await admitRun({ spec: makeSpec({ script: failing }), type: "api", dedupeKey: "evt" }, env);
  const result = await driveRun(run.id, { waitForBackoff: true }, env);
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "max_attempts_exhausted");
  assert.equal((await attempts(run.id, env)).length, 3);

  const task = [{ fail: { kind: "task", retryable: false, message: "bad input" } }];
  const second = await admitRun({ spec: makeSpec({ name: "task-job", script: task }), type: "api", dedupeKey: "evt" }, env);
  const failed = await driveRun(second.run.id, { waitForBackoff: true }, env);
  assert.equal(failed.reason, "task_error");
  assert.equal((await attempts(second.run.id, env)).length, 1);
});

test("G5: a provider error falls back to the next provider; backoff parks the run", async () => {
  const env = await tempEnv();
  const restore = registerAgentJobAdapter({ ...simulatedJobAdapter, id: "codex" });
  try {
    const script = [{ fail: { kind: "provider", message: "unavailable" }, on_providers: ["simulated"], on_attempts: [1, 2, 3] }, { output: { summary: "ok" } }];
    const { run } = await admitRun({ spec: makeSpec({ script, fallback: [{ provider: "codex" }] }), type: "api", dedupeKey: "evt" }, env);
    const result = await driveRun(run.id, { waitForBackoff: true }, env);
    assert.equal(result.state, "succeeded");
    assert.deepEqual((await attempts(run.id, env)).map((a) => a.provider), ["simulated", "codex"]);
  } finally {
    restore();
  }
  const slow = makeSpec({ name: "slow-job", script: [{ fail: "unavailable" }, { output: {} }], runtime: { retry: { initial_delay: "1h", max_delay: "1h" } } });
  const { run } = await admitRun({ spec: slow, type: "api", dedupeKey: "evt" }, env);
  const parked = await driveRun(run.id, { waitForBackoff: true }, env);
  assert.equal(parked.state, "retrying");
  assert.ok(parked.nextAttemptAt > Date.now() + 3_000_000);
  assert.equal((await driveRun(run.id, {}, env)).state, "retrying");
  assert.equal((await attempts(run.id, env)).length, 1);
});
