// Approved provider-native calls (codex.file_change, claude.bash): the
// approval is consumed once when the call is executed (G7), the call is a
// native effect in the ledger with the approval's effect_key + args_hash and
// an `approved` tool decision, the resume prompt names the approved call, the
// CLI returns (and exits) as soon as a run parks, and the Claude job profile
// dir is used by both the probe and the executor. Offline, against fakes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { getRunAudit } from "../packages/core/src/agent-job-audit.js";
import { agentJobClaudeConfigDir } from "../packages/core/src/agent-job-claude-code.js";
import { decideApproval, listApprovals, listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { agentJobProviderStatus, setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { normalizeAgentJobSpec } from "../packages/core/src/agent-job-spec.js";
import { listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { codexJobEnv, readFakeCodex, useRealProviderProbes } from "./fixtures/codex-job-fixtures.js";
import { makeSpec } from "./fixtures/agent-job-fixtures.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";

const cliBin = fileURLToPath(new URL("../apps/cli/bin/orkestr-oss.js", import.meta.url));

test.afterEach(() => stopCodexJobClients());

const fileChangeScript = [{ fileChange: [{ path: "HELLO.txt", kind: "add" }] }, { final: { summary: "wrote HELLO.txt" } }];
const fileChangeTools = { allow: [], approval_required: ["codex.file_change"] };

test("an approved codex.file_change is consumed once, ledgered and journaled as an approved decision", async () => {
  useRealProviderProbes();
  const env = await codexJobEnv({ script: fileChangeScript });
  const spec = makeSpec({ name: "codex-file-job", provider: "codex", tools: fileChangeTools });
  const { run } = await admitRun({ spec, type: "api", dedupeKey: "evt-1" }, env);
  const parked = await driveRun(run.id, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  assert.deepEqual(await listRunEffects(run.id, env), [], "nothing is ledgered before the decision");
  const [pending] = await listApprovals({ runId: run.id, state: "pending" }, env);
  assert.equal(pending.tool, "codex.file_change");
  assert.deepEqual(pending.args.changes, [{ path: "HELLO.txt", kind: "add" }]);

  await decideApproval(pending.approvalId, { decision: "approved", by: "test" }, env);
  const done = await driveRun(run.id, {}, env);
  assert.equal(done.state, "succeeded", JSON.stringify(done));

  const fake = await readFakeCodex(env);
  assert.deepEqual(fake.fileChanges, [{ paths: ["HELLO.txt"], decision: "accept" }], "the change ran exactly once");
  const resumedPrompt = fake.threads[0].turns.at(-1).items[0].content[0].text;
  assert.match(resumedPrompt, /approved these exact calls[\s\S]*codex\.file_change/);

  const [approval] = await listApprovals({ runId: run.id }, env);
  assert.ok(approval.consumedAt, "the approval is single use (G7)");
  const effects = await listRunEffects(run.id, env);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].tool, "codex.file_change");
  assert.equal(effects[0].mode, "native");
  assert.equal(effects[0].state, "committed");
  assert.equal(effects[0].effectKey, approval.effectKey);
  assert.equal(effects[0].argsHash, approval.argsHash);

  const audit = await getRunAudit(run.id, env);
  assert.deepEqual(audit.tool_decisions.map((entry) => [entry.tool, entry.decision]), [
    ["codex.file_change", "approval_required"],
    ["codex.file_change", "approval_required"],
    ["codex.file_change", "approved"],
  ]);
  assert.equal(audit.approvals[0].consumed, true);
  assert.ok(!(await listCheckpoints(run.id, env)).some((entry) => entry.kind === "approval_unused"));
});

test("an approved claude.bash is ledgered as a native effect", async () => {
  const bash = { name: "Bash", input: { command: "make example" } };
  const fake = await fakeClaude([{ tools: [bash], hang: true }, { tools: [bash], final: "built" }]);
  const restore = setAgentJobProviderProbe("claude-code", async () => ({ connected: true }));
  try {
    const spec = normalizeAgentJobSpec({
      apiVersion: "orkestr/v0", kind: "AgentJob", metadata: { name: "claude-native-effect" }, triggers: [{ type: "api" }],
      agent: { provider: "claude-code" }, task: { prompt: "Build the example." },
      permissions: { tools: { approval_required: ["claude.bash"] } },
      runtime: { max_attempts: 2, retry: { backoff: "fixed", initial_delay: "0s", max_delay: "0s" } },
    });
    const { run } = await admitRun({ spec, type: "api", dedupeKey: "evt-1" }, fake.env);
    assert.equal((await driveRun(run.id, {}, fake.env)).state, "awaiting_approval");
    const [pending] = await listApprovals({ runId: run.id, state: "pending" }, fake.env);
    await decideApproval(pending.approvalId, { decision: "approved", by: "test" }, fake.env);
    assert.equal((await driveRun(run.id, {}, fake.env)).state, "succeeded");
    const effects = await listRunEffects(run.id, fake.env);
    assert.deepEqual(effects.map((effect) => [effect.tool, effect.mode, effect.state, effect.argsHash]), [["claude.bash", "native", "committed", pending.argsHash]]);
    assert.ok((await listApprovals({ runId: run.id }, fake.env))[0].consumedAt);
    assert.match((await fake.calls())[1].prompt, /approved these exact calls[\s\S]*claude\.bash/);
  } finally {
    restore();
  }
});

function runCliProcess(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cliBin, ...args], {
      cwd,
      env: { PATH: process.env.PATH || "", TMPDIR: os.tmpdir(), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("orkestr run exits promptly when the run parks, with the pending approval ids", async () => {
  const env = await codexJobEnv({ script: fileChangeScript });
  const dir = path.join(env.ORKESTR_HOME, "project");
  await fs.mkdir(path.join(dir, "jobs"), { recursive: true });
  await fs.writeFile(path.join(dir, "jobs", "file-job.yaml"), `apiVersion: orkestr/v0
kind: AgentJob
metadata:
  name: cli-file-job
triggers:
  - type: api
agent:
  provider: codex
task:
  prompt: Write HELLO.txt.
permissions:
  tools:
    approval_required: [codex.file_change]
`);
  const started = Date.now();
  const result = await runCliProcess(["run", dir, "--json"], env, dir);
  assert.equal(result.signal, null, `the CLI was killed after hanging: ${result.stderr}`);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - started < 30_000);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, "awaiting_approval");
  const pending = await listApprovals({ runId: output.runId, state: "pending" }, env);
  assert.deepEqual(output.approvalIds, pending.map((approval) => approval.approvalId));
  assert.equal(output.approvalIds.length, 1);
});

test("the Claude job profile dir is used by the provider probe and the executor", async () => {
  assert.equal(agentJobClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/srv/example/a" }), "/srv/example/a");
  assert.equal(agentJobClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/srv/example/a", ORKESTR_AGENT_JOB_CLAUDE_CONFIG_DIR: "/srv/example/job" }), "/srv/example/job");
  const fake = await fakeClaude([{ final: "ok" }]);
  const profile = path.join(fake.env.ORKESTR_HOME, "claude-job-profile");
  // The probe and executor pass only an allowlisted env, so the wrapper sets it.
  const bin = path.join(fake.env.ORKESTR_HOME, "claude-profile-wrapper");
  await fs.writeFile(bin, `#!/bin/sh\nFAKE_CLAUDE_REQUIRE_CONFIG_DIR="${profile}" exec "${fake.env.ORKESTR_CLAUDE_CODE_BIN}" "$@"\n`, { mode: 0o755 });
  const env = { ...fake.env, ORKESTR_CLAUDE_CODE_BIN: bin };
  useRealProviderProbes();
  assert.equal((await agentJobProviderStatus("claude-code", env)).reason, "not_logged_in");
  useRealProviderProbes();
  const jobEnv = { ...env, ORKESTR_AGENT_JOB_CLAUDE_CONFIG_DIR: profile };
  assert.deepEqual(await agentJobProviderStatus("claude-code", jobEnv), { provider: "claude-code", connected: true, runnable: true, reason: "logged_in" });
  const spec = normalizeAgentJobSpec({
    apiVersion: "orkestr/v0", kind: "AgentJob", metadata: { name: "claude-profile-job" }, triggers: [{ type: "api" }],
    agent: { provider: "claude-code" }, task: { prompt: "Say ok." }, permissions: { tools: { allow: [] } },
  });
  const { run } = await admitRun({ spec, type: "api", dedupeKey: "evt-1" }, jobEnv);
  assert.equal((await driveRun(run.id, {}, jobEnv)).state, "succeeded");
  assert.equal((await fake.calls())[0].configDir, profile);
});
