// CLI for Agent Jobs: init/run need a connected provider; jobs list/status/
// approvals/approve/deny/cancel work on the local store. Offline: provider
// connectivity is faked through the probe registry.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { listApprovals } from "../packages/core/src/agent-job-ledger.js";
import { setAgentJobProviderProbe } from "../packages/core/src/agent-job-providers.js";
import { tempEnv } from "./fixtures/agent-job-fixtures.js";

// Registered before the CLI installs its real probes, so no Codex/Claude CLI
// is ever spawned here.
const connected = { codex: false, "claude-code": false };
setAgentJobProviderProbe("codex", async () => ({ connected: connected.codex, reason: connected.codex ? "logged_in" : "not_logged_in" }));
setAgentJobProviderProbe("claude-code", async () => ({ connected: connected["claude-code"], reason: "test" }));

function capture() {
  let text = "";
  return { stream: { write: (chunk) => { text += chunk; return true; } }, text: () => text };
}

function cli(env) {
  return async (argv) => {
    const out = capture();
    const err = capture();
    const code = await runCli(argv, { env, stdout: out.stream, stderr: err.stream });
    return { code, out: out.text(), err: err.text() };
  };
}

const simulatedJob = `apiVersion: orkestr/v0
kind: AgentJob
metadata:
  name: cli-job
triggers:
  - type: api
agent:
  provider: simulated
task:
  prompt: Open and merge one pull request.
  inputs:
    simulated_script:
      - tool: demo.pull_request.create
        args: { repository: example/repo, head: cli, title: t }
      - tool: demo.pull_request.merge
        args: { repository: example/repo, head: cli }
      - output: { summary: done }
permissions:
  tools:
    allow: [demo.pull_request.create]
    approval_required: [demo.pull_request.merge]
`;

test("orkestr init refuses without a connected provider and writes a job for the connected one", async () => {
  const env = await tempEnv();
  const call = cli(env);
  const dir = path.join(env.ORKESTR_HOME, "project");
  connected.codex = false;
  connected["claude-code"] = false;
  const refused = await call(["init", dir]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /connect Codex or Claude first/);
  assert.equal(await fs.stat(dir).catch(() => null), null);

  connected["claude-code"] = true;
  assert.equal((await call(["init", dir])).code, 0);
  const text = await fs.readFile(path.join(dir, "jobs", "hello-job.yaml"), "utf8");
  assert.match(text, /provider: claude-code/);
  assert.doesNotMatch(text, /simulated/);
  assert.notEqual((await call(["init", dir])).code, 0, "init must not overwrite without --force");

  connected["claude-code"] = false;
  const run = await call(["run", dir]);
  assert.notEqual(run.code, 0);
  assert.match(run.err, /connect Codex or Claude first/);
});

test("orkestr run rejects simulated job files outside tests with a clear error", async () => {
  const { validateAgentJobSpec } = await import("../packages/core/src/agent-job-spec.js");
  const { parseAgentJobYaml } = await import("../packages/core/src/agent-job-spec-yaml.js");
  const result = validateAgentJobSpec(await parseAgentJobYaml(simulatedJob), { allowTestProviders: false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => `${e.path}:${e.code}`), ["agent.provider:test_only_provider"]);
});

test("orkestr run and jobs approvals/approve/list/status/cancel", async () => {
  const env = await tempEnv();
  const call = cli(env);
  const dir = path.join(env.ORKESTR_HOME, "project");
  await fs.mkdir(path.join(dir, "jobs"), { recursive: true });
  await fs.writeFile(path.join(dir, "jobs", "cli-job.yaml"), simulatedJob);
  const ran = await call(["run", dir, "--json"]);
  assert.equal(ran.code, 0, ran.err);
  const parked = JSON.parse(ran.out);
  assert.equal(parked.state, "awaiting_approval");
  assert.match((await call(["jobs", "approvals"])).out, new RegExp(parked.approvalId));
  const approved = JSON.parse((await call(["jobs", "approve", parked.approvalId, "--json"])).out);
  assert.equal(approved.run.state, "succeeded");
  assert.notEqual((await call(["jobs", "deny", parked.approvalId])).code, 0, "a decided approval cannot be decided again");
  const listed = JSON.parse((await call(["jobs", "list", "--json"])).out);
  assert.equal(listed.runs[0].id, parked.runId);
  const status = JSON.parse((await call(["jobs", "status", parked.runId, "--json"])).out);
  assert.ok(status.audit.sealed_at);
  const second = JSON.parse((await call(["run", dir, "--no-wait", "--json"])).out);
  const cancelled = JSON.parse((await call(["jobs", "cancel", second.runId, "--json"])).out);
  assert.equal(cancelled.state, "cancelled");
  const dup = JSON.parse((await call(["run", dir, "--idempotency-key", "k", "--no-wait", "--json"])).out);
  const dup2 = JSON.parse((await call(["run", dir, "--idempotency-key", "k", "--no-wait", "--json"])).out);
  assert.equal(dup2.runId, dup.runId);
  assert.equal(dup2.deduplicated, true);
  assert.equal((await listApprovals({ state: "pending" }, env)).length, 0);
});
