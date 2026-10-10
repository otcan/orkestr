// Honest provider gate (owner decision 2026-10-10): jobs are admitted and
// started only on providers that are connected AND have a job executor.
// Offline: probes are faked through the registry, no CLI is spawned.
import assert from "node:assert/strict";
import test from "node:test";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { agentJobExecutorFor } from "../packages/core/src/agent-job-adapters.js";
import { handleAgentJobTrigger } from "../packages/core/src/agent-job-http.js";
import { agentJobProviderStatus, setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { listRuns, listTriggerAudit, registerJobSpec } from "../packages/core/src/agent-job-store.js";
import { registerExecutorAdapter } from "../packages/core/src/executors.js";
import { makeSpec, tempEnv } from "./fixtures/agent-job-fixtures.js";

test("the no-op fallback never counts as a job executor; codex uses the app-server job executor", async () => {
  const env = await tempEnv();
  assert.equal((await agentJobExecutorFor("codex", env))?.jobExecutor, "codex-app-server");
  assert.equal(await agentJobExecutorFor("claude-code", env), null);
  assert.equal(await agentJobExecutorFor("simulated", env), null);
});

test("unconnected or executor-less providers are refused at admission and the refusal is audited", async () => {
  const env = await tempEnv();
  const restore = setAgentJobProviderProbe("codex", async () => ({ connected: true, runnable: false, reason: "job_executor_unavailable" }));
  try {
    assert.deepEqual(await agentJobProviderStatus("codex", env), { provider: "codex", connected: true, runnable: false, reason: "job_executor_unavailable" });
    assert.equal((await agentJobProviderStatus("claude-code", env)).runnable, false, "no probe means not connected");
    const spec = makeSpec({ name: "codex-job", provider: "codex" });
    await assert.rejects(admitRun({ spec, type: "api", dedupeKey: "evt-1" }, env), (error) => {
      assert.equal(error.code, "provider_not_connected");
      assert.match(error.message, /no job executor/);
      return true;
    });
    await registerJobSpec(spec, {}, env);
    const http = await handleAgentJobTrigger({ name: "codex-job", principal: { role: "admin" }, headers: { "idempotency-key": "evt-2" } }, env);
    assert.equal(http.statusCode, 409);
    assert.equal(http.body.error, "provider_not_connected");
    const claude = makeSpec({ name: "claude-job", provider: "claude-code" });
    await assert.rejects(admitRun({ spec: claude, type: "api", dedupeKey: "evt-3" }, env), /connect Codex or Claude first/);
    assert.equal((await listRuns({}, env)).length, 0);
    const audit = await listTriggerAudit({}, env);
    assert.deepEqual(audit.map((entry) => [entry.job, entry.outcome, entry.reason]).reverse(), [
      ["codex-job", "rejected", "provider_not_connected:job_executor_unavailable"],
      ["codex-job", "rejected", "provider_not_connected:job_executor_unavailable"],
      ["claude-job", "rejected", "provider_not_connected:provider_not_connected"],
    ]);
  } finally {
    restore();
  }
});

test("a real executor registered for claude-code makes it runnable and is used for the attempt", async () => {
  const env = await tempEnv();
  const seen = [];
  registerExecutorAdapter({ id: "claude-code", label: "Example overlay executor", async run({ message }) { seen.push(message.text); return { output: "overlay done" }; } });
  assert.equal((await agentJobExecutorFor("claude-code", env))?.id, "claude-code");
  const restore = setAgentJobProviderProbe("claude-code", async () => ({ connected: true }));
  try {
    const { run } = await admitRun({ spec: makeSpec({ name: "claude-job", provider: "claude-code" }), type: "api", dedupeKey: "evt", body: { issue: 7 } }, env);
    const result = await driveRun(run.id, {}, env);
    assert.equal(result.state, "succeeded");
    assert.equal(result.output, "overlay done");
    assert.match(seen[0], /Trigger event:[\s\S]*"issue": 7/);
  } finally {
    restore();
  }
});
