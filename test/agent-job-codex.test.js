// The `codex` Agent Job executor (packages/core/src/agent-job-codex.js) against
// the fake Codex app-server: provider gate, default-deny tool routing, Codex
// approvals mapped to runner approvals, cancellation, resume after a restart,
// structured output and error classes. Offline, no Codex login needed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitRun, requestCancel } from "../packages/core/src/agent-job-admission.js";
import { agentJobExecutorFor, registerAgentJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { codexJobAdapter } from "../packages/core/src/agent-job-codex.js";
import { agentJobProviderStatus } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { listThreads } from "../packages/core/src/threads.js";
import { codexJobEnv, driveCodexRun, readFakeCodex, useRealProviderProbes } from "./fixtures/codex-job-fixtures.js";
import { makeSpec } from "./fixtures/agent-job-fixtures.js";

test.afterEach(() => stopCodexJobClients());

function codexSpec({ tools, prompt, outputSchema, runtime } = {}) {
  const spec = makeSpec({ name: "codex-job", provider: "codex", prompt, runtime, tools: tools || { allow: ["demo.repo.*"], approval_required: [] } });
  if (outputSchema) spec.task.outputSchema = outputSchema;
  return spec;
}

async function admit(env, spec, key = "evt-1") {
  return (await admitRun({ spec, type: "api", dedupeKey: key }, env)).run;
}

test("codex is runnable only when logged in and the codex job executor is registered", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv();
  assert.equal((await agentJobExecutorFor("codex", env))?.jobExecutor, "codex-app-server");
  assert.deepEqual(await agentJobProviderStatus("codex", env), { provider: "codex", connected: true, runnable: true, reason: "logged_in" });

  useRealProviderProbes();
  const loggedOut = await codexJobEnv({ loggedIn: false });
  assert.deepEqual(await agentJobProviderStatus("codex", loggedOut), { provider: "codex", connected: false, runnable: false, reason: "not_logged_in" });

  const restore = registerAgentJobAdapter({ id: "codex", capabilities: { toolLoop: "native" }, async run() { return {}; } });
  try {
    useRealProviderProbes();
    assert.deepEqual(await agentJobProviderStatus("codex", env), { provider: "codex", connected: true, runnable: false, reason: "job_executor_unavailable" });
  } finally {
    restore();
  }
});

test("tools outside permissions.tools are denied: not exposed, refused if called, Codex commands declined", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [
    { tool: "demo.repo.read", args: { repository: "example/repo" } },
    { tool: "demo.notify.send", args: { text: "should never be sent" }, force: true },
    { command: ["rm", "-rf", "build"] },
    { final: { summary: "done" } },
  ] });
  const run = await admit(env, codexSpec());
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  const fake = await readFakeCodex(env);
  assert.deepEqual(fake.threads[0].dynamicTools, ["demo__repo__read"]);
  assert.deepEqual(fake.toolCalls.map((call) => [call.tool, call.success]), [["demo.repo.read", true], ["demo.notify.send", false]]);
  assert.match(fake.toolCalls[1].text, /denied/);
  assert.deepEqual(fake.commandDecisions, [{ command: ["rm", "-rf", "build"], decision: "decline" }]);
  await assert.rejects(fs.stat(path.join(env.ORKESTR_HOME, "simulated", "sent-notes.jsonl")));
  const decisions = (await listCheckpoints(run.id, env)).filter((entry) => entry.kind === "tool_decision").map((entry) => [entry.data.tool, entry.data.decision]);
  assert.deepEqual(decisions, [["demo.repo.read", "allow"], ["demo.notify.send", "deny"], ["codex.command", "deny"]]);
  assert.deepEqual(await listThreads(env), []);
});

test("an approval_required Codex command parks the run; approve grants it once on the resumed session", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [{ command: ["make", "release"] }, { final: { summary: "released" } }] });
  const run = await admit(env, codexSpec({ tools: { allow: [], approval_required: ["codex.command"] } }));
  const parked = await driveRun(run.id, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  assert.ok(parked.approvalId);
  const result = await driveCodexRun(run.id, env);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(result.parked[0].tool, "codex.command");
  assert.deepEqual(result.parked[0].args, { command: "make release", cwd: (await readFakeCodex(env)).threads[0].cwd });
  const fake = await readFakeCodex(env);
  assert.deepEqual(fake.commandDecisions, [{ command: ["make", "release"], decision: "accept" }]);
  assert.ok(fake.calls.some((call) => call.method === "turn/interrupt"), "the parked turn was interrupted");
});

test("a denied Codex command approval is declined and the run continues", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [{ command: ["make", "release"] }, { final: { summary: "skipped release" } }] });
  const run = await admit(env, codexSpec({ tools: { allow: [], approval_required: ["codex.command"] } }));
  const result = await driveCodexRun(run.id, env, { decision: "denied" });
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual((await readFakeCodex(env)).commandDecisions, [{ command: ["make", "release"], decision: "decline" }]);
});

test("cancel interrupts the active Codex turn", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [{ say: "working" }, { wait: true }] });
  const run = await admit(env, codexSpec());
  const driving = driveRun(run.id, {}, env);
  for (let i = 0; i < 200 && !(await listCheckpoints(run.id, env)).some((entry) => entry.kind === "progress"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await requestCancel(run.id, { by: "test" }, env);
  const result = await driving;
  assert.equal(result.state, "cancelled");
  assert.ok((await readFakeCodex(env)).calls.some((call) => call.method === "turn/interrupt"));
});

test("after a crash and app-server restart the next attempt resumes the same Codex session", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [{ final: { summary: "resumed" } }] });
  const run = await admit(env, codexSpec());
  await assert.rejects(driveRun(run.id, { faults: [{ at: "codex_session_started", attempts: [1] }] }, env), /injected_crash/);
  stopCodexJobClients();
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.output, { summary: "resumed" });
  const fake = await readFakeCodex(env);
  assert.equal(fake.spawnCount, 2);
  assert.equal(fake.calls.filter((call) => call.method === "thread/start").length, 1);
  assert.ok(fake.calls.some((call) => call.method === "thread/resume" && call.threadId === "thr_001"));
  const sessions = (await listCheckpoints(run.id, env)).filter((entry) => entry.kind === "codex_session").map((entry) => entry.data);
  assert.deepEqual(sessions, [{ sessionRef: "thr_001", resumed: false }, { sessionRef: "thr_001", resumed: true }]);
});

test("final output is validated against output_schema and re-asked once", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: [{ final: "Done, no JSON." }, { final: "```json\n{\"summary\":\"fixed\"}\n```" }] });
  const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
  const run = await admit(env, codexSpec({ outputSchema: schema }));
  const result = await driveRun(run.id, {}, env);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.output, { summary: "fixed" });
  assert.ok((await listCheckpoints(run.id, env)).some((entry) => entry.kind === "output_repair"));
});

test("Codex turn failures map to provider/task errors", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv();
  const auth = await admit(env, codexSpec({ prompt: "Do it [scenario:fault:auth]" }), "auth");
  const authResult = await driveRun(auth.id, {}, env);
  assert.equal(authResult.state, "failed");
  assert.equal(authResult.reason, "provider_error");
  assert.doesNotMatch(JSON.stringify(authResult), /sk-fake-conformance/);

  const permanent = await admit(env, codexSpec({ prompt: "Do it [scenario:fault:permanent]" }), "permanent");
  const permanentResult = await driveRun(permanent.id, {}, env);
  assert.equal(permanentResult.state, "failed");
  assert.equal(permanentResult.reason, "task_error");

  const transient = await admit(env, codexSpec({ prompt: "Do it [scenario:fault:transient]", runtime: { max_attempts: 2, retry: { backoff: "fixed", initial_delay: "60s", max_delay: "60s" } } }), "transient");
  assert.equal((await driveRun(transient.id, {}, env)).state, "retrying");
  assert.equal(codexJobAdapter.capabilities.permissionHook, "pre_call");
});
