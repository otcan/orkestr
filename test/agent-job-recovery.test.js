// Runtime guarantees G9-G11, real kill -9 recovery at every checkpoint,
// schedule triggers and the CLI (docs/spec/runtime-guarantees.md), offline.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { relayAgentJobNotifications } from "../packages/connectors/src/agent-job-notification-relay.js";
import { listConnectorOutboxJobs } from "../packages/connectors/src/connector-outbox.js";
import { admitRun, requestCancel } from "../packages/core/src/agent-job-admission.js";
import { getRunAudit, listRunNotifications } from "../packages/core/src/agent-job-audit.js";
import { decideApproval, listApprovals } from "../packages/core/src/agent-job-ledger.js";
import { driveDueRuns, driveRun } from "../packages/core/src/agent-job-runner.js";
import { fireDueSchedules } from "../packages/core/src/agent-job-scheduler.js";
import { registerAgentJobTool } from "../packages/core/src/agent-job-tools.js";
import { getRun, listRuns, openAgentJobDb, registerJobSpec } from "../packages/core/src/agent-job-store.js";
import { driveToEnd, makeSpec, prScript, pullRequests, runWorker, tempEnv } from "./fixtures/agent-job-fixtures.js";

const CANARY = "canary-secret-value-5d1e";

test("G9: every terminal run has a sealed audit record with no secret values", async () => {
  const env = await tempEnv();
  const unregister = [
    registerAgentJobTool({ name: "demo.secret.echo", effect: true, reconcile: async () => ({ found: false }), perform: async () => ({ result: { token: CANARY, note: `resolved ${CANARY}` } }) }),
    registerAgentJobTool({ name: "demo.secret.fail", effect: true, perform: async () => { throw new Error(`upstream rejected ${CANARY}`); } }),
  ];
  try {
    const script = [{ tool: "demo.secret.echo", args: { id: 1 } }, { tool: "demo.secret.fail", args: {} }, ...prScript];
    const spec = makeSpec({ script, tools: { allow: ["demo.*"], approval_required: ["demo.pull_request.merge"] } });
    const { run } = await admitRun({ spec, type: "api", dedupeKey: "evt" }, env);
    const result = await driveToEnd(run.id, env, { faults: [{ at: "effect_performed", tool: "demo.pull_request.create", attempts: [1] }], options: { secretValues: [CANARY] } });
    assert.equal(result.state, "succeeded");
    const audit = await getRunAudit(run.id, env);
    assert.ok(audit.sealed_at);
    assert.equal(audit.state, "succeeded");
    assert.equal(audit.trigger.dedupe_key, "evt");
    assert.deepEqual(audit.attempts.map((a) => a.end_reason), ["interrupted", "approval_wait", "completed"]);
    assert.ok(audit.tool_decisions.length >= 6);
    assert.deepEqual(audit.effects.map((e) => [e.tool, e.state]), [
      ["demo.secret.echo", "committed"],
      ["demo.secret.fail", "failed"],
      ["demo.pull_request.create", "committed"],
      ["demo.pull_request.merge", "committed"],
    ]);
    assert.equal(audit.effects[2].reconciled, true);
    assert.equal(audit.approvals[0].decision, "approved");
    assert.ok(!JSON.stringify(audit).includes(CANARY));
    const files = (await fs.readdir(env.ORKESTR_HOME)).filter((name) => name.startsWith("agent-jobs.sqlite"));
    for (const name of files) {
      assert.ok(!(await fs.readFile(path.join(env.ORKESTR_HOME, name))).includes(CANARY), `${name} contains the canary`);
    }
    // Sealed records do not change afterwards.
    await driveRun(run.id, {}, env);
    assert.deepEqual(await getRunAudit(run.id, env), audit);
  } finally {
    unregister.forEach((fn) => fn());
  }
});

test("G10: each notification is enqueued once even when the process dies while relaying it", async () => {
  const env = await tempEnv();
  const notifications = [{ on: ["approval_required", "succeeded"], channel: "whatsapp", target: "example-chat" }];
  const { run } = await admitRun({ spec: makeSpec({ notifications }), type: "api", dedupeKey: "evt" }, env);
  // The intent is written atomically with the state change, so a crash right
  // after parking cannot lose it.
  await assert.rejects(driveRun(run.id, { faults: [{ at: "approval_requested" }] }, env), /injected_crash/);
  const parked = await driveRun(run.id, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  await assert.rejects(relayAgentJobNotifications({ faults: [{ at: "notify" }] }, env), /injected_crash/);
  assert.equal((await relayAgentJobNotifications({}, env)).length, 1);
  await decideApproval(parked.approvalId, { decision: "approved", by: "test" }, env);
  assert.equal((await driveRun(run.id, {}, env)).state, "succeeded");
  await assert.rejects(relayAgentJobNotifications({ faults: [{ at: "notify" }] }, env), /injected_crash/);
  await relayAgentJobNotifications({}, env);
  await relayAgentJobNotifications({}, env);
  await driveDueRuns({}, env);
  const { jobs } = await listConnectorOutboxJobs({ connector: "agent_job" }, env);
  assert.deepEqual(jobs.map((job) => job.deliveryType).sort(), ["agent_job.approval_required", "agent_job.succeeded"]);
  assert.ok(jobs.every((job) => job.payload.channel === "whatsapp" && job.metadata.approvalChannel === false));
  const intents = await listRunNotifications(run.id, env);
  assert.equal(intents.length, 2);
  assert.ok(intents.every((intent) => intent.relayed_at && intent.outbox_job_id));
});

test("G11: cancel during a tool call starts no new effect; cancel during backoff ends the run", async () => {
  const env = await tempEnv();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const unregister = registerAgentJobTool({
    name: "demo.repo.slow",
    effect: false,
    async perform() {
      started();
      await new Promise((resolve) => { release = resolve; });
      return { result: { ok: true } };
    },
  });
  try {
    const script = [{ tool: "demo.repo.slow", args: {} }, ...prScript.slice(2)];
    const { run } = await admitRun({ spec: makeSpec({ script }), type: "api", dedupeKey: "evt" }, env);
    const driving = driveRun(run.id, {}, env);
    await startedPromise;
    await requestCancel(run.id, { by: "test" }, env);
    release();
    const result = await driving;
    assert.equal(result.state, "cancelled");
    assert.equal((await pullRequests(env)).length, 0);
  } finally {
    unregister();
  }

  const slow = makeSpec({ name: "slow-job", script: [{ fail: "unavailable" }, { output: {} }], runtime: { retry: { initial_delay: "1h", max_delay: "1h" } } });
  const { run } = await admitRun({ spec: slow, type: "api", dedupeKey: "evt" }, env);
  assert.equal((await driveRun(run.id, {}, env)).state, "retrying");
  await requestCancel(run.id, { by: "test" }, env);
  await driveDueRuns({}, env);
  assert.equal((await getRun(run.id, env)).state, "cancelled");

  // A run held by a live driver elsewhere is finalized once that lease lapses.
  const held = await admitRun({ spec: makeSpec({ name: "held-job" }), type: "api", dedupeKey: "evt" }, env);
  const db = await openAgentJobDb(env);
  db.prepare("update runs set lease_holder = ?, lease_expires_at = ? where id = ?").run("other-host.example:1:abcd", Date.now() + 60_000, held.run.id);
  await requestCancel(held.run.id, { by: "test" }, env);
  assert.equal((await driveRun(held.run.id, {}, env)).leased, false);
  db.prepare("update runs set lease_expires_at = ? where id = ?").run(Date.now() - 1, held.run.id);
  assert.equal((await driveRun(held.run.id, {}, env)).state, "cancelled");
});

const killPoints = ["attempt_started", "tool_requested", "effect_intended", "effect_dispatched", "effect_performed", "effect_committed", "approval_requested", "final_output"];

for (const point of killPoints) {
  test(`kill -9 at ${point}: a restarted process finishes the run with exactly one pull request`, async () => {
    const env = await tempEnv();
    const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
    const faults = [{ at: point, mode: "exit", ...(point.startsWith("effect_") ? { tool: "demo.pull_request.create" } : {}) }];
    let killed = 0;
    let state = "";
    for (let round = 0; round < 6 && state !== "succeeded"; round += 1) {
      const child = await runWorker(env, "drive", { runId: run.id, faults: killed ? [] : faults });
      if (child.signal === "SIGKILL") {
        killed += 1;
        continue;
      }
      assert.equal(child.result?.ok, true, child.stderr);
      state = child.result.state;
      if (state === "awaiting_approval") await decideApproval(child.result.approvalId, { decision: "approved", by: "test" }, env);
    }
    assert.equal(killed, 1);
    assert.equal(state, "succeeded");
    const prs = await pullRequests(env);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].merges, 1);
  });
}

test("schedule triggers fire once per slot and coalesce missed fires", async () => {
  const env = await tempEnv();
  const spec = makeSpec({ name: "nightly", triggers: [{ type: "schedule", cadence: "interval", every: "5m" }] });
  await registerJobSpec(spec, {}, env);
  const start = new Date("2026-10-10T00:00:00Z");
  assert.deepEqual(await fireDueSchedules(env, start), []);
  const later = new Date(start.getTime() + 60 * 60_000);
  const fired = await fireDueSchedules(env, later);
  assert.equal(fired.length, 1, "an hour of missed 5m slots coalesces into one run");
  assert.deepEqual(await fireDueSchedules(env, later), []);
  const db = await openAgentJobDb(env);
  db.prepare("update schedule_state set next_fire_at = ?").run(Date.parse(fired[0].slot));
  const again = await fireDueSchedules(env, later);
  assert.equal(again[0].deduplicated, true);
  assert.equal((await listRuns({ job: "nightly" }, env)).length, 1);
});

function capture() {
  let text = "";
  return { stream: { write: (chunk) => { text += chunk; return true; } }, text: () => text };
}

test("CLI: orkestr init, run, jobs approvals/approve/list/status/cancel", async () => {
  const env = await tempEnv();
  const dir = path.join(env.ORKESTR_HOME, "project");
  const call = async (argv) => {
    const out = capture();
    const err = capture();
    const code = await runCli(argv, { env, stdout: out.stream, stderr: err.stream });
    return { code, out: out.text(), err: err.text() };
  };
  assert.equal((await call(["init", dir])).code, 0);
  assert.notEqual((await call(["init", dir])).code, 0, "init must not overwrite without --force");
  const ran = await call(["run", dir, "--json"]);
  assert.equal(ran.code, 0, ran.err);
  const parked = JSON.parse(ran.out);
  assert.equal(parked.state, "awaiting_approval");
  assert.match((await call(["jobs", "approvals"])).out, new RegExp(parked.approvalId));
  const approved = JSON.parse((await call(["jobs", "approve", parked.approvalId, "--json"])).out);
  assert.equal(approved.run.state, "succeeded");
  const listed = JSON.parse((await call(["jobs", "list", "--json"])).out);
  assert.equal(listed.runs[0].id, parked.runId);
  const status = JSON.parse((await call(["jobs", "status", parked.runId, "--json"])).out);
  assert.ok(status.audit.sealed_at);
  const second = JSON.parse((await call(["run", dir, "--no-wait", "--json"])).out);
  const cancelled = JSON.parse((await call(["jobs", "cancel", second.runId, "--json"])).out);
  assert.equal(cancelled.state, "cancelled");
  const dup = JSON.parse((await call(["run", dir, "--idempotency-key", "k", "--no-wait", "--json"])).out);
  const dup2 = JSON.parse((await call(["run", dir, "--idempotency-key", "k", "--no-wait", "--json"])).out);
  assert.equal(dup2.runId, dup.runId);
  assert.equal(dup2.deduplicated, true);
  const pending = await listApprovals({ state: "pending" }, env);
  assert.equal(pending.length, 0);
});
