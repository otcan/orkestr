import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { runEffect } from "./effect-ledger.js";
import {
  findSimulatedPullRequest,
  mergeSimulatedPullRequest,
  openSimulatedPullRequest,
} from "./simulated-pr-sink.js";

// Deterministic, credential-free provider for demos, tests and contributors.
// It scripts one agent turn: progress events, an authorized side effect (open a
// pull request), an optional injected crash, an approval-gated side effect
// (merge), and a final answer. Unlike Codex or Claude Code it has no tool loop
// of its own, so Orkestr runs the tool calls through the effect ledger.

export const simulatedProviderCapabilities = Object.freeze({
  requiresCredentials: false,
  network: false,
  ownToolLoop: false,
  streaming: false,
  interrupts: true,
  deterministic: true,
});

export const crashPoints = Object.freeze(["after_side_effect", "before_final"]);

function clean(value = "") {
  return String(value ?? "").trim();
}

function simulatedConfig(thread = {}) {
  const config = thread?.executor?.metadata?.simulated;
  return config && typeof config === "object" ? config : {};
}

async function nextAttempt(jobId, env) {
  const paths = await ensureDataDirs(env);
  const filePath = path.join(paths.home, "simulated", "attempts.json");
  const attempts = await readJson(filePath, {});
  const attempt = Number(attempts[jobId] || 0) + 1;
  await writeJson(filePath, { ...attempts, [jobId]: attempt });
  return attempt;
}

class SimulatedInterrupt extends Error {
  constructor(point) {
    super(`simulated_interrupt:${point}`);
    this.code = "simulated_interrupt";
    this.crashPoint = point;
  }
}

async function maybeCrash(point, { config, attempt, jobId, executionId }, env) {
  if (clean(config.crashAt) !== point) return;
  if (attempt > Math.max(1, Number(config.crashOnAttempts || 1))) return;
  await appendEvent({ type: "simulated_provider_crash", jobId, executionId, attempt, crashPoint: point, mode: config.crashMode || "throw" }, env);
  // "exit" kills the process without cleanup, like an OOM kill or power loss.
  if (config.crashMode === "exit") process.kill(process.pid, "SIGKILL");
  throw new SimulatedInterrupt(point);
}

export async function runSimulatedTurn({ thread, message, execution, env = process.env } = {}) {
  const config = simulatedConfig(thread);
  const jobId = clean(config.jobId) || clean(thread?.id) || "simulated-job";
  const repository = clean(config.repository) || "example/repo";
  const approvalRequired = new Set(Array.isArray(config.approvalRequired) ? config.approvalRequired : ["merge_pull_request"]);
  const executionId = execution?.id || null;
  const attempt = await nextAttempt(jobId, env);
  const context = { config, attempt, jobId, executionId };
  const progress = (step, detail) =>
    appendEvent({ type: "simulated_provider_progress", jobId, executionId, attempt, step, detail }, env);
  const toolCall = (tool, input, effect) =>
    appendEvent({ type: "simulated_provider_tool_call", jobId, executionId, attempt, tool, input, effectStatus: effect.status }, env);

  await progress("started", clean(message?.text).slice(0, 200));
  await progress("analyzing", `Scanning ${repository} for outdated dependencies`);

  const openInput = { repository, title: "chore: bump example-lib to 2.0.1", head: `orkestr/${jobId}` };
  const opened = await runEffect({
    key: `${jobId}:open_pull_request`,
    kind: "pull_request.open",
    jobId,
    attempt,
    payload: openInput,
    approval: approvalRequired.has("open_pull_request") ? "required" : "none",
    waitForApproval: { timeoutMs: config.approvalTimeoutMs },
    perform: ({ idempotencyKey }) => openSimulatedPullRequest({ ...openInput, idempotencyKey }, env),
    reconcile: (effect) => findSimulatedPullRequest(effect.key, env),
    afterPerform: () => maybeCrash("after_side_effect", context, env),
  }, env);
  await toolCall("open_pull_request", openInput, opened);
  const pullRequest = opened.result;

  const mergeInput = { repository, number: pullRequest.number };
  const merged = await runEffect({
    key: `${jobId}:merge_pull_request:${pullRequest.number}`,
    kind: "pull_request.merge",
    jobId,
    attempt,
    payload: mergeInput,
    approval: approvalRequired.has("merge_pull_request") ? "required" : "none",
    waitForApproval: { timeoutMs: config.approvalTimeoutMs },
    onApprovalRequested: () => progress("awaiting_approval", `merge_pull_request #${pullRequest.number} requires approval`),
    perform: () => mergeSimulatedPullRequest(pullRequest.number, env),
    reconcile: async () => {
      const current = await findSimulatedPullRequest(pullRequest.idempotencyKey, env);
      return current?.state === "merged" ? current : null;
    },
  }, env);
  await toolCall("merge_pull_request", mergeInput, merged);

  await maybeCrash("before_final", context, env);
  const output = `Opened and merged ${repository}#${pullRequest.number} (${pullRequest.title}).`;
  await progress("final_answer", output);
  return { output, jobId, attempt, pullRequestNumber: pullRequest.number, effects: [opened.status, merged.status] };
}

export const simulatedExecutorAdapter = Object.freeze({
  id: "simulated",
  label: "Simulated provider",
  description: "Deterministic offline provider for demos and tests. Needs no credentials or network.",
  capabilities: simulatedProviderCapabilities,
  run: runSimulatedTurn,
});
