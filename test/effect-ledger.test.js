import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideEffectApproval, getEffect, listEffects, runEffect } from "../packages/core/src/effect-ledger.js";

async function tempEnv() {
  return { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-effect-ledger-")) };
}

function fakeSink() {
  const created = [];
  return {
    created,
    perform: async ({ idempotencyKey }) => {
      const item = { id: created.length + 1, idempotencyKey };
      created.push(item);
      return item;
    },
    reconcile: async (effect) => created.find((item) => item.idempotencyKey === effect.key) || null,
  };
}

test("effect ledger performs once and deduplicates later attempts", async () => {
  const env = await tempEnv();
  const sink = fakeSink();
  const spec = { key: "job-1:open", kind: "pr.open", jobId: "job-1", payload: { title: "x" }, ...sink };
  const first = await runEffect(spec, env);
  const second = await runEffect(spec, env);
  assert.equal(first.status, "performed");
  assert.equal(second.status, "deduplicated");
  assert.equal(sink.created.length, 1);
  assert.deepEqual(second.result, first.result);
});

test("effect ledger reconciles a crash between perform and commit", async () => {
  const env = await tempEnv();
  const sink = fakeSink();
  const spec = { key: "job-2:open", kind: "pr.open", jobId: "job-2", payload: { title: "x" }, ...sink };
  await assert.rejects(runEffect({ ...spec, afterPerform: () => { throw new Error("crash"); } }, env), /crash/);
  assert.equal((await getEffect(spec.key, env)).state, "intended");
  assert.ok((await getEffect(spec.key, env)).dispatchedAt);
  const resumed = await runEffect(spec, env);
  assert.equal(resumed.status, "reconciled");
  assert.equal(resumed.effect.reconciled, true);
  assert.equal(sink.created.length, 1);
});

test("effect ledger re-performs when reconciliation finds nothing and refuses without reconcile", async () => {
  const env = await tempEnv();
  const sink = fakeSink();
  const spec = { key: "job-3:open", kind: "pr.open", payload: {}, perform: sink.perform };
  await assert.rejects(runEffect({ ...spec, perform: async () => { throw new Error("crash_before_effect"); } }, env));
  await assert.rejects(runEffect(spec, env), /effect_outcome_unknown/);
  assert.equal((await getEffect(spec.key, env)).state, "unknown");
  const retried = await runEffect({ ...spec, reconcile: async () => null }, env);
  assert.equal(retried.status, "performed");
  assert.equal(sink.created.length, 1);
});

test("effect ledger waits for approval and honours denial", async () => {
  const env = await tempEnv();
  const sink = fakeSink();
  const spec = { key: "job-4:merge", kind: "pr.merge", jobId: "job-4", payload: { n: 1 }, approval: "required", waitForApproval: { timeoutMs: 5000, pollMs: 10 }, ...sink };
  const pending = runEffect(spec, env);
  // Attach a handler now: the rejection can land before assert.rejects runs.
  pending.catch(() => {});
  for (let i = 0; i < 100 && !(await listEffects({ approvalState: "pending" }, env)).length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sink.created.length, 0);
  await decideEffectApproval(spec.key, { decision: "denied", decidedBy: "test" }, env);
  await assert.rejects(pending, /effect_approval_denied/);
  await assert.rejects(runEffect(spec, env), /effect_approval_denied/);
  assert.equal((await getEffect(spec.key, env)).state, "failed");
  assert.equal(sink.created.length, 0);
});

test("effect ledger times out pending approvals and rejects payload conflicts", async () => {
  const env = await tempEnv();
  const sink = fakeSink();
  await assert.rejects(
    runEffect({ key: "job-5:merge", payload: {}, approval: "required", waitForApproval: { timeoutMs: 20, pollMs: 10 }, ...sink }, env),
    /effect_approval_timeout/,
  );
  await runEffect({ key: "job-5:open", payload: { a: 1 }, ...sink }, env);
  await assert.rejects(runEffect({ key: "job-5:open", payload: { a: 2 }, ...sink }, env), /effect_idempotency_conflict/);
});
