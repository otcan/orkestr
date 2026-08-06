import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { codexSandboxForThread, threadStartParams } from "../packages/core/src/codex-app-server-common.js";
import { listTaskAgentProfiles } from "../packages/core/src/task-agent-profiles.js";
import {
  cancelTaskAgent,
  completeTaskAgentFromMessage,
  createTaskAgent,
  finishTaskAgentTurn,
  listTaskAgents,
  reconcileTaskAgentStatus,
  taskAgentSummary,
} from "../packages/core/src/task-agents.js";
import { renderOpenMetrics, resetObservabilityForTests } from "../packages/core/src/observability.js";
import { appendThreadMessage, createThread, deleteThread, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { listThreadWorkers } from "../packages/core/src/thread-workers.js";

async function testEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-task-agent-"));
  return {
    ORKESTR_HOME: path.join(home, "data"),
    ORKESTR_RUNTIME_CODEX_COMMAND: "codex --dangerously-bypass-approvals-and-sandbox",
  };
}

test("SRE task agents share the parent workspace without a worktree and narrow YOLO policy", async () => {
  const env = await testEnv();
  const workspace = path.dirname(env.ORKESTR_HOME);
  const parent = await createThread({
    id: "parent-thread",
    name: "Parent",
    cwd: workspace,
    executorId: "codex",
    executor: { type: "codex" },
  }, env);

  const created = await createTaskAgent(parent.id, {
    profile: "sre_engineer",
    task: "Explain why the service is restarting.",
    contextRefs: ["watcher logs", "watcher logs", "release alpha.163"],
  }, env);
  const child = created.taskAgent;

  assert.equal(child.threadKind, "task-agent");
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.cwd, workspace);
  assert.equal(child.workspace, workspace);
  assert.equal(child.worktreePath, null);
  assert.equal(child.binding, null);
  assert.equal(child.codexSandbox, "read-only");
  assert.equal(child.codexApprovalPolicy, "never");
  assert.deepEqual(child.agentContextRefs, ["watcher logs", "release alpha.163"]);
  assert.equal(codexSandboxForThread(child, env), "read-only");
  const start = threadStartParams(child, env);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.match(start.developerInstructions, /evidence-first investigation/i);
  assert.match(start.developerInstructions, /Operate read-only/i);

  const second = await createTaskAgent(parent.id, {
    profile: "sre_engineer",
    task: "Check the release health.",
  }, env);
  assert.notEqual(second.taskAgent.id, child.id);
  assert.notEqual(second.taskAgent.name, child.name);
  const tasks = await listTaskAgents(parent.id, env);
  assert.equal(tasks.length, 2);
  assert.equal((await listThreadWorkers(parent.id, env)).length, 0);
  const messages = await listThreadMessages(child.id, env);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "orkestr_task_agent_handoff");
  assert.match(messages[0].text, /Explain why the service is restarting/);
});

test("task agent final answers are steered back to the parent exactly once", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "result-parent", name: "Result Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, {
    task: "Diagnose the failed readiness probe.",
  }, env);
  const result = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "Summary\nThe readiness endpoint returns 503.\n\nRoot cause\nThe dependency probe is failing.",
    state: "completed",
  }, env);

  await completeTaskAgentFromMessage(taskAgent, result, env, { deliver: false });
  await completeTaskAgentFromMessage(taskAgent, result, env, { deliver: false });

  const parentMessages = await listThreadMessages(parent.id, env);
  const callbacks = parentMessages.filter((message) => message.source === "orkestr_task_agent_result");
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].role, "user");
  assert.equal(callbacks[0].state, "queued");
  assert.equal(callbacks[0].steerActiveTurn, true);
  assert.equal(callbacks[0].codexDeliveryMode, "instant_steer");
  assert.match(callbacks[0].text, /The readiness endpoint returns 503/);

  const current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "completed");
  assert.equal(current.agentParentResultMessageId, callbacks[0].id);
  const summary = await taskAgentSummary(current, env);
  assert.equal(summary.status, "completed");
  assert.equal(summary.result.messageId, result.id);
});

test("task agent lifecycle transitions update observability counters", async () => {
  resetObservabilityForTests();
  const env = await testEnv();
  const parent = await createThread({ id: "metric-parent", name: "Metric Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, {
    task: "Return lifecycle metrics.",
  }, env);
  const result = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "Lifecycle metric evidence.",
    state: "completed",
  }, env);

  await completeTaskAgentFromMessage(taskAgent, result, env, { deliver: false });

  const metrics = renderOpenMetrics();
  assert.match(metrics, /orkestr_task_agent_lifecycle_total\{event="created",status="queued"\} 1/);
  assert.match(metrics, /orkestr_task_agent_lifecycle_total\{event="result_completed",status="completed"\} 1/);
});

test("task agent terminal handoffs are serialized when completion signals race", async () => {
  const env = await testEnv();
  env.ORKESTR_TASK_AGENT_RESULT_GRACE_MS = "5000";
  const parent = await createThread({ id: "race-parent", name: "Race Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Inspect the race." }, env);
  const result = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "The task completed with evidence.",
    state: "completed",
  }, env);

  await Promise.all([
    completeTaskAgentFromMessage(taskAgent, result, env, { deliver: false }),
    finishTaskAgentTurn(taskAgent, { status: "completed" }, env, { deliver: false }),
  ]);

  const parentMessages = (await listThreadMessages(parent.id, env))
    .filter((message) => message.source === "orkestr_task_agent_result");
  assert.equal(parentMessages.length, 1);
  const current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "completed");
});

test("task agent summary reconciles active runtime to working", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "active-runtime-parent", name: "Active Runtime Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Inspect active runtime." }, env);
  await updateThread(taskAgent.id, {
    agentTaskStatus: "queued",
    runtime: {
      ...(taskAgent.runtime || {}),
      runtimeKind: "codex-app-server",
      state: "working",
      activeTurnId: "active-runtime-turn",
      codexStatus: { type: "active", activeFlags: ["running"] },
    },
  }, env);

  const summary = await taskAgentSummary(taskAgent.id, env);
  const current = await getThread(taskAgent.id, env);

  assert.equal(summary.status, "working");
  assert.equal(current.agentTaskStatus, "working");
});

test("task agent concurrency uses reconciled active runtime status", async () => {
  const env = { ...await testEnv(), ORKESTR_TASK_AGENT_MAX_ACTIVE_PER_THREAD: "1" };
  const parent = await createThread({ id: "active-concurrency-parent", name: "Active Concurrency Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, {
    task: "Held task became active.",
    autoRun: false,
  }, env);
  await updateThread(taskAgent.id, {
    agentTaskStatus: "held",
    runtime: {
      ...(taskAgent.runtime || {}),
      runtimeKind: "codex-app-server",
      state: "working",
      activeTurnId: "active-concurrency-turn",
      codexStatus: { type: "active", activeFlags: ["running"] },
    },
  }, env);

  await assert.rejects(
    () => createTaskAgent(parent.id, { task: "Second task should wait." }, env),
    /task_agent_concurrency_limit/,
  );
  const current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "working");
});

test("held task agents stay out of delivery and cancellation remains terminal", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "held-parent", name: "Held Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent, message } = await createTaskAgent(parent.id, {
    task: "Do not execute this task.",
    autoRun: false,
  }, env);

  assert.equal(taskAgent.agentTaskStatus, "held");
  assert.equal(taskAgent.agentTaskAutoRun, false);
  assert.equal(message.state, "held");
  assert.equal(message.deliveryState, "held");

  await cancelTaskAgent(taskAgent.id, env);
  const cancelledMessage = (await listThreadMessages(taskAgent.id, env))[0];
  assert.equal(cancelledMessage.state, "cancelled");
  assert.equal(cancelledMessage.deliveryState, "cancelled");

  const lateResult = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "This late result must not be delivered.",
    state: "completed",
  }, env);
  await Promise.all([
    completeTaskAgentFromMessage(taskAgent, lateResult, env, { deliver: false }),
    finishTaskAgentTurn(taskAgent, { status: "completed" }, env, { deliver: false }),
  ]);

  const current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "cancelled");
  assert.equal((await listThreadMessages(parent.id, env)).length, 0);
});

test("task cancellation and result delivery cannot overwrite each other", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "cancel-race-parent", name: "Cancel Race Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Race cancellation with completion." }, env);
  const result = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "Late completion.",
    state: "completed",
  }, env);

  await Promise.all([
    cancelTaskAgent(taskAgent.id, env),
    completeTaskAgentFromMessage(taskAgent, result, env, { deliver: false }),
  ]);

  const current = await getThread(taskAgent.id, env);
  const parentResults = (await listThreadMessages(parent.id, env))
    .filter((message) => message.source === "orkestr_task_agent_result");
  assert.ok(["cancelled", "completed"].includes(current.agentTaskStatus));
  assert.ok(parentResults.length <= 1);
  assert.equal(parentResults.length === 1, current.agentTaskStatus === "completed");
});

test("public task agent profiles do not expose developer instructions", () => {
  const profiles = listTaskAgentProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "sre_engineer");
  assert.equal(Object.hasOwn(profiles[0], "developerInstructions"), false);
});

test("task agent terminal turns surface a missing result to the parent", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "missing-result-parent", name: "Missing Result Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Inspect the runtime." }, env);
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  await finishTaskAgentTurn(taskAgent, { id: "missing-result-turn", status: "completed" }, env, {
    deliver: false,
    nowMs: now,
    resultGraceMs: 100,
  });

  let current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "awaiting_result");
  assert.equal((await listThreadMessages(parent.id, env)).length, 0);

  await reconcileTaskAgentStatus(taskAgent.id, env, {
    deliver: false,
    nowMs: now + 101,
  });
  current = await getThread(taskAgent.id, env);
  assert.equal(current.agentTaskStatus, "failed");
  assert.equal(current.agentTaskFailureKind, "missing_result");
  assert.equal(current.agentTaskFailureProvisional, true);
  const parentMessages = await listThreadMessages(parent.id, env);
  assert.equal(parentMessages.length, 1);
  assert.match(parentMessages[0].text, /completed without returning a final result/i);
});

test("late task agent final answer corrects provisional missing-result failure", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "late-result-parent", name: "Late Result Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Inspect late projection." }, env);

  await finishTaskAgentTurn(taskAgent, { id: "late-result-turn", status: "completed" }, env, {
    deliver: false,
    resultGraceMs: 0,
  });
  const failed = await getThread(taskAgent.id, env);
  const failedParentMessages = await listThreadMessages(parent.id, env);
  assert.equal(failed.agentTaskStatus, "failed");
  assert.equal(failedParentMessages.length, 1);
  const parentMessageId = failedParentMessages[0].id;

  const lateResult = await appendThreadMessage(taskAgent.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "Late but valid evidence.",
    state: "completed",
    codexTurnId: "late-result-turn",
  }, env);
  await completeTaskAgentFromMessage(taskAgent, lateResult, env, { deliver: false });

  const current = await getThread(taskAgent.id, env);
  const parentMessages = (await listThreadMessages(parent.id, env))
    .filter((message) => message.source === "orkestr_task_agent_result");
  assert.equal(current.agentTaskStatus, "completed");
  assert.equal(current.agentTaskFailureKind, null);
  assert.equal(parentMessages.length, 1);
  assert.equal(parentMessages[0].id, parentMessageId);
  assert.match(parentMessages[0].text, /Late but valid evidence/);
  assert.doesNotMatch(parentMessages[0].text, /completed without returning a final result/i);
});

test("deleting a parent cascades hidden task agents without worker confirmation", async () => {
  const env = await testEnv();
  const parent = await createThread({ id: "delete-task-parent", name: "Delete Task Parent", cwd: path.dirname(env.ORKESTR_HOME) }, env);
  const { taskAgent } = await createTaskAgent(parent.id, { task: "Inspect before deletion." }, env);

  const deleted = await deleteThread(parent.id, {}, env);

  assert.deepEqual(new Set(deleted.deletedThreads), new Set([parent.id, taskAgent.id]));
  assert.equal(await getThread(parent.id, env), null);
  assert.equal(await getThread(taskAgent.id, env), null);
});

test("task agent API creates hidden child tasks and exposes their status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-task-agent-api-"));
  const previousHome = process.env.ORKESTR_HOME;
  const previousAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const previousUnsafeAuth = process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  await createThread({ id: "api-parent", name: "API Parent", cwd: home });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${baseUrl}/api/threads/api-parent/task-agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "sre_engineer", task: "Check service readiness.", autoRun: false }),
    });
    const payload = await created.json();
    assert.equal(created.status, 201, JSON.stringify(payload));
    const listed = await fetch(`${baseUrl}/api/threads/api-parent/task-agents`).then((response) => response.json());
    const status = await fetch(`${baseUrl}/api/task-agents/${encodeURIComponent(payload.taskAgent.threadId)}`).then((response) => response.json());
    const threadList = await fetch(`${baseUrl}/api/threads/summary`).then((response) => response.json());

    assert.equal(payload.taskAgent.profileId, "sre_engineer");
    assert.equal(payload.taskAgent.status, "held");
    assert.equal(listed.taskAgents.length, 1);
    assert.equal(status.taskAgent.id, payload.taskAgent.id);
    assert.deepEqual(threadList.threads.map((thread) => thread.id), ["api-parent"]);

    const cancelledResponse = await fetch(`${baseUrl}/api/task-agents/${encodeURIComponent(payload.taskAgent.threadId)}/cancel`, {
      method: "POST",
    });
    const cancelled = await cancelledResponse.json();
    assert.equal(cancelledResponse.status, 200, JSON.stringify(cancelled));
    assert.equal(cancelled.taskAgent.id, payload.taskAgent.id);
    assert.equal(cancelled.taskAgent.status, "cancelled");
    const childMessages = await listThreadMessages(payload.taskAgent.threadId);
    assert.equal(childMessages[0].state, "cancelled");
    assert.equal(childMessages[0].deliveryState, "cancelled");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = previousHome;
    if (previousAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = previousAuth;
    if (previousUnsafeAuth === undefined) delete process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED;
    else process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = previousUnsafeAuth;
  }
});
