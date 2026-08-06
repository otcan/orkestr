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
const activeTaskStates = new Set(["created", "queued", "starting", "working", "awaiting_result", "delivering_result"]);
const terminalTaskStates = new Set(["cancelled", "completed", "failed"]);
const taskResultLocks = new Map();
const defaultMissingResultGraceMs = 2_000;
const maxMissingResultGraceMs = 30_000;
function clean(value) { return String(value || "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }

function timestampMs(value = "") {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionNowMs(options = {}) {
  const parsed = Number(options.nowMs ?? options.now ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function missingResultGraceMs(env = process.env, options = {}) {
  const raw = options.resultGraceMs ?? env.ORKESTR_TASK_AGENT_RESULT_GRACE_MS ?? defaultMissingResultGraceMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultMissingResultGraceMs;
  return Math.max(0, Math.min(maxMissingResultGraceMs, Math.floor(parsed)));
}

function isoAt(ms) { return new Date(Math.max(0, Number(ms) || 0)).toISOString(); }

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

export function isTaskAgentThread(thread = {}) { return clean(thread.threadKind) === "task-agent" && Boolean(clean(thread.agentTaskId)); }
export function isTerminalTaskAgentThread(thread = {}) { return isTaskAgentThread(thread) && terminalTaskStates.has(clean(thread.agentTaskStatus)); }

function canCorrectMissingResultFailure(thread = {}) {
  return isTaskAgentThread(thread) && clean(thread.agentTaskStatus) === "failed" &&
    clean(thread.agentTaskFailureKind) === "missing_result" && thread.agentTaskFailureProvisional === true;
}

function taskAgentRuntimeActive(thread = {}) {
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const codexStatus = runtime.codexStatus && typeof runtime.codexStatus === "object" ? runtime.codexStatus : {};
  return Boolean(
    clean(runtime.activeTurnId) ||
    runtime.pendingRequest ||
    lower(codexStatus.type) === "active" ||
    ["working", "awaiting_approval"].includes(lower(runtime.state)),
  );
}

function taskAgentFinalAnswer(messages = [], turnId = "") {
  const finalAnswers = [...messages].reverse().filter((message) =>
    clean(message.role) === "assistant" && clean(message.phase || "final_answer") === "final_answer" && clean(message.text));
  const wantedTurn = clean(turnId);
  if (wantedTurn) {
    return finalAnswers.find((message) => clean(message.codexTurnId || message.turnId) === wantedTurn) || null;
  }
  return finalAnswers[0] || null;
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

export async function listTaskAgents(parentThreadId, env = process.env, options = {}) {
  const parent = await getThread(parentThreadId, env);
  if (!parent) throw httpError("thread_not_found", 404);
  const taskAgents = (await listThreads(env))
    .filter((thread) => isTaskAgentThread(thread) && thread.parentThreadId === parent.id)
    .sort((left, right) => clean(right.createdAt).localeCompare(clean(left.createdAt)));
  return Promise.all(taskAgents.map((thread) => reconcileTaskAgentStatus(thread, env, options)));
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

async function taskAgentSummaryFromThread(threadOrId, env = process.env) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread || !isTaskAgentThread(thread)) throw httpError("task_agent_not_found", 404);
  const messages = await listThreadMessages(thread.id, env);
  const status = thread.agentTaskStatus || thread.state;
  const result = clean(status) === "completed"
    ? messages.find((message) => clean(message.id) === clean(thread.agentResultSourceMessageId)) ||
      taskAgentFinalAnswer(messages, clean(thread.agentTaskResultTurnId || thread.runtime?.lastTurnId || thread.runtime?.activeTurnId))
    : null;
  return {
    id: thread.agentTaskId,
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    profileId: thread.agentProfileId,
    status,
    task: thread.agentTask,
    contextRefs: thread.agentContextRefs || [],
    result: result ? { messageId: result.id, text: result.text, createdAt: result.createdAt } : null,
    parentResultMessageId: thread.agentParentResultMessageId || null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export async function taskAgentSummary(threadOrId, env = process.env, options = {}) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread || !isTaskAgentThread(thread)) throw httpError("task_agent_not_found", 404);
  const reconciled = await reconcileTaskAgentStatus(thread, env, options);
  return taskAgentSummaryFromThread(reconciled, env);
}

async function enqueueParentResult(thread, sourceMessage, status, resultText, env, options = {}) {
  return withTaskResultLock(thread.id, async () => {
    const current = await getThread(thread.id, env);
    if (!current || !isTaskAgentThread(current)) return null;
    const sourceMessageId = clean(sourceMessage?.id);
    const resultTurnId = clean(options.turnId || sourceMessage?.codexTurnId || sourceMessage?.turnId || current.agentTaskResultTurnId || current.runtime?.lastTurnId || current.runtime?.activeTurnId);
    const correction = status === "completed" && canCorrectMissingResultFailure(current);
    if (isTerminalTaskAgentThread(current) && !correction) return taskAgentSummaryFromThread(current, env);
    if (sourceMessageId && clean(current.agentResultSourceMessageId) === sourceMessageId && !correction) {
      return taskAgentSummaryFromThread(current, env);
    }
    const parent = await getThread(current.parentThreadId, env);
    if (!parent) {
      await updateThread(current.id, {
        agentTaskStatus: "failed",
        agentTaskCompletedAt: new Date().toISOString(),
        lastError: "task_agent_parent_not_found",
      }, env);
      return null;
    }
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
    let parentMessage = null;
    if (correction && clean(current.agentParentResultMessageId)) {
      parentMessage = await updateThreadMessage(parent.id, current.agentParentResultMessageId, {
        text,
        state: "queued",
        deliveryState: "queued",
        deliveryClaimId: null,
        deliveryNextAttemptAt: null,
        error: null,
        steerActiveTurn: true,
        codexDeliveryMode: "instant_steer",
        clientMessageId: `task-agent-result:${current.agentTaskId}:${sourceMessageId || status}`,
      }, env).catch(() => null);
    }
    if (!parentMessage) {
      await updateThread(current.id, {
        agentTaskStatus: "delivering_result",
        agentResultSourceMessageId: sourceMessageId || null,
      }, env);
      parentMessage = await appendThreadMessage(parent.id, {
        role: "user",
        source: "orkestr_task_agent_result",
        text,
        state: "queued",
        steerActiveTurn: true,
        codexDeliveryMode: "instant_steer",
        clientMessageId: `task-agent-result:${current.agentTaskId}:${sourceMessageId || status}`,
      }, env);
    }
    const updated = await updateThread(current.id, {
      state: status === "failed" ? "failed" : "ready",
      agentTaskStatus: status,
      agentParentResultMessageId: parentMessage.id,
      agentTaskCompletedAt: new Date().toISOString(),
      lastError: status === "failed" ? resultText : null,
      agentResultSourceMessageId: sourceMessageId || clean(current.agentResultSourceMessageId) || null,
      agentTaskFailureKind: status === "failed" ? clean(options.failureKind) || null : null,
      agentTaskFailureProvisional: status === "failed" ? options.provisional === true : false,
      agentTaskResultDueAt: null,
      agentTaskResultGraceStartedAt: null,
      agentTaskResultTurnId: status === "failed" && options.provisional === true ? resultTurnId || null : null,
    }, env);
    await appendEvent({
      type: correction ? "task_agent_missing_result_corrected" : `task_agent_${status}`,
      threadId: parent.id,
      taskAgentThreadId: current.id,
      taskId: current.agentTaskId,
      profileId: current.agentProfileId,
      parentMessageId: parentMessage.id,
      sourceMessageId: sourceMessageId || null,
    }, env);
    recordTaskAgentLifecycleMetric(`result_${status}`, status);
    if (options.deliver !== false) {
      const { requestThreadInputDelivery } = await import("./runtime-leases.js");
      requestThreadInputDelivery(parent.id, env);
    }
    return taskAgentSummaryFromThread(updated, env);
  });
}

export async function completeTaskAgentFromMessage(thread, message, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread) || clean(message?.role) !== "assistant" || clean(message?.phase || "final_answer") !== "final_answer") return null;
  return enqueueParentResult(thread, message, "completed", clean(message.text), env, options);
}

export async function failTaskAgent(thread, error, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread)) return null;
  const turnId = clean(options.turnId || thread.agentTaskResultTurnId || thread.runtime?.lastTurnId || thread.runtime?.activeTurnId);
  const kind = clean(options.failureKind || "runtime");
  const message = { id: clean(options.sourceMessageId) || `failure-${kind}-${turnId || "unknown"}` };
  return enqueueParentResult(thread, message, "failed", clean(error) || "The specialist task failed without a diagnostic result.", env, options);
}

export async function finishTaskAgentTurn(thread, turn = {}, env = process.env, options = {}) {
  if (!isTaskAgentThread(thread)) return null;
  const current = await getThread(thread.id, env);
  if (!current) return null;
  if (clean(current.agentTaskStatus) === "cancelled") return taskAgentSummaryFromThread(current, env);
  const status = clean(turn.status || "completed").toLowerCase();
  const turnId = clean(turn.id || turn.turnId || current.runtime?.lastTurnId || current.runtime?.activeTurnId);
  const existingFinal = taskAgentFinalAnswer(await listThreadMessages(current.id, env), turnId);
  if (existingFinal) return completeTaskAgentFromMessage(current, existingFinal, env, options);
  if (isTerminalTaskAgentThread(current) && !canCorrectMissingResultFailure(current)) {
    return taskAgentSummaryFromThread(current, env);
  }
  if (turn.interrupted === true || ["interrupted", "aborted", "cancelled", "canceled"].includes(status)) {
    return failTaskAgent(current, clean(turn.error) || "The specialist task was interrupted before returning a result.", env, { ...options, turnId });
  }
  if (status === "failed") {
    return failTaskAgent(current, clean(turn.error) || "The specialist task failed before returning a result.", env, { ...options, turnId });
  }
  if (status === "completed") {
    return reconcileMissingResultAfterCompletedTurn(current, { ...turn, id: turnId }, env, options);
  }
  return null;
}

async function reconcileMissingResultAfterCompletedTurn(thread, turn = {}, env = process.env, options = {}) {
  const current = await getThread(thread.id, env);
  if (!current || !isTaskAgentThread(current)) return null;
  if (clean(current.agentTaskStatus) === "cancelled") return taskAgentSummaryFromThread(current, env);
  const turnId = clean(turn.id || turn.turnId || current.agentTaskResultTurnId || current.runtime?.lastTurnId);
  const now = optionNowMs(options);
  const existingDueAt = timestampMs(current.agentTaskResultDueAt);
  const graceMs = missingResultGraceMs(env, options);
  const dueAtMs = existingDueAt || (now + graceMs);
  if (graceMs <= 0 || dueAtMs <= now) {
    return failTaskAgent(
      current,
      "The specialist task completed without returning a final result.",
      env,
      {
        ...options,
        turnId,
        failureKind: "missing_result",
        provisional: true,
        sourceMessageId: `failure-missing_result-${turnId || clean(current.agentTaskId) || "unknown"}`,
      },
    );
  }
  const startedAt = clean(current.agentTaskResultGraceStartedAt) || isoAt(now);
  const updated = await updateThread(current.id, {
    agentTaskStatus: "awaiting_result",
    agentTaskResultDueAt: isoAt(dueAtMs),
    agentTaskResultGraceStartedAt: startedAt,
    agentTaskResultTurnId: turnId || null,
    agentTaskFailureKind: null,
    agentTaskFailureProvisional: false,
    lastError: null,
  }, env);
  if (!existingDueAt) {
    await appendEvent({
      type: "task_agent_result_grace_started",
      threadId: current.parentThreadId,
      taskAgentThreadId: current.id,
      taskId: current.agentTaskId,
      profileId: current.agentProfileId,
      turnId,
      dueAt: isoAt(dueAtMs),
    }, env).catch(() => {});
    recordTaskAgentLifecycleMetric("awaiting_result", "awaiting_result");
  }
  return taskAgentSummaryFromThread(updated, env);
}

export async function reconcileTaskAgentStatus(threadOrId, env = process.env, options = {}) {
  const current = typeof threadOrId === "string" ? await getThread(threadOrId, env) : await getThread(threadOrId?.id, env);
  if (!current || !isTaskAgentThread(current)) return current;
  if (clean(current.agentTaskStatus) === "cancelled") return current;
  const turnId = clean(current.agentTaskResultTurnId || current.runtime?.lastTurnId || current.runtime?.activeTurnId);
  const finalAnswer = taskAgentFinalAnswer(await listThreadMessages(current.id, env), turnId);
  if (finalAnswer && (!isTerminalTaskAgentThread(current) || canCorrectMissingResultFailure(current))) {
    await completeTaskAgentFromMessage(current, finalAnswer, env, options);
    return getThread(current.id, env);
  }
  if (isTerminalTaskAgentThread(current)) return current;
  if (taskAgentRuntimeActive(current) && clean(current.agentTaskStatus) !== "working") {
    const updated = await updateThread(current.id, {
      agentTaskStatus: "working",
      agentTaskResultDueAt: null,
      agentTaskResultGraceStartedAt: null,
      agentTaskResultTurnId: null,
      agentTaskFailureKind: null,
      agentTaskFailureProvisional: false,
      lastError: null,
    }, env);
    recordTaskAgentLifecycleMetric("reconciled_working", "working");
    return updated;
  }
  if (clean(current.agentTaskStatus) === "awaiting_result") {
    const dueAt = timestampMs(current.agentTaskResultDueAt);
    if (dueAt && dueAt <= optionNowMs(options)) {
      await reconcileMissingResultAfterCompletedTurn(current, { id: current.agentTaskResultTurnId || "" }, env, {
        ...options,
        resultGraceMs: 0,
      });
      return getThread(current.id, env);
    }
  }
  return current;
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
