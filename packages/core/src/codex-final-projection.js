import { appendEvent } from "../../storage/src/store.js";
import { ensureConnectorOutboxJobThroughAdapter } from "./connector-outbox-adapter.js";
import { resourceOwnerUserId } from "./policy.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { currentCodexGenerationMatches } from "./codex-generation.js";
import { markRuntimeFinalDeliveryPending } from "./runtime-final-delivery.js";
import { getThread, getThreadMessage, updateThreadMessage } from "./threads.js";

// A persisted marker handles restarts; this short-lived reservation closes the
// in-process race between a live event and history/rollout reconciliation.
const finalProjectionSignalReservations = new Set();

function clean(value) {
  return String(value || "").trim();
}

function isFinalAnswer(message = {}) {
  return clean(message.role).toLowerCase() === "assistant" &&
    clean(message.state || "completed").toLowerCase() === "completed" &&
    clean(message.phase || "final_answer").toLowerCase() === "final_answer";
}

function whatsappFinal(message = {}) {
  return clean(message.connector).toLowerCase() === "whatsapp" && Boolean(clean(message.chatId));
}

function signalReservationKey(threadId, messageId, env = process.env) {
  return `${clean(env.ORKESTR_HOME) || "default"}:${clean(threadId)}:${clean(messageId)}`;
}

function generationIsAccepted(thread, generation, allowUnboundGeneration = false) {
  if (!generation) return { ok: true, reason: "generation_not_provided", resolution: null };
  const match = currentCodexGenerationMatches(thread, generation);
  const resetGeneration = clean(thread?.runtime?.safeReset?.codexThreadId);
  if (match.ok) return match;
  if (allowUnboundGeneration && match.reason === "codex_generation_missing" && !resetGeneration) {
    return { ...match, ok: true, reason: "shadow_unbound_generation" };
  }
  return match;
}

async function recordProjectionRejection(type, { thread, message, generation, match, source }, env) {
  await appendEvent({
    type,
    threadId: thread.id,
    messageId: message.id,
    observedGeneration: generation || null,
    expectedGeneration: match?.resolution?.id || null,
    reason: match?.reason || "generation_rejected",
    source,
  }, env).catch(() => {});
}

/**
 * Establish the durable side effects of a Codex final answer exactly once.
 * Every projection path calls this after it has upserted the same assistant
 * message. The connector outbox remains the delivery authority; this helper
 * only creates its idempotent intent and records the pending acknowledgement.
 */
export async function reconcileCodexFinalProjection({
  thread,
  message,
  runtimeGeneration = "",
  allowUnboundGeneration = false,
  source = "unknown",
  env = process.env,
} = {}) {
  if (!thread?.id || !message?.id || !isFinalAnswer(message)) return { message, reconciled: false, reason: "not_final_answer" };
  const generation = clean(allowUnboundGeneration ? runtimeGeneration : runtimeGeneration || message.codexThreadId || message.executorThreadId);
  const initialGeneration = generationIsAccepted(thread, generation, allowUnboundGeneration);
  if (!initialGeneration.ok) {
    await recordProjectionRejection("codex_final_projection_rejected", {
      thread,
      message,
      generation,
      match: initialGeneration,
      source,
    }, env);
    return { message, reconciled: false, rejected: true, reason: initialGeneration.reason };
  }
  if (!whatsappFinal(message)) return { message, reconciled: false, reason: "not_whatsapp_final" };

  const pending = await markRuntimeFinalDeliveryPending(thread.id, {
    messageId: message.id,
    parentMessageId: message.parentMessageId,
    runtimeGeneration: generation || null,
    turnId: message.codexTurnId || message.executorTurnId || null,
    connector: "whatsapp",
    chatId: message.chatId,
    accountId: message.accountId,
  }, env).catch((error) => ({ ok: false, reason: error?.message || "final_delivery_pending_failed" }));
  if (!pending?.ok) {
    await recordProjectionRejection("codex_final_projection_pending_failed", {
      thread,
      message,
      generation,
      match: { reason: pending?.reason || "final_delivery_pending_failed" },
      source,
    }, env);
    return { message, reconciled: false, rejected: true, reason: pending?.reason || "final_delivery_pending_failed" };
  }
  const currentThread = await getThread(thread.id, env).catch(() => null) || thread;
  const postPendingGeneration = generationIsAccepted(currentThread, generation, allowUnboundGeneration);
  if (!postPendingGeneration.ok) {
    await recordProjectionRejection("codex_final_projection_post_pending_rejected", {
      thread: currentThread,
      message,
      generation,
      match: postPendingGeneration,
      source,
    }, env);
    return { message, reconciled: false, rejected: true, reason: postPendingGeneration.reason };
  }

  const ownerUserId = resourceOwnerUserId(currentThread, env);
  const sourceRevision = clean(message.finalProjectionSourceRevision) || String(Number(message.revision || 1) || 1);
  const ensured = await ensureConnectorOutboxJobThroughAdapter({
    tenantId: ownerUserId,
    ownerUserId,
    connector: "whatsapp",
    accountId: clean(message.accountId || currentThread.binding?.responderAccountId || currentThread.binding?.outboundAccountId),
    chatId: message.chatId,
    threadId: currentThread.id,
    sourceEventId: clean(message.eventId || message.sourceEventId || message.id),
    sourceMessageId: message.id,
    sourceRevision,
    deliveryType: "final",
    payload: { text: clean(message.text) },
    metadata: {
      kind: "thread",
      parentMessageId: clean(message.parentMessageId),
      runtimeGeneration: generation || "",
      finalProjection: true,
    },
  }, env);

  let projected = message;
  if (clean(message.mirrorOutboxJobId) !== clean(ensured.job?.id)) {
    projected = await updateThreadMessage(currentThread.id, message.id, {
      mirrorOutboxJobId: ensured.job?.id || null,
      mirrorDeliveryType: "final",
      finalProjectionOutboxEnsuredAt: new Date().toISOString(),
      finalProjectionRuntimeGeneration: generation || null,
      finalProjectionSourceRevision: sourceRevision,
    }, env).catch(() => message);
  }
  if (!projected.finalProjectionConnectorSignaledAt) {
    const stored = await getThreadMessage(currentThread.id, message.id, env).catch(() => null);
    if (stored?.finalProjectionConnectorSignaledAt) {
      projected = stored;
    } else {
      const reservation = signalReservationKey(currentThread.id, message.id, env);
      if (!finalProjectionSignalReservations.has(reservation)) {
        finalProjectionSignalReservations.add(reservation);
        try {
          const marked = await updateThreadMessage(currentThread.id, message.id, {
            finalProjectionConnectorSignaledAt: new Date().toISOString(),
          }, env).catch(() => null);
          if (marked?.finalProjectionConnectorSignaledAt) {
            projected = marked;
            markConnectorDeliverySignal(projected);
          }
        } finally {
          finalProjectionSignalReservations.delete(reservation);
        }
      }
    }
  }
  await appendEvent({
    type: "codex_final_projection_reconciled",
    threadId: currentThread.id,
    messageId: message.id,
    runtimeGeneration: generation || null,
    turnId: clean(message.codexTurnId || message.executorTurnId) || null,
    outboxJobId: ensured.job?.id || null,
    outboxCreated: ensured.created === true,
    finalDeliveryPending: pending?.pending === true,
    source,
  }, env).catch(() => {});
  return { message: projected, reconciled: true, outboxJob: ensured.job || null, outboxCreated: ensured.created === true };
}
