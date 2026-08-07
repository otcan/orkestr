import { deliverPendingThreadInputs, wakeThread } from "./runtime-leases.js";
import { listRouterTraces, recordRouterTraceEvent } from "./router-traces.js";
import { backfillRouterTracePhases } from "./router-trace-backfill.js";
import { inferredRuntimeBackfillPhases, phaseTime, traceHasRuntimeReplyEvidence, traceShortCircuitedBeforeRuntime } from "./router-doctor-trace-rules.js";
import { repairRuntimeDeliveryMissingAssistant } from "./router-doctor-message-recovery.js";
import { repairOrphanedWhatsAppFinalAnswer } from "./router-doctor-whatsapp-final-mirror.js";
import { updateThreadMessage } from "./threads.js";
import { abortable, throwIfAborted } from "./router-doctor-abort.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function dateMs(value = "") {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

function inferredMessageRuntimeBackfillPhases(trace = {}, message = {}, missingPhases = []) {
  const missing = new Set((Array.isArray(missingPhases) ? missingPhases : []).map(lower));
  const additions = [];
  const queuedMs = phaseTime(trace, "queued") || phaseTime(trace, "routed") || phaseTime(trace, "received") || dateMs(trace.createdAt);
  const deliveredMs = dateMs(message.deliveredAt || message.deliveryLastAttemptAt || message.updatedAt) || dateMs(trace.updatedAt) || Date.now();
  const startMs = queuedMs && queuedMs < deliveredMs ? Math.max(queuedMs + 1, deliveredMs - 2) : Math.max(1, deliveredMs - 2);
  const reason = `router_doctor_inferred_from_${lower(message.observedVia) || "message_delivery"}`.slice(0, 200);
  if (missing.has("delivery_started")) additions.push({ phase: "delivery_started", ts: new Date(startMs).toISOString(), reason });
  if (missing.has("delivered_to_runtime")) additions.push({ phase: "delivered_to_runtime", ts: new Date(Math.max(startMs + 1, deliveredMs)).toISOString(), reason });
  return additions;
}

export async function repairIssue(item = {}, context = {}) {
  const { env, thread, repairSafe, releaseConnectorOutboxClaimFn, ensureConnectorOutboxJobFn, signal } = context;
  throwIfAborted(signal);
  if (item.code === "sleeping_thread_has_queued_whatsapp_input") {
    const result = await abortable(wakeThread(thread.id, { reason: "router_doctor_whatsapp_repair" }, env), signal);
    return { code: "wake_thread", ok: true, threadId: thread.id, messageId: item.messageId, status: result.status || null };
  }
  if (item.code === "stale_queued_whatsapp_input_ready_runtime") {
    let requeued = false;
    if (lower(item.messageState) !== "awaiting_ack") {
      throwIfAborted(signal);
      await abortable(updateThreadMessage(thread.id, item.messageId, {
        state: "queued",
        deliveryState: "retrying_delivery",
        error: null,
        deliveryNextAttemptAt: null,
      }, env), signal);
      requeued = true;
    }
    throwIfAborted(signal);
    const delivered = await abortable(deliverPendingThreadInputs(thread.id, env, { processApiAgent: true }), signal);
    return { code: "retry_runtime_delivery", ok: true, threadId: thread.id, messageId: item.messageId, requeued, delivered };
  }
  if (item.code === "stale_outbox_claim") {
    const released = typeof releaseConnectorOutboxClaimFn === "function"
      ? await abortable(releaseConnectorOutboxClaimFn(item.outboxJobId, { reason: "router_doctor_stale_claim" }, env), signal)
      : null;
    return { code: "release_stale_outbox_claim", ok: Boolean(released), outboxJobId: item.outboxJobId, state: released?.state || "" };
  }
  if (item.code === "orphaned_whatsapp_final_answer" && repairSafe !== false) {
    return repairOrphanedWhatsAppFinalAnswer(item, { ...context, ensureConnectorOutboxJobFn });
  }
  if (item.code === "queued_whatsapp_input_marked_terminal_without_runtime_delivery" && repairSafe !== false) {
    const updated = await abortable(updateThreadMessage(thread.id, item.messageId, {
      state: "queued",
      deliveryState: "retrying_delivery",
      error: "router_doctor_requeued_missing_runtime_delivery",
    }, env), signal);
    await abortable(recordRouterTraceEvent({
      routerTraceId: item.routerTraceId,
      connector: "whatsapp",
      threadId: thread.id,
      messageId: item.messageId,
      phase: "queued",
      reason: "router_doctor_requeued_missing_runtime_delivery",
      terminal: false,
    }, env).catch(() => null), signal);
    return { code: "requeue_swallowed_input", ok: true, threadId: thread.id, messageId: item.messageId, state: updated?.state || "" };
  }
  if (item.code === "runtime_delivery_completed_without_assistant" && repairSafe !== false) {
    return repairRuntimeDeliveryMissingAssistant(item, { env, thread, signal });
  }
  if (item.code === "missing_router_trace_phase" && repairSafe !== false) {
    const routerTraceId = clean(item.routerTraceId);
    if (!routerTraceId) return null;
    const trace = (await abortable(listRouterTraces({ routerTraceId, connector: "whatsapp" }, env), signal))[0] || null;
    if (!trace || traceShortCircuitedBeforeRuntime(trace)) return null;
    const message = (Array.isArray(context.messages) ? context.messages : []).find((entry) => clean(entry.id) === clean(item.messageId || trace.messageId)) || {};
    const additions = traceHasRuntimeReplyEvidence(trace)
      ? inferredRuntimeBackfillPhases(trace, item.missingPhases)
      : inferredMessageRuntimeBackfillPhases(trace, message, item.missingPhases);
    if (!additions.length) return null;
    throwIfAborted(signal);
    const result = await abortable(backfillRouterTracePhases({
      routerTraceId,
      phases: additions,
      reason: "router_doctor_backfill_missing_runtime_delivery",
    }, env), signal);
    const added = Array.isArray(result?.addedPhases) ? result.addedPhases.map((phase) => phase.phase) : [];
    if (!added.length) return null;
    return {
      code: "backfill_router_trace_phases",
      ok: true,
      threadId: thread.id,
      messageId: item.messageId || trace.messageId || "",
      routerTraceId,
      phases: added,
      currentPhase: result?.trace?.currentPhase || trace.currentPhase || "",
    };
  }
  return null;
}
