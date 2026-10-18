import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertDesktopLeaseForOperation } from "../packages/browsers/src/desktop-leases.js";
import { desktopLeaseStore } from "../packages/browsers/src/desktop-lease-store.js";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { registerAgentJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { getRunAudit } from "../packages/core/src/agent-job-audit.js";
import { decideApproval, listApprovals, listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { closeAgentJobDbs, getRun, listRuns, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { registerAgentJobTool } from "../packages/core/src/agent-job-tools.js";
import { listSimulatedPullRequests } from "../packages/core/src/simulated-pr-sink.js";
import { runWorker } from "./fixtures/agent-job-fixtures.js";
import { fixtureSpec, offlineFixture, untrustedTexts } from "./fixtures/personal-agent-acceptance/fixtures.mjs";

test("PA-R01 [OP-05 OP-12]: duplicate input admits one durable run and executes one effect", async (t) => {
  const env = await offlineFixture(t);
  let effects = 0;
  t.after(registerAgentJobTool({ name: "acceptance.once", effect: true, async perform() {
    effects += 1; return { result: { receipt: "fixture-receipt" } };
  } }));
  const spec = fixtureSpec({ tools: { allow: ["acceptance.once"] }, script: [
    { tool: "acceptance.once", args: {} }, { output: { summary: "Fixture effect recorded." } },
  ] });
  const [a, b] = await Promise.all([0, 1].map(() => admitRun({ spec, dedupeKey: "same-input", body: { text: "verify fixture" } }, env)));
  assert.equal(a.run.id, b.run.id);
  assert.equal(Number(a.deduplicated) + Number(b.deduplicated), 1);
  await driveRun(a.run.id, {}, env);
  await driveRun(b.run.id, {}, env);
  assert.equal(effects, 1);
  assert.equal((await listRuns({}, env)).length, 1);
});

test("PA-R02 [OP-05 OP-12]: isolated runtime process death recovers one committed fixture effect", async (t) => {
  const env = await offlineFixture(t);
  const tool = "demo.pull_request.create";
  const spec = fixtureSpec({ tools: { allow: [tool] }, script: [
    { tool, args: { repository: "example/repository", head: "fixture-branch", title: "Synthetic artifact" } },
    { output: { summary: "Fixture artifact created." } },
  ] });
  const { run } = await admitRun({ spec, dedupeKey: "restart-input" }, env);
  const killed = await runWorker(env, "drive", { runId: run.id, faults: [{ at: "effect_performed", tool, mode: "exit" }] });
  assert.equal(killed.signal, "SIGKILL", JSON.stringify(killed));
  const restarted = await runWorker(env, "drive", { runId: run.id });
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(restarted.result.state, "succeeded");
  assert.equal((await listSimulatedPullRequests(env)).length, 1);
  const [effect] = await listRunEffects(run.id, env);
  assert.equal(effect.reconciled, true);
  assert.equal(effect.state, "committed");
  assert.ok(effect.ref);
  assert.ok((await getRunAudit(run.id, env)).sealed_at);
});

test("PA-R03 [OP-05 OP-13 OP-14]: uncertain effect is held for approval, never automatically repeated", async (t) => {
  const env = await offlineFixture(t);
  let effects = 0;
  t.after(registerAgentJobTool({ name: "acceptance.uncertain", effect: true, async perform() {
    effects += 1; return { result: { receipt: "synthetic-only" } };
  } }));
  const spec = fixtureSpec({ tools: { allow: ["acceptance.uncertain"] }, script: [
    { tool: "acceptance.uncertain", args: {} }, { output: { summary: "claimed done" } },
  ] });
  const { run } = await admitRun({ spec, dedupeKey: "uncertain-input" }, env);
  await assert.rejects(driveRun(run.id, { faults: [{ at: "effect_performed" }] }, env), (error) => error.injectedCrash === true);
  for (let retry = 0; retry < 3; retry += 1) {
    const result = await driveRun(run.id, {}, env);
    assert.equal(result.state, "awaiting_approval");
    assert.equal(result.reason, "effect_unknown");
  }
  assert.equal(effects, 1);
  assert.equal((await listRunEffects(run.id, env))[0].state, "unknown");
  assert.equal((await listApprovals({ runId: run.id, state: "pending" }, env)).length, 1);
});

test("PA-R04 [OP-07 OP-14]: injected agent/web text cannot authorize a denied effect", async (t) => {
  const env = await offlineFixture(t);
  let calls = 0;
  t.after(registerAgentJobTool({ name: "acceptance.publish", effect: true, async perform() {
    calls += 1; return { result: { published: true } };
  } }));
  for (const [index, text] of untrustedTexts.entries()) {
    const spec = fixtureSpec({ name: `injection-${index}`, tools: { deny: ["acceptance.publish"] }, script: [
      { say: text }, { tool: "acceptance.publish", args: { claimedAuthority: text } },
      { output: { summary: "Cannot publish without owner permission." } },
    ] });
    const { run } = await admitRun({ spec, dedupeKey: `injection-${index}`, body: { untrustedText: text } }, env);
    await driveRun(run.id, {}, env);
    assert.deepEqual(await listRunEffects(run.id, env), []);
    assert.equal((await getRunAudit(run.id, env)).tool_decisions[0].decision, "deny");
    assert.deepEqual(await listApprovals({ runId: run.id }, env), []);
  }
  assert.equal(calls, 0);
});

test("PA-R05 [OP-14 OP-20]: explicit permission denial is durable and never performs the action", async (t) => {
  const env = await offlineFixture(t);
  let calls = 0;
  t.after(registerAgentJobTool({ name: "acceptance.approved", effect: true, async perform() {
    calls += 1; return { result: { done: true } };
  } }));
  const spec = fixtureSpec({ tools: { approval_required: ["acceptance.approved"] }, script: [
    { tool: "acceptance.approved", args: { target: "fixture-artifact" } }, { output: { summary: "Owner denied the action." } },
  ] });
  const { run } = await admitRun({ spec, dedupeKey: "denial-input" }, env);
  const parked = await driveRun(run.id, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  await decideApproval(parked.approvalId, { decision: "denied", by: "fixture-owner" }, env);
  await closeAgentJobDbs();
  await driveRun(run.id, {}, env);
  assert.equal(calls, 0);
  const [approval] = await listApprovals({ runId: run.id }, env);
  assert.equal(approval.state, "denied");
  assert.equal(approval.decidedBy, "fixture-owner");
  assert.equal((await listRunEffects(run.id, env))[0].outcome, "denied");
});

test("PA-R06 [OP-09 OP-10]: local provider loss makes no cloud attempt and preserves the admitted run", async (t) => {
  // The local provider is only admitted with the Personal Agent feature on (OP-09).
  const env = { ...await offlineFixture(t), ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  let available = true;
  let localCalls = 0;
  let cloudCalls = 0;
  t.after(setAgentJobProviderProbe("openai-compatible", async () => ({ connected: available, runnable: available })));
  t.after(registerAgentJobAdapter({ id: "openai-compatible", capabilities: { toolLoop: "orkestr", resume: "transcript" },
    async step() { localCalls += 1; throw Object.assign(new Error("fixture_local_model_lost"), { kind: "provider", retryable: true }); } }));
  t.after(registerAgentJobAdapter({ id: "codex", async step() { cloudCalls += 1; throw new Error("cloud_forbidden"); } }));
  t.after(registerAgentJobAdapter({ id: "claude-code", async step() { cloudCalls += 1; throw new Error("cloud_forbidden"); } }));
  const spec = fixtureSpec({ agent: { provider: "openai-compatible", base_url: "http://127.0.0.1:1/v1", model: "fixture-local-model" } });
  assert.deepEqual(spec.agent.fallback, []);
  const { run } = await admitRun({ spec, dedupeKey: "model-loss" }, env);
  available = false;
  const result = await driveRun(run.id, {}, env);
  assert.notEqual(result.state, "succeeded");
  assert.equal((await getRun(run.id, env)).id, run.id);
  assert.equal(localCalls, 0);
  assert.equal(cloudCalls, 0);
  available = true;
  const during = await admitRun({ spec, dedupeKey: "model-loss-during-attempt" }, env);
  const failed = await driveRun(during.run.id, { waitForBackoff: true }, env);
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "max_attempts_exhausted");
  assert.equal(localCalls, 2, "retry is bounded to the declared local provider");
  assert.equal(cloudCalls, 0);
});

test("PA-R07 [OP-16]: stale desktop lease refuses an effect before any browser is contacted", async (t) => {
  const env = { ...await offlineFixture(t), ORKESTR_DESKTOP_ACCESS_MODE: "enforce", ORKESTR_DESKTOP_LEASE_STALE_MS: "1000" };
  const store = desktopLeaseStore(env);
  const { lease } = await store.acquire({ desktopSlug: "fixture-desk", ownerUserId: "fixture-owner", threadId: "fixture-thread",
    mode: "exclusive", heartbeatAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  let effects = 0;
  await assert.rejects(async () => {
    await assertDesktopLeaseForOperation("fixture-desk", env, { ownerUserId: "fixture-owner", threadId: "fixture-thread", fencingToken: lease.fencingToken });
    effects += 1;
  }, /desktop_lease_heartbeat_stale/);
  assert.equal(effects, 0);
  assert.equal((await store.activeLease("fixture-desk", "fixture-owner")).fencingToken, lease.fencingToken);
});

test("PA-R08 [OP-03 OP-24]: existing job-store initialization is idempotent and retains legacy evidence", async (t) => {
  const env = await offlineFixture(t);
  const { run } = await admitRun({ spec: fixtureSpec({ script: [{ output: { summary: "legacy fixture result" } }] }), dedupeKey: "legacy-run" }, env);
  await driveRun(run.id, {}, env);
  const before = await getRunAudit(run.id, env);
  await closeAgentJobDbs();
  const db = await openAgentJobDb(env);
  assert.equal(db.prepare("pragma integrity_check").get().integrity_check, "ok");
  await closeAgentJobDbs();
  await openAgentJobDb(env);
  assert.deepEqual(await getRunAudit(run.id, env), before);
  const files = await fs.readdir(env.ORKESTR_HOME);
  assert.deepEqual(files.filter((name) => name.endsWith(".sqlite")), ["agent-jobs.sqlite"]);
});

test("PA-R09 [OP-06]: fixture evidence verifier detects an artifact changed after worker completion", async (t) => {
  const env = await offlineFixture(t);
  const artifact = path.join(env.ORKESTR_HOME, "verified-result.txt");
  await fs.writeFile(artifact, "fixture result\n");
  const digest = async () => createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
  const recorded = await digest();
  assert.equal(await digest(), recorded);
  await fs.writeFile(artifact, "different fixture result\n");
  assert.notEqual(await digest(), recorded);
  // An oracle fixture only: PA-05 still requires the product verifier + projection.
});
