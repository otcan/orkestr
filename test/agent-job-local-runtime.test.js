import assert from "node:assert/strict";
import test from "node:test";
import { admitRun, requestCancel } from "../packages/core/src/agent-job-admission.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { normalizeAgentJobSpec } from "../packages/core/src/agent-job-spec.js";
import { registerAgentJobTool } from "../packages/core/src/agent-job-tools.js";
import { decideApproval, listApprovals, listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { tempEnv } from "./fixtures/agent-job-fixtures.js";
import { completionEvents, localModelServer } from "./fixtures/local-model-server.js";

function spec(baseUrl, extra = {}) {
  return normalizeAgentJobSpec({ apiVersion: "orkestr/v0", kind: "AgentJob", metadata: { name: "local-fixture" }, triggers: [{ type: "api" }], agent: { provider: "openai-compatible", model: "fake-local", base_url: baseUrl }, task: { prompt: "Synthetic local task" }, runtime: { max_attempts: 1 }, ...extra });
}

test("admission and durable execution use the pinned model endpoint, not inherited cloud settings", async t => {
  const { baseUrl, seen } = await localModelServer(t);
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1", OPENAI_BASE_URL: "https://forbidden.example.invalid", OPENAI_API_KEY: "fake-secret-canary" });
  const { run } = await admitRun({ spec: spec(baseUrl) }, env);
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded"); assert.equal(result.output, "Hello");
  assert.ok(seen.filter(r => r.url === "/v1/models").length >= 2);
  assert.ok(seen.every(r => !JSON.stringify(r).includes("fake-secret-canary")));
  const checkpoints = await listCheckpoints(run.id, env);
  assert.ok(checkpoints.some(c => c.kind === "usage"));
});

test("local failures never admit a missing model or accept a cloud fallback chain", async t => {
  const { baseUrl, seen } = await localModelServer(t);
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const missing = spec(baseUrl); missing.agent.model = "missing";
  await assert.rejects(admitRun({ spec: missing }, env), /local_model_not_installed/);
  const withFallback = { apiVersion: "orkestr/v0", kind: "AgentJob", metadata: { name: "local-fallback" }, triggers: [{ type: "api" }], agent: { provider: "openai-compatible", model: "fake-local", base_url: baseUrl, fallback: [{ provider: "codex" }] }, task: { prompt: "Fake" } };
  assert.throws(() => normalizeAgentJobSpec(withFallback), /local_fallback_not_supported/);
  assert.throws(() => spec("https://forbidden.example.invalid/v1"), /local_endpoint_required/);
  assert.equal(seen.filter(r => r.url !== "/v1/models").length, 0);
});

test("tool approval and crash recovery reuse the existing effect ledger exactly once", async t => {
  let performed = 0;
  const undo = registerAgentJobTool({ name: "fixture.effect", inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false }, logicalKey: args => [args.count], perform: async () => { performed++; return { result: { count: 2 }, ref: "fixture://result" }; } }); t.after(undo);
  const { baseUrl, seen } = await localModelServer(t, body => body.messages.some(m => m.role === "tool")
    ? completionEvents({ content: "Verified count 2" })
    : completionEvents({ content: "", calls: [{ name: body.tools[0].function.name, arguments: '{"count":2}' }] }));
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const { run } = await admitRun({ spec: spec(baseUrl, { runtime: { max_attempts: 4 }, permissions: { tools: { approval_required: ["fixture.effect"] } } }) }, env);
  assert.equal((await driveRun(run.id, {}, env)).state, "awaiting_approval"); assert.equal(performed, 0);
  const [approval] = await listApprovals({ runId: run.id, state: "pending" }, env);
  await decideApproval(approval.approvalId, { decision: "approved", by: "synthetic-owner" }, env);
  await assert.rejects(driveRun(run.id, { faults: [{ at: "effect_committed" }] }, env), /injected_crash/);
  assert.equal(performed, 1);
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded"); assert.equal(performed, 1);
  assert.equal((await listRunEffects(run.id, env)).length, 1);
  assert.ok(seen.some(r => r.body?.messages?.some(m => m.role === "tool" && JSON.parse(m.content).result?.count === 2)));
});

test("cancelling a running local job closes inference and finalizes cancelled", async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { baseUrl } = await localModelServer(t, (_body, _req, res) => { res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); started(); });
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const { run } = await admitRun({ spec: spec(baseUrl) }, env);
  const running = driveRun(run.id, {}, env);
  await ready; await requestCancel(run.id, { by: "synthetic-owner" }, env);
  const result = await running;
  assert.equal(result.state, "cancelled"); assert.equal(result.output, null);
});

test("a stalled stream times out with no successful output", async t => {
  const { baseUrl } = await localModelServer(t, (_body, _req, res) => { res.write('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n'); });
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const { run } = await admitRun({ spec: spec(baseUrl, { runtime: { max_attempts: 1, timeout: "1s" } }) }, env);
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "failed"); assert.equal(result.output, null);
});

test("turning the feature off after admission prevents inference", async t => {
  const { baseUrl, seen } = await localModelServer(t);
  const env = await tempEnv({ ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const { run } = await admitRun({ spec: spec(baseUrl) }, env);
  env.ORKESTR_PERSONAL_AGENT_ENABLED = "0";
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "failed"); assert.equal(result.output, null);
  assert.equal(seen.filter(r => r.url === "/v1/chat/completions").length, 0);
});
