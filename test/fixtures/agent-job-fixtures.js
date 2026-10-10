// Shared helpers for the Agent Job runtime-guarantee tests (offline only).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentJobSpec } from "../../packages/core/src/agent-job-spec.js";
import { decideApproval, listApprovals } from "../../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../../packages/core/src/agent-job-runner.js";
import { listSimulatedPullRequests } from "../../packages/core/src/simulated-pr-sink.js";

export const workerPath = fileURLToPath(new URL("./agent-job-worker.mjs", import.meta.url));

export async function tempEnv(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agent-job-"));
  return { ORKESTR_HOME: home, ...extra };
}

export const prScript = [
  { say: "scanning" },
  { tool: "demo.repo.read", args: { repository: "example/repo" } },
  { tool: "demo.pull_request.create", args: { repository: "example/repo", head: "orkestr/fix-1", title: "fix" } },
  { tool: "demo.pull_request.merge", args: { repository: "example/repo", head: "orkestr/fix-1" } },
  { output: { summary: "done" } },
];

export function makeSpec({ name = "example-job", script = prScript, provider = "simulated", fallback, tools, runtime, triggers, notifications, prompt } = {}) {
  return normalizeAgentJobSpec({
    apiVersion: "orkestr/v0",
    kind: "AgentJob",
    metadata: { name },
    triggers: triggers || [{ type: "api" }, { type: "webhook", name: "issue-opened", secret_ref: "vault://example-webhook-secret", event_id: "/delivery_id" }],
    agent: { provider, ...(fallback ? { fallback } : {}) },
    task: { prompt: prompt || "Maintain example/repo.", inputs: { simulated_script: script } },
    permissions: { tools: tools || { allow: ["demo.repo.*", "demo.pull_request.create", "demo.notify.send"], approval_required: ["demo.pull_request.merge"] } },
    runtime: { max_attempts: 3, retry: { backoff: "fixed", initial_delay: "0s", max_delay: "0s" }, ...(runtime || {}) },
    ...(notifications ? { notifications } : {}),
  });
}

export async function pullRequests(env) {
  return listSimulatedPullRequests(env);
}

// Drive a run to a terminal state, approving (or denying) every approval.
export async function driveToEnd(runId, env, { decision = "approved", faults = [], rounds = 12, options = {} } = {}) {
  let result = null;
  for (let round = 0; round < rounds; round += 1) {
    try {
      result = await driveRun(runId, { faults, ...options }, env);
    } catch (error) {
      if (!error?.injectedCrash) throw error;
      continue;
    }
    if (result.state !== "awaiting_approval") return result;
    for (const approval of await listApprovals({ runId, state: "pending" }, env)) {
      await decideApproval(approval.approvalId, { decision, by: "test" }, env);
    }
  }
  return result;
}

// Run the worker fixture in a child process; resolves with exit info + JSON.
export function runWorker(env, op, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", workerPath, op, JSON.stringify(args)], {
      env: { PATH: process.env.PATH || "", TMPDIR: os.tmpdir(), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      let result = null;
      try { result = JSON.parse(stdout.trim().split("\n").pop() || "null"); } catch {}
      resolve({ code, signal, result, stderr: stderr.trim() });
    });
  });
}
