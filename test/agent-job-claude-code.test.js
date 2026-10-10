// Claude Code job executor (agent-job-claude-code.js) against the fake Claude
// CLI in fixtures/fake-claude-job.mjs: internal workspace, run-journal
// progress, per-call permission hook (allow / deny / approval_required),
// session resume after an approval, cancel, timeout, fail-closed hook bypass
// and error classes. Offline: no Claude login or network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitRun, requestCancel } from "../packages/core/src/agent-job-admission.js";
import { agentJobExecutorFor } from "../packages/core/src/agent-job-adapters.js";
import { claudeCodeJobAdapter, claudeJobOutput } from "../packages/core/src/agent-job-claude-code.js";
import { decideApproval, listApprovals } from "../packages/core/src/agent-job-ledger.js";
import { nativeToolName } from "../packages/core/src/agent-job-permission-broker.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { normalizeAgentJobSpec } from "../packages/core/src/agent-job-spec.js";
import { listAttemptsSync, listCheckpoints, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import { agentJobWorkspacePath } from "../packages/core/src/agent-job-workspace.js";
import { tempEnv } from "./fixtures/agent-job-fixtures.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";

function claudeSpec({ name = "claude-job", tools = { allow: ["claude.read"] }, runtime = {}, outputSchema } = {}) {
  return normalizeAgentJobSpec({
    apiVersion: "orkestr/v0",
    kind: "AgentJob",
    metadata: { name },
    triggers: [{ type: "api" }],
    agent: { provider: "claude-code" },
    task: { prompt: "Summarize the example repository.", ...(outputSchema ? { output_schema: outputSchema } : {}) },
    permissions: { tools },
    runtime: { max_attempts: 2, retry: { backoff: "fixed", initial_delay: "0s", max_delay: "0s" }, ...runtime },
  });
}

async function withConnectedClaude(fn) {
  const restore = setAgentJobProviderProbe("claude-code", async () => ({ connected: true }));
  try { return await fn(); } finally { restore(); }
}

async function admit(spec, env, key = "evt-1") {
  return (await admitRun({ spec, type: "api", dedupeKey: key }, env)).run;
}

async function journal(runId, env) {
  return listCheckpoints(runId, env);
}

test("claude-code is runnable only through a registered job executor, which an env switch disables", async () => {
  const env = await tempEnv();
  assert.equal(await agentJobExecutorFor("claude-code", env), claudeCodeJobAdapter);
  assert.equal(claudeCodeJobAdapter.capabilities.permissionHook, "pre_call");
  assert.equal(await agentJobExecutorFor("claude-code", { ...env, ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR: "0" }), null);
  assert.equal((await agentJobExecutorFor("codex", env))?.jobExecutor, "codex-app-server");
});

test("tool names map onto job policy names", () => {
  assert.equal(nativeToolName("Bash"), "claude.bash");
  assert.equal(nativeToolName("WebFetch"), "claude.webfetch");
  assert.equal(nativeToolName("mcp__Example_Server__send_mail"), "mcp.example_server.send_mail");
  assert.deepEqual(claudeJobOutput("```json\n{\"summary\":\"x\"}\n```", { type: "object" }), { summary: "x" });
  assert.deepEqual(claudeJobOutput("plain", null), { text: "plain" });
});

test("a run executes in the internal workspace, journals progress and returns the structured output", async () => {
  const fake = await fakeClaude([{ text: "Reading the repository.", tools: [{ name: "Read", input: { file_path: "README.md" } }], final: "{\"summary\":\"ok\"}" }]);
  await withConnectedClaude(async () => {
    const spec = claudeSpec({ outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } });
    const run = await admit(spec, fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output, { summary: "ok" });
    const [call] = await fake.calls();
    assert.equal(call.cwd, agentJobWorkspacePath(fake.env.ORKESTR_HOME, run.job, run.id));
    assert.equal(call.hooks, 1);
    assert.equal(call.strictMcp, true);
    assert.equal(call.permissionMode, "default");
    assert.equal(call.home, fake.env.HOME, "the host login HOME is used");
    assert.deepEqual(call.leaked, [], "no ORKESTR_* env reaches the provider");
    assert.match(call.prompt, /Summarize the example repository/);
    assert.deepEqual((await fake.ran()).map((entry) => entry.name), ["Read"]);
    const kinds = (await journal(run.id, fake.env)).map((entry) => [entry.kind, entry.data.type || entry.data.decision || ""]);
    for (const expected of [["session_started", ""], ["progress", "message"], ["progress", "tool"], ["tool_decision", "allow"], ["progress", "tool_result"], ["usage", ""], ["final_output", ""]]) {
      assert.ok(kinds.some(([kind, detail]) => kind === expected[0] && detail === expected[1]), `journal has ${expected.join(":")}: ${JSON.stringify(kinds)}`);
    }
    assert.ok(!JSON.stringify(await journal(run.id, fake.env)).includes("must-not-leak"));
  });
});

test("unlisted and denied tools never run; the model is told and the run continues", async () => {
  const fake = await fakeClaude([{ tools: [{ name: "Write", input: { file_path: "x", content: "y" } }, { name: "Bash", input: { command: "true" } }], final: "finished without writing" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec({ tools: { allow: ["claude.read"], deny: ["claude.bash"] } }), fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "succeeded");
    assert.deepEqual(await fake.ran(), []);
    const decisions = (await journal(run.id, fake.env)).filter((entry) => entry.kind === "tool_decision").map((entry) => [entry.data.tool, entry.data.decision]);
    assert.deepEqual(decisions, [["claude.write", "deny"], ["claude.bash", "deny"]]);
  });
});

test("approval_required parks the run before the call runs; approve resumes the same session and runs it once", async () => {
  const bash = { name: "Bash", input: { command: "git push origin example-branch" } };
  const fake = await fakeClaude([{ tools: [bash], hang: true }, { tools: [bash], final: "pushed" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec({ tools: { allow: ["claude.read"], approval_required: ["claude.bash"] } }), fake.env);
    const parked = await driveRun(run.id, {}, fake.env);
    assert.equal(parked.state, "awaiting_approval");
    assert.deepEqual(await fake.ran(), [], "nothing runs before the decision");
    const [approval] = await listApprovals({ runId: run.id, state: "pending" }, fake.env);
    assert.equal(approval.tool, "claude.bash");
    assert.deepEqual(approval.args, bash.input);
    await decideApproval(approval.approvalId, { decision: "approved", by: "test" }, fake.env);
    const done = await driveRun(run.id, {}, fake.env);
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    assert.deepEqual((await fake.ran()).map((entry) => entry.input.command), ["git push origin example-branch"]);
    const calls = await fake.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].resumed && calls[1].resumed.startsWith("fake-claude-session-"), "second attempt resumes the session");
    assert.match(calls[1].prompt, /after an approval decision/);
    const attempts = listAttemptsSync(await openAgentJobDb(fake.env), run.id).map((attempt) => attempt.endReason);
    assert.deepEqual(attempts, ["approval_wait", "completed"]);
  });
});

test("a denied approval is enforced on the resumed call", async () => {
  const bash = { name: "Bash", input: { command: "rm -rf build" } };
  const fake = await fakeClaude([{ tools: [bash], hang: true }, { tools: [bash], final: "skipped the cleanup" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec({ tools: { approval_required: ["claude.bash"] } }), fake.env);
    assert.equal((await driveRun(run.id, {}, fake.env)).state, "awaiting_approval");
    const [approval] = await listApprovals({ runId: run.id, state: "pending" }, fake.env);
    await decideApproval(approval.approvalId, { decision: "denied", by: "test" }, fake.env);
    const done = await driveRun(run.id, {}, fake.env);
    assert.equal(done.state, "succeeded");
    assert.deepEqual(await fake.ran(), []);
  });
});

test("a tool result that never passed the hook fails the attempt closed", async () => {
  const fake = await fakeClaude([{ tools: [{ name: "Read", input: {} }], skipHook: true }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec(), fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "failed");
    const [attempt] = listAttemptsSync(await openAgentJobDb(fake.env), run.id);
    assert.equal(attempt.error, "claude_code_permission_hook_bypassed");
  });
});

test("hook inputs without tool_use_id are matched by tool name", async () => {
  const fake = await fakeClaude([{ tools: [{ name: "Read", input: { file_path: "a" } }, { name: "Read", input: { file_path: "b" } }], noToolUseId: true, final: "read both" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec(), fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    assert.equal((await fake.ran()).length, 2);
  });
});

test("cancel kills the provider process and the run ends cancelled", async () => {
  const fake = await fakeClaude([{ text: "working", slow: true }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec(), fake.env);
    const started = Date.now();
    const driving = driveRun(run.id, {}, fake.env);
    for (let i = 0; i < 100 && !(await fake.calls()).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await requestCancel(run.id, { by: "test" }, fake.env);
    const result = await driving;
    assert.equal(result.state, "cancelled");
    assert.ok(Date.now() - started < 10_000, "cancelled well before the slow turn would finish");
  });
});

test("the attempt timeout kills the process and is classified retryable", async () => {
  const fake = await fakeClaude([{ slow: true }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec({ runtime: { timeout: "1s", max_attempts: 1 } }), fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "failed");
    const [attempt] = listAttemptsSync(await openAgentJobDb(fake.env), run.id);
    assert.equal(attempt.endReason, "timeout");
  });
});

test("provider errors are classified: auth is not retried, rate limits back off", async () => {
  const auth = await fakeClaude([{ fail: "auth" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec(), auth.env);
    const result = await driveRun(run.id, {}, auth.env);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "provider_error");
    assert.equal((await auth.calls()).length, 1);
  });
  const rate = await fakeClaude([{ fail: "rate" }, { final: "{\"summary\":\"later\"}" }]);
  await withConnectedClaude(async () => {
    const run = await admit(claudeSpec(), rate.env);
    const result = await driveRun(run.id, { waitForBackoff: true }, rate.env);
    assert.equal(result.state, "succeeded");
    assert.deepEqual(result.output, { text: "{\"summary\":\"later\"}" });
    const calls = await rate.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].resumed, "the retry resumes the session it started");
  });
});

test("the hook blocks (exit 2) when no broker answers", async () => {
  const hook = fileURLToPath(new URL("../packages/core/src/agent-job-claude-permission-hook.js", import.meta.url));
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "toolu_x" });
  const missing = spawnSync(process.execPath, [hook], { input, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(missing.status, 2);
  const dead = spawnSync(process.execPath, [hook], { input, encoding: "utf8", env: { PATH: process.env.PATH, ORKESTR_AGENT_JOB_PERMISSION_SOCKET: "/nonexistent/broker.sock", ORKESTR_AGENT_JOB_PERMISSION_TOKEN: "t" } });
  assert.equal(dead.status, 2);
  assert.match(dead.stderr, /Orkestr blocked this tool call/);
});
