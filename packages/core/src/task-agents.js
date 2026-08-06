import { randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { recordTaskAgentLifecycleMetric } from "./observability.js";
import {
  appendThreadMessage,
  createThread,
  getThread,
  listThreadMessages,
  listThreads,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import { getTaskAgentProfile } from "./task-agent-profiles.js";

const activeTaskStates = new Set(["created", "queued", "starting", "working", "delivering_result"]);
const terminalTaskStates = new Set(["cancelled", "completed", "failed"]);
const taskResultLocks = new Map();

function clean(value) {
  return String(value || "").trim();
}

function safeSegment(value, fallback = "task") {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || fallback;
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeContextRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const refs = [];
  for (const item of value) {
    const ref = clean(item).slice(0, 1_000);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
    if (refs.length >= 20) break;
  }
  return refs;
}

function rootThreadId(parent) {
  return clean(parent.rootThreadId || parent.parentThreadId || parent.id);
}

function parentWorkspace(parent) {
  return clean(parent.cwd || parent.workspace || parent.repoPath || parent.worktreePath);
}

function taskPrompt(parent, profile, task, contextRefs) {
  return [
    `Specialist profile: ${profile.id}`,
    `Parent Orkestr thread: ${parent.id}`,
    parent.ownerUserId ? `Owner user: ${parent.ownerUserId}` : "",
    parentWorkspace(parent) ? `Scoped workspace: ${parentWorkspace(parent)}` : "",
    "",
    "Task:",
    task,
    ...(contextRefs.length ? ["", "Explicit context references:", ...contextRefs.map((ref) => `- ${ref}`)] : []),
    "",
    "Investigate independently within the supplied scope. Return one structured final answer to the parent agent.",
  ].filter(Boolean).join("\n");
}

export function isTaskAgentThread(thread = {}) {
  return clean(thread.threadKind) === "task-agent" && Boolean(clean(thread.agentTaskId));
}

export function isTerminalTaskAgentThread(thread = {}) {
  return isTaskAgentThread(thread) && terminalTaskStates.has(clean(thread.agentTaskStatus));
}

async function withTaskResultLock(threadId, operation) {
  const key = clean(threadId);
  const previous = taskResultLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  taskResultLocks.set(key, gate);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (taskResultLocks.get(key) === gate) taskResultLocks.delete(key);
  }
}

export async function listTaskAgents(parentThreadId, env = process.env) {
  const parent = await getThread(parentThreadId, env);
  if (!parent) throw httpError("thread_not_found", 404);
  return (await listThreads(env))
    .filter((thread) => isTaskAgentThread(thread) && thread.parentThreadId === parent.id)
    .sort((left, right) => clean(right.createdAt).localeCompare(clean(left.createdAt)));
}

export async function createTaskAgent(parentThreadId, input = {}, env = process.env) {
  const parent = await getThread(parentThreadId, env);
  if (!parent) throw httpError("thread_not_found", 404);
  if (isTaskAgentThread(parent)) throw httpError("task_agent_cannot_spawn_task_agent", 409);
  const profile = getTaskAgentProfile(input.profile || input.profileId || "sre_engineer");
  if (!profile) throw httpError("task_agent_profile_not_found", 404);
  const task = clean(input.task || input.prompt || input.message).slice(0, 100_000);
  if (!task) throw httpError("task_agent_task_required", 400);
  const existing = await listTaskAgents(parent.id, env);
  const active = existing.filter((thread) => activeTaskStates.has(clean(thread.agentTaskStatus)));
  const maxActive = Math.max(1, Number(env.ORKESTR_TASK_AGENT_MAX_ACTIVE_PER_THREAD || 8) || 8);
  if (active.length >= maxActive) throw httpError("task_agent_concurrency_limit", 409);

  const taskId = clean(input.id || input.taskId).slice(0, 240) || randomUUID();
  const childId = `task-${safeSegment(parent.id, "parent")}-${safeSegment(profile.id, "agent")}-${taskId.slice(0, 8)}`;
  const contextRefs = normalizeContextRefs(input.contextRefs || input.context_refs);
  const autoRun = input.autoRun !== false;
  const initialStatus = autoRun ? "queued" : "held";
  const prompt = taskPrompt(parent, profile, task, contextRefs);
  const workspace = parentWorkspace(parent);
  const child = await createThread({
    id: childId,
    ownerUserId: parent.ownerUserId || null,
    name: `${parent.name || parent.title || parent.id} / ${profile.name} ${taskId.slice(0, 8)}`,
    title: `${profile.name}: ${task.slice(0, 80)}`,
    bindingName: `${safeSegment(parent.bindingName || parent.name || parent.id, "thread")}-${safeSegment(profile.id, "agent")}-${taskId.slice(0, 8)}`,
    state: "sleeping",
    wakePolicy: "wake-on-message",
    cwd: workspace,
    workspace,
    runtimeKind: "codex-app-server",
    executorId: "codex",
    executor: {
      id: "codex",
      type: "codex",
      metadata: {
        runtimeKind: "codex-app-server",
        taskAgent: true,
        taskAgentProfileId: profile.id,
      },
    },
    securityProfile: parent.securityProfile || parent.executor?.metadata?.securityProfile || null,
    codexSandbox: profile.sandbox,
    codexApprovalPolicy: profile.approvalPolicy,
    codexModel: parent.codexModel || parent.executor?.metadata?.codexModel || null,
    codexModelProvider: parent.codexModelProvider || parent.executor?.metadata?.codexModelProvider || null,
    codexReasoningEffort: input.reasoningEffort || parent.codexReasoningEffort || parent.executor?.metadata?.codexReasoningEffort || null,
    codexServiceTier: parent.codexServiceTier || parent.executor?.metadata?.codexServiceTier || null,
    parentThreadId: parent.id,
    rootThreadId: rootThreadId(parent),
    threadKind: "task-agent",
    agentTaskId: taskId,
    agentProfileId: profile.id,
    agentTaskStatus: "created",
    agentTaskAutoRun: autoRun,
    agentTask: task,
    agentContextRefs: contextRefs,
    agentTaskPrompt: prompt,
  }, env);
  const message = await appendThreadMessage(child.id, {
    role: "user",
    source: "orkestr_task_agent_handoff",
    text: prompt,
    state: initialStatus,
    deliveryState: initialStatus,
    clientMessageId: `task-agent:${taskId}`,
  }, env);
  const updated = await updateThread(child.id, {
    agentTaskStatus: initialStatus,
    agentTaskMessageId: message.id,
  }, env);
  await appendEvent({
    type: "task_agent_created",
    threadId: parent.id,
    taskAgentThreadId: child.id,
    taskId,
    profileId: profile.id,
  }, env);
  recordTaskAgentLifecycleMetric("created", initialStatus);
  const { developerInstructions, ...publicProfile } = profile;
  return { parent, taskAgent: updated, message, profile: publicProfile };
}

export async function taskAgentSummary(threadOrId, env = process.env) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread || !isTaskAgentThread(thread)) throw httpError("task_agent_not_found", 404);
  const messages = await listThreadMessages(thread.id, env);
  const result = [...messages].reverse().find((message) =>
    clean(message.role) === "assistant" && clean(message.phase || "final_answer") === "final_answer" && clean(message.text)
  ) || null;
  return {
    id: thread.agentTaskId,
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    profileId: thread.agentProfileId,
    status: thread.agentTaskStatus || thread.state,
    task: thread.agentTask,
    contextRefs: thread.agentContextRefs || [],
    result: result ? { messageId: result.id, text: result.text, createdAt: result.createdAt } : null,
    parentResultMessageId: thread.agentParentResultMessageId || null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

async function enqueueParentResult(thread, sourceMessage, status, resultText, env, options = {}) {
  return withTaskResultLock(thread.id, async () => {
    const current = await getThread(thread.id, env);
    if (!current || !isTaskAgentThread(current)) return null;
    if (isTerminalTaskAgentThread(current)) return taskAgentSummary(current, env);
    if (clean(current.agentResultSourceMessageId) === clean(sourceMessage?.id)) return taskAgentSummary(current, env);
    const parent = await getThread(current.parentThreadId, env);
    if (!parent) {
      await updateThread(current.id, {
        agentTaskStatus: "failed",
        agentTaskCompletedAt: new Date().toISOString(),
        lastError: "task_agent_parent_not_found",
      }, env);
      return null;
    }
    await updateThread(current.id, {
      agentTaskStatus: "delivering_result",
      agentResultSourceMessageId: sourceMessage?.id || null,
    }, env);
    const text = [
      `[Specialist task ${status}]`,
      `Profile: ${current.agentProfileId}`,
      `Task ID: ${current.agentTaskId}`,
      `Task: ${current.agentTask}`,
      "",
      resultText,
      "",
      "Treat this as scoped specialist evidence. Evaluate it and answer the user in the parent conversation.",
    ].join("\n");
    const parentMessage = await appendThreadMessage(parent.id, {
      role: "user",
      source: "orkestr_task_agent_result",
      text,
      state: "queued",
      steerActiveTurn: true,
      codexDeliveryMode: "instant_steer",
      clientMessageId: `task-agent-result:${current.agentTaskId}:${sourceMessage?.id || status}`,
    }, env);
    const updated = await updateThread(current.id, {
      agentTaskStatus: status,
      agentParentResultMessageId: parentMessage.id,
      agentTaskCompletedAt: new Date().toISOString(),
      lastError: status === "failed" ? resultText : null,
    }, env);
    await appendEvent({
      type: `task_agent_${status}`,
      threadId: parent.id,
      taskAgentThreadId: current.id,
      taskId: current.agentTaskId,
      profileId: current.agentProfileId,
      parentMessageId: parentMessage.id,
    }, env);
    recordTaskAgentLifecycleMetric(`result_${status}`, status);
    if (options.deliver !== false) {
      const { requestThreadInputDelivery } = await import("./runtime-leases.js");
      requestThreadInputDelivery(parent.id, env);
    }
    return taskAgentSummary(updated, env);
  });
}

export async function completeTaskAgentFromMessage(thread, message, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread) || clean(message?.role) !== "assistant" || clean(message?.phase || "final_answer") !== "final_answer") return null;
  return enqueueParentResult(thread, message, "completed", clean(message.text), env, options);
}

export async function failTaskAgent(thread, error, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread)) return null;
  const message = { id: `failure-${clean(thread.runtime?.lastTurnId || Date.now())}` };
  return enqueueParentResult(thread, message, "failed", clean(error) || "The specialist task failed without a diagnostic result.", env, options);
}

export async function finishTaskAgentTurn(thread, turn = {}, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread)) return null;
  const current = await getThread(thread.id, env);
  if (!current || isTerminalTaskAgentThread(current)) return current ? taskAgentSummary(current, env) : null;
  const status = clean(turn.status || "completed").toLowerCase();
  if (turn.interrupted === true || ["interrupted", "aborted", "cancelled", "canceled"].includes(status)) {
    return failTaskAgent(current, clean(turn.error) || "The specialist task was interrupted before returning a result.", env, options);
  }
  if (status === "failed") {
    return failTaskAgent(current, clean(turn.error) || "The specialist task failed before returning a result.", env, options);
  }
  if (status === "completed") {
    return failTaskAgent(current, "The specialist task completed without returning a final result.", env, options);
  }
  return null;
}

export async function cancelTaskAgent(taskAgentId, env = process.env) {
  const thread = await getThread(taskAgentId, env);
  if (!thread || !isTaskAgentThread(thread)) throw httpError("task_agent_not_found", 404);
  return withTaskResultLock(thread.id, async () => {
    const current = await getThread(thread.id, env);
    if (!current || !isTaskAgentThread(current)) throw httpError("task_agent_not_found", 404);
    if (isTerminalTaskAgentThread(current)) return current;
    const cancelledAt = new Date().toISOString();
    const updated = await updateThread(current.id, {
      agentTaskStatus: "cancelled",
      agentTaskCompletedAt: cancelledAt,
    }, env);
    const messages = await listThreadMessages(current.id, env);
    for (const message of messages) {
      if (clean(message.role) !== "user" || !["held", "queued", "pending_delivery", "awaiting_ack"].includes(clean(message.state))) continue;
      await updateThreadMessage(current.id, message.id, {
        state: "cancelled",
        deliveryState: "cancelled",
        deliveryFailedAt: cancelledAt,
        deliveryClaimId: null,
        deliveryNextAttemptAt: null,
        observedVia: "task_agent_cancel",
        error: "Specialist task cancelled.",
      }, env);
    }
    await appendEvent({
      type: "task_agent_cancelled",
      threadId: current.parentThreadId,
      taskAgentThreadId: current.id,
      taskId: current.agentTaskId,
      profileId: current.agentProfileId,
    }, env);
    recordTaskAgentLifecycleMetric("cancelled", "cancelled");
    return updated;
  });
}
