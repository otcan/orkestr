import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { completeRuntimeLiveness, recordRuntimeLiveness } from "./runtime-liveness.js";

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
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

export function runtimeFinalDeliveryPending(thread = {}, turnId = "") {
  const delivery = thread?.runtime?.finalDelivery || null;
  if (!delivery || clean(delivery.status) !== "pending") return false;
  const expectedTurnId = clean(turnId);
  return !expectedTurnId || !clean(delivery.turnId) || clean(delivery.turnId) === expectedTurnId;
}

export async function markRuntimeFinalDeliveryPending(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, pending: false, reason: "thread_not_found" };
  const messageId = clean(input.messageId);
  if (!messageId) return { ok: false, pending: false, reason: "message_id_required" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.finalDelivery && typeof runtime.finalDelivery === "object" ? runtime.finalDelivery : null;
  if (clean(current?.messageId) === messageId && clean(current?.status) === "delivered") {
    return { ok: true, pending: false, duplicate: true, finalDelivery: current, thread };
  }
  const at = nowIso();
  const finalDelivery = {
    messageId,
    parentMessageId: clean(input.parentMessageId) || null,
    turnId: clean(input.turnId) || null,
    runtimeGeneration: generation(thread, input) || null,
    connector: clean(input.connector || "whatsapp"),
    chatId: clean(input.chatId) || null,
    accountId: clean(input.accountId) || null,
    status: "pending",
    completionStatus: clean(input.completionStatus || "completed"),
    pendingAt: clean(current?.messageId) === messageId ? current.pendingAt || at : at,
    lastAttemptAt: null,
    deliveredAt: null,
    error: null,
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, {
    runtime: { ...runtime, finalDelivery },
  }, env);
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
  if (!matchesPendingDelivery(current, input)) return { ok: false, acknowledged: false, reason: "final_delivery_not_found" };
  if (clean(current.status) === "delivered") return { ok: true, acknowledged: true, duplicate: true, finalDelivery: current, thread };
  const at = clean(input.deliveredAt) || nowIso();
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
  const updated = await updateThread(thread.id, { runtime: { ...runtime, finalDelivery } }, env);
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
  if (!matchesPendingDelivery(current, input)) return { ok: false, recorded: false, reason: "final_delivery_not_found" };
  const at = nowIso();
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
