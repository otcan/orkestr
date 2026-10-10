// Both built-in native executors (codex on the Codex app-server, claude-code
// on `claude -p`) implement the one interface in
// packages/core/src/agent-job-native-interface.js and are driven here with the
// same recording ctx against their offline fakes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { agentJobExecutorFor, getAgentJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { claudeCodeJobAdapter } from "../packages/core/src/agent-job-claude-code.js";
import { codexJobAdapter } from "../packages/core/src/agent-job-codex.js";
import { nativeAttemptError, nativeExecutorProblems, nativeExecutorSwitch } from "../packages/core/src/agent-job-native-interface.js";
import { stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { turnErrorClassification } from "../packages/core/src/runtime-turn-error-class.js";
import { tempEnv } from "./fixtures/agent-job-fixtures.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";
import { codexJobEnv } from "./fixtures/codex-job-fixtures.js";

test.afterEach(() => stopCodexJobClients());

const executors = [
  ["codex", codexJobAdapter, "ORKESTR_AGENT_JOB_CODEX_EXECUTOR"],
  ["claude-code", claudeCodeJobAdapter, "ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR"],
];

// A ctx as agent-job-native-attempt.js builds it, recording every call.
function recordingCtx(env, provider, { decide = () => ({ decision: "allow" }) } = {}) {
  const controller = new AbortController();
  const workspace = path.join(env.ORKESTR_HOME, "native-workspace", provider);
  const seen = { events: [], authorized: [], prepared: 0 };
  const ctx = {
    runId: `run-${provider}`,
    job: "native-interface",
    attempt: 1,
    provider,
    env,
    home: env.ORKESTR_HOME,
    baseDir: env.ORKESTR_HOME,
    workspace,
    async prepareWorkspace() {
      seen.prepared += 1;
      await fs.mkdir(workspace, { recursive: true });
      return { path: workspace, kind: "directory", repository: null };
    },
    resume: null,
    signal: controller.signal,
    emit: (event) => seen.events.push(event),
    authorizeTool: async (call) => {
      seen.authorized.push(call.tool);
      return decide(call);
    },
    executeTool: async () => ({ status: "denied" }),
    toolDecision: () => "deny",
    fault: () => {},
  };
  return { ctx, seen };
}

test("codex and claude-code satisfy the shared native executor interface and provider gate", async () => {
  const env = await tempEnv();
  for (const [provider, executor, envSwitch] of executors) {
    assert.deepEqual(nativeExecutorProblems(executor), [], provider);
    assert.equal(executor.id, provider);
    assert.equal(nativeExecutorSwitch(provider), envSwitch);
    // The registry wraps the executor; the gate resolves to the executor itself.
    assert.equal(getAgentJobAdapter(provider, env).executor, executor);
    assert.equal(await agentJobExecutorFor(provider, env), executor);
    for (const off of ["0", "false", "off"]) assert.equal(await agentJobExecutorFor(provider, { ...env, [envSwitch]: off }), null);
    await assert.rejects(getAgentJobAdapter(provider, env).run({ env: { ...env, [envSwitch]: "0" } }, {}), /job_executor_unavailable/);
  }
  assert.deepEqual(nativeExecutorProblems({ id: "other", capabilities: { toolLoop: "orkestr" } }).slice(0, 2), ["jobExecutor", "run(ctx, input)"]);
});

test("native attempt errors carry the shared turn error classes", () => {
  const cases = [["auth", "provider", false], ["rate_limit", "provider", true], ["transient", "provider", true], ["permanent", "task", false]];
  for (const [errorClass, kind, retryable] of cases) {
    const error = nativeAttemptError(turnErrorClassification(errorClass, `code_${errorClass}`), { sessionRef: "session-1" });
    assert.deepEqual([error.errorClass, error.kind, error.retryable, error.code, error.sessionRef], [errorClass, kind, retryable, `code_${errorClass}`, "session-1"]);
  }
});

const scenarios = {
  codex: {
    env: (final) => codexJobEnv({ script: [{ say: "Working on it." }, { command: ["make", "release"] }, { final }] }),
    nativeTool: "codex.command",
  },
  "claude-code": {
    env: async (final) => (await fakeClaude([{ text: "Working on it.", tools: [{ name: "Bash", input: { command: "make release" } }], final: JSON.stringify(final) }])).env,
    nativeTool: "claude.bash",
  },
};

for (const [provider, executor] of executors) {
  test(`${provider}: one turn through the shared ctx (workspace, session, progress, tool hook, final output)`, async () => {
    const env = await scenarios[provider].env({ summary: "done" });
    const { ctx, seen } = recordingCtx(env, provider);
    const result = await executor.run(ctx, { prompt: "Release the example project.", inputs: {}, outputSchema: { type: "object" } });
    assert.equal(result.type, "final", JSON.stringify(result));
    assert.deepEqual(result.output, { summary: "done" });
    assert.equal(seen.prepared, 1);
    const types = seen.events.map((event) => event.type);
    for (const type of ["workspace.ready", "session.started", "message.completed"]) assert.ok(types.includes(type), `${provider} emits ${type}: ${types}`);
    assert.ok(seen.events.find((event) => event.type === "session.started").sessionRef);
    assert.deepEqual(seen.authorized, [scenarios[provider].nativeTool]);
  });

  test(`${provider}: a pending tool decision is the approval pause and parks the attempt`, async () => {
    const env = await scenarios[provider].env({ summary: "should not finish" });
    const approval = { approvalId: "approval-example-1" };
    const { ctx, seen } = recordingCtx(env, provider, { decide: () => ({ decision: "pending", approval }) });
    const result = await executor.run(ctx, { prompt: "Release the example project.", inputs: {} });
    assert.equal(result.type, "park", JSON.stringify(result));
    assert.equal(result.approval.approvalId, "approval-example-1");
    assert.deepEqual(seen.authorized, [scenarios[provider].nativeTool]);
  });
}
