// Runtime guarantees G6-G8 (docs/spec/runtime-guarantees.md), offline.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitRun, registerJobFiles, syncJobDirectories } from "../packages/core/src/agent-job-admission.js";
import { registerAgentJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { getRunAudit } from "../packages/core/src/agent-job-audit.js";
import { decideApproval, listApprovals, listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { getRegisteredJob, getRun, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { driveToEnd, makeSpec, pullRequests, runWorker, tempEnv } from "./fixtures/agent-job-fixtures.js";

test("G6: a tool not matched by allow or approval_required is denied before execution and audited", async () => {
  const env = await tempEnv();
  const script = [
    { tool: "demo.pull_request.create", args: { repository: "example/repo", head: "x", title: "t" } },
    { tool: "demo.notify.send", args: { text: "denied explicitly" } },
    { tool: "demo.unregistered.tool", args: {} },
    { tool: "demo.repo.read", args: {} },
    { output: { summary: "continued" } },
  ];
  const tools = { allow: ["demo.repo.*", "demo.unregistered.*"], deny: ["demo.notify.*"] };
  const { run } = await admitRun({ spec: makeSpec({ script, tools }), type: "api", dedupeKey: "evt" }, env);
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded");
  assert.equal((await pullRequests(env)).length, 0);
  assert.equal(await fs.stat(path.join(env.ORKESTR_HOME, "simulated", "sent-notes.jsonl")).catch(() => null), null);
  assert.deepEqual(await listRunEffects(run.id, env), []);
  const audit = await getRunAudit(run.id, env);
  assert.deepEqual(audit.tool_decisions.map((d) => [d.tool, d.decision]), [
    ["demo.pull_request.create", "deny"],
    ["demo.notify.send", "deny"],
    ["demo.unregistered.tool", "allow"],
    ["demo.repo.read", "allow"],
  ]);
});

// An adapter whose merge args differ between the first and later attempts,
// like a model that rewrites a tool call after a restart.
function changingArgsAdapter() {
  const steps = (attempt) => [
    { type: "tool", tool: "demo.pull_request.create", args: { repository: "example/repo", head: "g7", title: "t" } },
    { type: "tool", tool: "demo.pull_request.merge", args: { repository: "example/repo", head: "g7", note: attempt === 1 ? "v1" : "v2" } },
    { type: "final", output: { summary: "merged" } },
  ];
  return {
    id: "claude-code",
    capabilities: { toolLoop: "orkestr", resume: "transcript" },
    async step(ctx, state) {
      const index = state.transcript.length;
      return { ...steps(ctx.attempt)[index], stepIndex: index };
    },
  };
}

test("G7: an approval does not apply when the args change; the matching one is consumed once", async () => {
  const env = await tempEnv();
  const restore = registerAgentJobAdapter(changingArgsAdapter());
  const restoreProbe = setAgentJobProviderProbe("claude-code", async () => ({ connected: true }));
  try {
    const { run } = await admitRun({ spec: makeSpec({ provider: "claude-code" }), type: "api", dedupeKey: "evt" }, env);
    const first = await driveRun(run.id, {}, env);
    assert.equal(first.state, "awaiting_approval");
    await decideApproval(first.approvalId, { decision: "approved", by: "test" }, env);
    await assert.rejects(decideApproval(first.approvalId, { decision: "approved", by: "again" }, env), /approval_already_decided/);

    const second = await driveRun(run.id, {}, env);
    assert.equal(second.state, "awaiting_approval");
    assert.notEqual(second.approvalId, first.approvalId);
    assert.equal((await pullRequests(env))[0].state, "open", "the v1 approval must not merge the v2 call");

    await decideApproval(second.approvalId, { decision: "approved", by: "test" }, env);
    assert.equal((await driveRun(run.id, {}, env)).state, "succeeded");
    const approvals = await listApprovals({ runId: run.id }, env);
    assert.equal(approvals.find((a) => a.approvalId === first.approvalId).consumedAt, null);
    assert.ok(approvals.find((a) => a.approvalId === second.approvalId).consumedAt);
    assert.equal((await pullRequests(env))[0].merges, 1);
  } finally {
    restore();
    restoreProbe();
  }
});

test("G7: concurrent decisions from separate processes: exactly one wins", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
  const parked = await driveRun(run.id, {}, env);
  const decisions = ["approved", "denied", "approved", "denied"];
  const results = await Promise.all(decisions.map((decision) => runWorker(env, "decide", { approvalId: parked.approvalId, decision })));
  const winners = results.filter((result) => result.result?.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.ok(results.filter((result) => !result.result?.ok).every((result) => result.result.error === "approval_already_decided"));
  const final = await driveRun(run.id, {}, env);
  assert.equal(final.state, "succeeded");
  assert.equal((await pullRequests(env))[0].merges, winners[0].result.state === "approved" ? 1 : 0);
});

test("G7: a consumed approval is single use; re-executing after a lost dispatch needs a new one", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
  const parked = await driveRun(run.id, {}, env);
  await decideApproval(parked.approvalId, { decision: "approved", by: "test" }, env);
  // Crash after dispatch but before the merge reached the code host.
  await assert.rejects(driveRun(run.id, { faults: [{ at: "effect_dispatched", tool: "demo.pull_request.merge" }] }, env), /injected_crash/);
  const again = await driveRun(run.id, {}, env);
  assert.equal(again.state, "awaiting_approval");
  assert.notEqual(again.approvalId, parked.approvalId);
  const result = await driveToEnd(run.id, env);
  assert.equal(result.state, "succeeded");
  assert.equal((await pullRequests(env))[0].merges, 1);
});

test("G7: expired approvals cannot be granted and fail the run with approval_expired", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
  const parked = await driveRun(run.id, {}, env);
  const db = await openAgentJobDb(env);
  db.prepare("update approvals set expires_at = ? where id = ?").run(Date.now() - 1, parked.approvalId);
  await assert.rejects(decideApproval(parked.approvalId, { decision: "approved", by: "late" }, env), /approval_expired/);
  assert.equal((await listApprovals({ runId: run.id }, env))[0].state, "expired");
  await assert.rejects(decideApproval(parked.approvalId, { decision: "approved", by: "later" }, env), /approval_expired/);
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "approval_expired");
  const merge = (await listRunEffects(run.id, env)).find((effect) => effect.tool === "demo.pull_request.merge");
  assert.equal(merge.outcome, "expired");
  assert.equal((await pullRequests(env))[0].merges, 0);
});

test("G7: a denied approval tells the agent and never performs the effect", async () => {
  const env = await tempEnv();
  const { run } = await admitRun({ spec: makeSpec(), type: "api", dedupeKey: "evt" }, env);
  const result = await driveToEnd(run.id, env, { decision: "denied" });
  assert.equal(result.state, "succeeded");
  assert.equal((await pullRequests(env))[0].merges, 0);
  assert.equal((await listRunEffects(run.id, env)).find((e) => e.tool === "demo.pull_request.merge").outcome, "denied");
});

function jobYaml(summary) {
  return `apiVersion: orkestr/v0
kind: AgentJob
metadata:
  name: pinned-job
triggers:
  - type: api
agent:
  provider: simulated
task:
  prompt: Summarize.
  inputs:
    simulated_script:
      - say: working
      - output: { summary: ${summary} }
`;
}

test("G8: a run keeps executing the spec it was admitted with when the job file is edited mid-run", async () => {
  const dir = path.join((await tempEnv()).ORKESTR_HOME, "jobs-src");
  const env = { ...(await tempEnv()), ORKESTR_AGENT_JOBS_DIR: dir };
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "pinned-job.yaml");
  await fs.writeFile(file, jobYaml("version-one"));
  const [registered] = await registerJobFiles(file, env);
  const { run } = await admitRun({ job: "pinned-job", type: "api", dedupeKey: "evt" }, env);
  await assert.rejects(driveRun(run.id, { faults: [{ at: "attempt_started" }] }, env), /injected_crash/);

  await fs.writeFile(file, jobYaml("version-two"));
  await syncJobDirectories(env);
  const current = await getRegisteredJob("pinned-job", env);
  assert.notEqual(current.specHash, registered.specHash);

  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.output, { summary: "version-one" });
  assert.equal((await getRun(run.id, env)).specHash, registered.specHash);
  const next = await admitRun({ job: "pinned-job", type: "api", dedupeKey: "evt-2" }, env);
  assert.deepEqual((await driveRun(next.run.id, {}, env)).output, { summary: "version-two" });
});
