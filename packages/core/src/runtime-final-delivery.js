import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { completeRuntimeLiveness, recordRuntimeLiveness } from "./runtime-liveness.js";
import { currentCodexGenerationMatches } from "./codex-generation.js";
import { injectRuntimeFault, runtimeNowIso } from "./runtime-fault-injection.js";
import { recordRuntimeControlMetric } from "./observability.js";

function clean(value) {
  return String(value || "").trim();
}

function generation(thread = {}, input = {}) {
  return clean(input.runtimeGeneration || thread?.executor?.codexThreadId || thread?.codexThreadId || thread?.runtime?.runtimeGeneration);
}

function matchesPendingDelivery(delivery = null, input = {}) {
  if (!delivery) return false;
  const messageId = clean(input.messageId);
  if (messageId && clean(delivery.messageId) !== messageId) return false;
  const turnId = clean(input.turnId);
  if (turnId && clean(delivery.turnId) && clean(delivery.turnId) !== turnId) return false;
  return true;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = clean(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function sameKnownDeliveryField(delivery = {}, input = {}, field = "") {
  const left = clean(delivery?.[field]);
  const right = clean(input?.[field]);
  return !left || !right || left === right;
}

function deliverySupersedesMessage(delivery = {}, messageId = "") {
  const id = clean(messageId);
  if (!id) return false;
  return (Array.isArray(delivery?.supersededMessageIds) ? delivery.supersededMessageIds : [])
    .some((value) => clean(value) === id);
}

function deliveredDuplicateMatches(delivery = null, input = {}) {
  const messageId = clean(input.messageId);
  if (!delivery || clean(delivery.status) !== "delivered" || !messageId) return false;
  if (clean(delivery.messageId) === messageId || deliverySupersedesMessage(delivery, messageId)) return true;
  for (const field of ["runtimeGeneration", "connector", "chatId", "accountId"]) {
    if (!sameKnownDeliveryField(delivery, input, field)) return false;
  }
  const deliveryTurnId = clean(delivery.turnId);
  const inputTurnId = clean(input.turnId);
  const deliveryParentMessageId = clean(delivery.parentMessageId);
  const inputParentMessageId = clean(input.parentMessageId);
  return Boolean(
    (deliveryTurnId && inputTurnId && deliveryTurnId === inputTurnId) ||
    (deliveryParentMessageId && inputParentMessageId && deliveryParentMessageId === inputParentMessageId)
  );
}

async function coalesceDeliveredDuplicate(thread, runtime, current, input = {}, env = process.env) {
  const messageId = clean(input.messageId);
  if (!deliveredDuplicateMatches(current, input) || clean(current?.messageId) === messageId) return null;
  const at = runtimeNowIso(env);
  const finalDelivery = {
    ...current,
    supersededMessageIds: uniqueStrings([...(current.supersededMessageIds || []), messageId]),
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, { runtime: { ...runtime, finalDelivery } }, env);
  await appendEvent({
    type: "runtime_final_delivery_duplicate_coalesced",
    threadId: thread.id,
    messageId,
    canonicalMessageId: current.messageId,
    turnId: current.turnId || clean(input.turnId) || null,
    runtimeGeneration: current.runtimeGeneration || clean(input.runtimeGeneration) || null,
  }, env).catch(() => {});
  return {
    ok: true,
    pending: false,
    acknowledged: true,
    recorded: false,
    duplicate: true,
    superseded: true,
    reason: "final_delivery_already_delivered",
    finalDelivery: updated.runtime?.finalDelivery || finalDelivery,
    thread: updated,
  };
}

export function runtimeFinalDeliveryPending(thread = {}, turnId = "") {
  const delivery = thread?.runtime?.finalDelivery || null;
  if (!delivery || clean(delivery.status) !== "pending") return false;
  const expectedTurnId = clean(turnId);
  return !expectedTurnId || !clean(delivery.turnId) || clean(delivery.turnId) === expectedTurnId;
}

export async function markRuntimeFinalDeliveryPending(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, pending: false, reason: "thread_not_found" };
  const observedGeneration = clean(input.runtimeGeneration || input.codexThreadId);
  if (observedGeneration) {
    const match = currentCodexGenerationMatches(thread, observedGeneration);
    // A connector-only thread may not yet have a Codex generation. It cannot
    // be a superseded Codex execution, so retain the normal final-delivery
    // contract for that legacy/general path. Once a generation is known,
    // every mutation must match it.
    if (!match.ok && (match.resolution?.id || match.resolution?.ambiguous)) {
      await appendEvent({
        type: "runtime_final_delivery_generation_rejected",
        threadId: thread.id,
        observedGeneration,
        expectedGeneration: match.resolution?.id || null,
        reason: match.reason,
        operation: "pending",
      }, env).catch(() => {});
      return { ok: false, pending: false, reason: match.reason };
    }
  }
  const messageId = clean(input.messageId);
  if (!messageId) return { ok: false, pending: false, reason: "message_id_required" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.finalDelivery && typeof runtime.finalDelivery === "object" ? runtime.finalDelivery : null;
  if (clean(current?.messageId) === messageId && clean(current?.status) === "delivered") {
    return { ok: true, pending: false, duplicate: true, finalDelivery: current, thread };
  }
  const coalesced = await coalesceDeliveredDuplicate(thread, runtime, current, input, env);
  if (coalesced) return coalesced;
  const at = runtimeNowIso(env);
  const finalDelivery = {
    messageId,
    parentMessageId: clean(input.parentMessageId) || null,
    turnId: clean(input.turnId) || null,
    runtimeGeneration: generation(thread, input) || null,
    connector: clean(input.connector || "whatsapp"),
    chatId: clean(input.chatId) || null,
    accountId: clean(input.accountId) || null,
    projectionSource: clean(input.projectionSource) || clean(current?.projectionSource) || null,
    status: "pending",
    completionStatus: clean(input.completionStatus || "completed"),
    pendingAt: clean(current?.messageId) === messageId ? current.pendingAt || at : at,
    lastAttemptAt: null,
    deliveredAt: null,
    error: null,
    updatedAt: at,
  };
  await injectRuntimeFault("final_persistence", {
    threadId: thread.id,
    messageId,
    runtimeGeneration: finalDelivery.runtimeGeneration,
    turnId: finalDelivery.turnId,
  }, env);
  const updated = await updateThread(thread.id, {
    runtime: { ...runtime, finalDelivery },
  }, env);
  recordRuntimeControlMetric({ signal: "pending_final_delivery", outcome: "pending" });
  await recordRuntimeLiveness(thread.id, {
    runtimeGeneration: finalDelivery.runtimeGeneration,
    turnId: finalDelivery.turnId,
    evidenceType: "mcp_progress",
    phase: "awaiting_delivery",
    summary: `Awaiting ${finalDelivery.connector} final delivery acknowledgement`,
  }, env).catch(() => {});
  await appendEvent({
    type: "runtime_final_delivery_pending",
    threadId: thread.id,
    messageId,
    turnId: finalDelivery.turnId,
    connector: finalDelivery.connector,
  }, env).catch(() => {});
  return { ok: true, pending: true, finalDelivery: updated.runtime?.finalDelivery || finalDelivery, thread: updated };
}

export async function acknowledgeRuntimeFinalDelivery(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, acknowledged: false, reason: "thread_not_found" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.finalDelivery && typeof runtime.finalDelivery === "object" ? runtime.finalDelivery : null;
  const deliveryGeneration = clean(current?.runtimeGeneration);
  if (deliveryGeneration) {
    const match = currentCodexGenerationMatches(thread, deliveryGeneration);
    if (!match.ok && (match.resolution?.id || match.resolution?.ambiguous)) {
      await appendEvent({
        type: "runtime_final_delivery_generation_rejected",
        threadId: thread.id,
        observedGeneration: deliveryGeneration,
        expectedGeneration: match.resolution?.id || null,
        reason: match.reason,
        operation: "acknowledge",
      }, env).catch(() => {});
      return { ok: false, acknowledged: false, reason: match.reason };
    }
  }
  if (!matchesPendingDelivery(current, input)) {
    if (deliveredDuplicateMatches(current, input)) {
      return { ok: true, acknowledged: true, duplicate: true, superseded: true, finalDelivery: current, thread };
    }
    return { ok: false, acknowledged: false, reason: "final_delivery_not_found" };
  }
  if (clean(current.status) === "delivered") return { ok: true, acknowledged: true, duplicate: true, finalDelivery: current, thread };
  const at = clean(input.deliveredAt) || runtimeNowIso(env);
  const finalDelivery = {
    ...current,
    status: "delivered",
    outboxJobId: clean(input.outboxJobId) || current.outboxJobId || null,
    connectorMessageId: clean(input.connectorMessageId) || current.connectorMessageId || null,
    deliveredAt: at,
    lastAttemptAt: at,
    error: null,
    updatedAt: at,
  };
  await injectRuntimeFault("delivery_acknowledgement", {
    threadId: thread.id,
    messageId: current.messageId,
    runtimeGeneration: current.runtimeGeneration,
    turnId: current.turnId,
  }, env);
  const updated = await updateThread(thread.id, { runtime: { ...runtime, finalDelivery } }, env);
  recordRuntimeControlMetric({ signal: "delivery_acknowledgement", outcome: "delivered" });
  const supersededExecution = Boolean(
    clean(runtime.liveness?.turnId) &&
    clean(finalDelivery.turnId) &&
    clean(runtime.liveness.turnId) !== clean(finalDelivery.turnId)
  );
  if (!supersededExecution) {
    await completeRuntimeLiveness(thread.id, {
      runtimeGeneration: finalDelivery.runtimeGeneration,
      turnId: finalDelivery.turnId,
      status: clean(finalDelivery.completionStatus) || "completed",
      phase: clean(finalDelivery.completionStatus) === "failed" ? "failed" : clean(finalDelivery.completionStatus) === "cancelled" ? "cancelled" : "complete",
      summary: `${clean(finalDelivery.connector || "connector")} final delivery acknowledged`,
    }, env).catch(() => {});
  }
  await appendEvent({
    type: "runtime_final_delivery_acknowledged",
    threadId: thread.id,
    messageId: current.messageId,
    turnId: current.turnId,
    outboxJobId: finalDelivery.outboxJobId,
    supersededExecution,
  }, env).catch(() => {});
  return { ok: true, acknowledged: true, finalDelivery: updated.runtime?.finalDelivery || finalDelivery, thread: updated };
}

export async function recordRuntimeFinalDeliveryFailure(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, recorded: false, reason: "thread_not_found" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.finalDelivery && typeof runtime.finalDelivery === "object" ? runtime.finalDelivery : null;
  const deliveryGeneration = clean(current?.runtimeGeneration);
  if (deliveryGeneration) {
    const match = currentCodexGenerationMatches(thread, deliveryGeneration);
    if (!match.ok && (match.resolution?.id || match.resolution?.ambiguous)) {
      await appendEvent({
        type: "runtime_final_delivery_generation_rejected",
        threadId: thread.id,
        observedGeneration: deliveryGeneration,
        expectedGeneration: match.resolution?.id || null,
        reason: match.reason,
        operation: "failure",
      }, env).catch(() => {});
      return { ok: false, recorded: false, reason: match.reason };
    }
  }
  if (!matchesPendingDelivery(current, input)) {
    if (deliveredDuplicateMatches(current, input)) {
      await appendEvent({
        type: "runtime_final_delivery_duplicate_failure_suppressed",
        threadId: thread.id,
        messageId: clean(input.messageId) || null,
        canonicalMessageId: current?.messageId || null,
        turnId: current?.turnId || clean(input.turnId) || null,
      }, env).catch(() => {});
      return { ok: true, recorded: false, duplicate: true, superseded: true, reason: "final_delivery_already_delivered", finalDelivery: current, thread };
    }
    return { ok: false, recorded: false, reason: "final_delivery_not_found" };
  }
  const at = runtimeNowIso(env);
  const status = clean(input.status || "failed_retryable");
  const finalDelivery = {
    ...current,
    status,
    outboxJobId: clean(input.outboxJobId) || current.outboxJobId || null,
    lastAttemptAt: at,
    error: clean(input.error).slice(0, 1000) || null,
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, { runtime: { ...runtime, finalDelivery } }, env);
  const supersededExecution = Boolean(
    clean(runtime.liveness?.turnId) &&
    clean(finalDelivery.turnId) &&
    clean(runtime.liveness.turnId) !== clean(finalDelivery.turnId)
  );
  if (!supersededExecution) {
    await recordRuntimeLiveness(thread.id, {
      runtimeGeneration: finalDelivery.runtimeGeneration,
      turnId: finalDelivery.turnId,
      evidenceType: "mcp_progress",
      phase: status === "failed_retryable" ? "awaiting_delivery_retry" : "delivery_unconfirmed",
      summary: finalDelivery.error || `Final delivery is ${status}`,
    }, env).catch(() => {});
  }
  await appendEvent({
    type: "runtime_final_delivery_failed",
    threadId: thread.id,
    messageId: current.messageId,
    turnId: current.turnId,
    status,
    error: finalDelivery.error,
    supersededExecution,
  }, env).catch(() => {});
  return { ok: true, recorded: true, finalDelivery: updated.runtime?.finalDelivery || finalDelivery, thread: updated };
}
