import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { clean } from "./task-agent-state.js";

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function taskAgentParentMismatchError() {
  return httpError("task_agent_parent_mismatch", 409);
}

function sameThreadId(left, right) {
  return Boolean(clean(left) && clean(right) && clean(left) === clean(right));
}

function taskAgentOriginRootId(originThread, fallback = "") {
  return clean(originThread?.rootThreadId || originThread?.parentThreadId || originThread?.id || fallback);
}

async function appendParentMismatchEvent(parent, input = {}, details = {}, env = process.env) {
  await appendEvent({
    type: "task_agent_parent_mismatch",
    threadId: parent?.id || clean(input.requestedParentThreadId || input.parentThreadId) || null,
    requestedParentThreadId: clean(input.requestedParentThreadId || input.parentThreadId) || null,
    originThreadId: clean(input.originThreadId) || null,
    originRootThreadId: clean(input.originRootThreadId) || null,
    reason: details.reason || "parent_mismatch",
    expectedParentThreadIds: details.expectedParentThreadIds || [],
  }, env).catch(() => {});
}

export function taskAgentOriginPromptLines(origin = {}) {
  return [
    clean(origin.requestedParentThreadId) && clean(origin.requestedParentThreadId) !== clean(origin.parentThreadId)
      ? `Requested parent thread: ${origin.requestedParentThreadId}`
      : "",
    clean(origin.originThreadId) ? `Origin Orkestr thread: ${origin.originThreadId}` : "",
    clean(origin.originRootThreadId) ? `Origin root thread: ${origin.originRootThreadId}` : "",
  ].filter(Boolean);
}

export async function validateTaskAgentParentBinding(parent, input = {}, env = process.env) {
  const requestedParentThreadId = clean(input.requestedParentThreadId || input.parentThreadId);
  if (requestedParentThreadId && requestedParentThreadId !== parent.id) {
    await appendParentMismatchEvent(parent, input, { reason: "requested_parent_mismatch" }, env);
    throw taskAgentParentMismatchError();
  }

  const originThreadId = clean(input.originThreadId || input.origin_thread_id);
  const explicitOriginRootThreadId = clean(input.originRootThreadId || input.origin_root_thread_id);
  if (!originThreadId && !explicitOriginRootThreadId) {
    return {
      requestedParentThreadId: requestedParentThreadId || parent.id,
      originThreadId: "",
      originRootThreadId: "",
    };
  }

  const originThread = originThreadId ? await getThread(originThreadId, env) : null;
  if (originThreadId && !originThread) {
    await appendParentMismatchEvent(parent, input, { reason: "origin_thread_not_found" }, env);
    throw taskAgentParentMismatchError();
  }

  const originRootThreadId = taskAgentOriginRootId(originThread, explicitOriginRootThreadId);
  if (explicitOriginRootThreadId && originRootThreadId && explicitOriginRootThreadId !== originRootThreadId) {
    await appendParentMismatchEvent(parent, input, {
      reason: "origin_root_mismatch",
      expectedParentThreadIds: [originRootThreadId],
    }, env);
    throw taskAgentParentMismatchError();
  }

  const expectedParentIds = [
    clean(originThread?.id),
    clean(originThread?.parentThreadId),
    clean(originThread?.rootThreadId),
    explicitOriginRootThreadId,
  ].filter(Boolean);
  if (!expectedParentIds.some((id) => sameThreadId(id, parent.id))) {
    await appendParentMismatchEvent(parent, input, {
      reason: "origin_parent_mismatch",
      expectedParentThreadIds: [...new Set(expectedParentIds)],
    }, env);
    throw taskAgentParentMismatchError();
  }

  return {
    requestedParentThreadId: requestedParentThreadId || parent.id,
    originThreadId,
    originRootThreadId: originRootThreadId || explicitOriginRootThreadId,
  };
}

export function expectedTaskAgentParentThreadId(thread = {}) {
  return clean(thread.agentParentThreadId || thread.agentRequestedParentThreadId);
}

export async function rejectTaskAgentResultParentDrift(current, sourceMessage = {}, env = process.env) {
  const expectedParentThreadId = expectedTaskAgentParentThreadId(current);
  const completedAt = new Date().toISOString();
  await updateThread(current.id, {
    state: "failed",
    agentTaskStatus: "failed",
    agentTaskCompletedAt: completedAt,
    lastError: "task_agent_parent_mismatch",
    agentTaskFailureKind: "parent_mismatch",
    agentTaskFailureProvisional: false,
  }, env);
  await appendEvent({
    type: "task_agent_result_parent_rejected",
    threadId: expectedParentThreadId,
    observedParentThreadId: clean(current.parentThreadId) || null,
    expectedParentThreadId,
    taskAgentThreadId: current.id,
    taskId: current.agentTaskId,
    profileId: current.agentProfileId,
    sourceMessageId: clean(sourceMessage?.id) || null,
  }, env).catch(() => {});
}
