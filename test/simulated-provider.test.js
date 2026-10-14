import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listExecutorAdapters, runNextThreadMessage } from "../packages/core/src/executors.js";
import { decideEffectApproval } from "../packages/core/src/effect-ledger.js";
import { listSimulatedPullRequests } from "../packages/core/src/simulated-pr-sink.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";


test("simulated provider is registered with offline capabilities", () => {
  const adapter = listExecutorAdapters().find((item) => item.id === "simulated");
  assert.ok(adapter);
  assert.equal(adapter.capabilities.requiresCredentials, false);
  assert.equal(adapter.capabilities.network, false);
  assert.equal(adapter.capabilities.ownToolLoop, false);
  assert.ok(listExecutorAdapters().some((item) => item.id === "codex"));
});

test("simulated provider resumes after an injected interrupt without a second pull request", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-simulated-provider-")) };
  const thread = await createThread({
    id: "sim-job",
    name: "sim-job",
    executor: { id: "simulated", metadata: { simulated: { jobId: "sim-job", crashAt: "after_side_effect", approvalRequired: [] } } },
  }, env);
  const message = await appendThreadMessage(thread.id, { role: "user", source: "test", text: "maintain example/repo", state: "queued" }, env);

  await assert.rejects(runNextThreadMessage(thread.id, {}, env), /simulated_interrupt:after_side_effect/);
  assert.equal((await listSimulatedPullRequests(env)).length, 1);

  await updateThreadMessage(thread.id, message.id, { state: "queued" }, env);
  const execution = await runNextThreadMessage(thread.id, {}, env);
  assert.equal(execution.state, "completed");
  assert.deepEqual(execution.result.effects, ["reconciled", "performed"]);
  const pullRequests = await listSimulatedPullRequests(env);
  assert.equal(pullRequests.length, 1);
  assert.equal(pullRequests[0].merges, 1);
  const messages = await listThreadMessages(thread.id, env);
  assert.ok(messages.some((entry) => entry.role === "assistant" && entry.source === "executor:simulated"));
});

test("simulated provider pauses approval-required tools until approved", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-simulated-approval-")) };
  const thread = await createThread({ id: "sim-approval", name: "sim-approval", executor: { id: "simulated", metadata: { simulated: { jobId: "sim-approval" } } } }, env);
  await appendThreadMessage(thread.id, { role: "user", source: "test", text: "go", state: "queued" }, env);
  const running = runNextThreadMessage(thread.id, {}, env);
  let merged = false;
  for (let i = 0; i < 200 && !merged; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const decided = await decideEffectApproval("sim-approval:merge_pull_request:1", { decision: "approved", decidedBy: "test" }, env).catch(() => null);
    merged = decided?.approval?.state === "approved";
  }
  assert.equal(merged, true);
  assert.equal((await running).state, "completed");
  assert.equal((await listSimulatedPullRequests(env))[0].state, "merged");
});

