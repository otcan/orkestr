// Claude Code jobs behind a wrapper that runs Claude as another user (the
// live setup: a root server, ORKESTR_CLAUDE_CODE_BIN switching to an
// unprivileged user with setpriv). The fake simulates the uid switch
// (FAKE_CLAUDE_RUN_UID): a hook that cannot be spawned in a workspace the run
// user cannot enter is a non-blocking error, so the tool runs unchecked; the
// executor must fail closed, hand the workspace and broker socket to the run
// user, and a task the agent reports as failed must fail the run.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { claudeJobRuntimeOwner, setClaudeJobRuntimeHooksForTest } from "../packages/core/src/agent-job-claude-runtime.js";
import { decideApproval, listApprovals } from "../packages/core/src/agent-job-ledger.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { normalizeAgentJobSpec } from "../packages/core/src/agent-job-spec.js";
import { getRun, listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";

const RUN_UID = 4242;
const write = { name: "Write", input: { file_path: "HELLO.txt", content: "example\n" } };

test.afterEach(() => setClaudeJobRuntimeHooksForTest());

function spec(tools = { allow: ["claude.read"], approval_required: ["claude.write"] }) {
  return normalizeAgentJobSpec({
    apiVersion: "orkestr/v0", kind: "AgentJob", metadata: { name: "claude-run-user" }, triggers: [{ type: "api" }],
    agent: { provider: "claude-code" }, task: { prompt: "Write HELLO.txt." }, permissions: { tools },
    runtime: { max_attempts: 1, timeout: "30s" },
  });
}

// The fake behind a wrapper that "switches" to RUN_UID.
async function wrappedClaude(turns) {
  const fake = await fakeClaude(turns);
  const handover = path.join(fake.env.ORKESTR_HOME, "handover.jsonl");
  const bin = path.join(fake.env.ORKESTR_HOME, "run-as-wrapper");
  await fs.writeFile(bin, `#!/bin/sh\nFAKE_CLAUDE_RUN_UID=${RUN_UID} FAKE_CLAUDE_HANDOVER="${handover}" exec "${fake.env.ORKESTR_CLAUDE_CODE_BIN}" "$@"\n`, { mode: 0o755 });
  return { ...fake, handover, env: { ...fake.env, ORKESTR_CLAUDE_CODE_BIN: bin } };
}

// A root server: chown is recorded for the fake instead of performed.
async function asRootServer(fake, extra = {}) {
  const passwdFile = path.join(fake.env.ORKESTR_HOME, "passwd");
  await fs.writeFile(passwdFile, `root:x:0:0::/root:/bin/sh\njobrunner:x:${RUN_UID}:${RUN_UID}::/home/jobrunner:/bin/sh\n`);
  setClaudeJobRuntimeHooksForTest({
    getuid: () => 0,
    passwdFile,
    lchown: async (target, uid) => fs.appendFile(fake.handover, `${JSON.stringify({ path: target, uid })}\n`),
    ...extra,
  });
}

async function withClaude(fn) {
  const restore = setAgentJobProviderProbe("claude-code", async () => ({ connected: true }));
  try { return await fn(); } finally { restore(); }
}

test("a tool that ran without the hook fails the run closed, even when it reports a tool_use_error", async () => {
  const fake = await wrappedClaude([{ tools: [write], final: "I could not write the file." }]);
  await withClaude(async () => {
    const { run } = await admitRun({ spec: spec(), type: "api", dedupeKey: "evt-1" }, fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "failed", JSON.stringify(result));
    assert.equal((await getRun(run.id, fake.env)).error, "claude_code_permission_hook_bypassed");
    assert.deepEqual(await fake.ran(), []);
    assert.ok(!(await listCheckpoints(run.id, fake.env)).some((entry) => entry.kind === "tool_decision"), "the hook never ran");
  });
});

test("the workspace and broker socket go to the wrapper's run user: approval round trip", async () => {
  const fake = await wrappedClaude([{ tools: [write], hang: true }, { tools: [write], final: "wrote HELLO.txt" }]);
  await asRootServer(fake);
  const env = { ...fake.env, ORKESTR_AGENT_JOB_CLAUDE_RUN_USER: "jobrunner" };
  await withClaude(async () => {
    const { run } = await admitRun({ spec: spec(), type: "api", dedupeKey: "evt-1" }, env);
    assert.equal((await driveRun(run.id, {}, env)).state, "awaiting_approval");
    const [approval] = await listApprovals({ runId: run.id, state: "pending" }, env);
    assert.equal(approval.tool, "claude.write");
    await decideApproval(approval.approvalId, { decision: "approved", by: "test" }, env);
    const done = await driveRun(run.id, {}, env);
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    assert.deepEqual((await fake.ran()).map((entry) => entry.name), ["Write"]);
    const handed = (await fs.readFile(fake.handover, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(handed.some((entry) => entry.path.endsWith(run.id) && entry.uid === RUN_UID), "workspace handed over");
    assert.ok(handed.some((entry) => entry.path.endsWith("broker.sock") && entry.uid === RUN_UID), "broker socket handed over");
  });
});

test("the run user is the explicit setting, else the non-root owner of the job Claude profile", async () => {
  const fake = await fakeClaude([]);
  const handover = path.join(fake.env.ORKESTR_HOME, "handover.jsonl");
  await asRootServer({ ...fake, handover }, { stat: async () => ({ uid: 5151, gid: 5152 }) });
  assert.deepEqual(await claudeJobRuntimeOwner({ ORKESTR_AGENT_JOB_CLAUDE_RUN_USER: "jobrunner" }, { configDir: "/srv/example/profile" }), { user: "jobrunner", uid: RUN_UID, gid: RUN_UID });
  assert.deepEqual(await claudeJobRuntimeOwner({}, { configDir: "/srv/example/profile" }), { user: "5151", uid: 5151, gid: 5152 });
  assert.equal(await claudeJobRuntimeOwner({}, {}), null);
  setClaudeJobRuntimeHooksForTest({ getuid: () => 1000 });
  assert.equal(await claudeJobRuntimeOwner({ ORKESTR_AGENT_JOB_CLAUDE_RUN_USER: "jobrunner" }, {}), null, "a non-root server runs Claude as itself");
});

test("a task the agent reports as failed fails the run with the reason", async () => {
  const fake = await fakeClaude([{ final: "TASK_FAILED: the workspace is not writable" }]);
  await withClaude(async () => {
    const { run } = await admitRun({ spec: spec({ allow: [] }), type: "api", dedupeKey: "evt-1" }, fake.env);
    const result = await driveRun(run.id, {}, fake.env);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "task_error");
    assert.match((await getRun(run.id, fake.env)).error, /^agent_reported_failure: the workspace is not writable/);
  });
});
