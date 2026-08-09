import { appendEvent } from "../../storage/src/store.js";
import { getThread } from "./threads.js";
import { codexGenerationFencingMode, currentCodexGeneration } from "./codex-generation-lineage.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { markRuntimeFinalDeliveryPending } from "./runtime-final-delivery.js";
import { whatsappOrigin } from "./codex-app-server-whatsapp.js";

function clean(value) {
  return String(value || "").trim();
}

export async function ensureCodexFinalProjectionDelivery(threadOrId, message, input = {}, env = process.env) {
  if (!message || clean(message.phase || "final_answer").toLowerCase() !== "final_answer") {
    return { ok: true, final: false, signaled: false, message };
  }
  const thread = typeof threadOrId === "string"
    ? await getThread(threadOrId, env).catch(() => null)
    : await getThread(threadOrId?.id, env).catch(() => null) || threadOrId;
  if (!thread) return { ok: false, final: true, signaled: false, reason: "thread_not_found", message };
  const expectedGeneration = currentCodexGeneration(thread);
  const observedGeneration = clean(input.runtimeGeneration || message.codexThreadId || message.executorThreadId);
  const strictGeneration = codexGenerationFencingMode(env) === "enforce";
  if ((strictGeneration && !expectedGeneration) || (expectedGeneration && observedGeneration && observedGeneration !== expectedGeneration)) {
    await appendEvent({
      type: "codex_rollout_identity_mismatch",
      threadId: thread.id,
      expectedGeneration: expectedGeneration || null,
      observedGeneration: observedGeneration || null,
      turnId: clean(input.turnId || message.codexTurnId || message.executorTurnId) || null,
      itemId: clean(message.codexItemId || message.executorItemId) || null,
      projectionSource: clean(input.source || message.source) || null,
      repairAction: "rejected_projection",
      outcome: "generation_mismatch",
    }, env).catch(() => {});
    return { ok: false, final: true, signaled: false, reason: "codex_generation_mismatch", message };
  }
  if (!whatsappOrigin(message)) return { ok: true, final: true, signaled: false, message };
  const currentDelivery = thread.runtime?.finalDelivery || null;
  const alreadyEstablished = clean(currentDelivery?.messageId) === clean(message.id);
  if (!alreadyEstablished) {
    await markRuntimeFinalDeliveryPending(thread.id, {
      messageId: message.id,
      parentMessageId: message.parentMessageId,
      runtimeGeneration: expectedGeneration || observedGeneration,
      turnId: clean(input.turnId || message.codexTurnId || message.executorTurnId),
      connector: "whatsapp",
      chatId: message.chatId,
      accountId: message.accountId,
      projectionSource: clean(input.source || message.source),
    }, env);
  }
  const shouldSignal = input.signal !== false && (!alreadyEstablished || input.forceSignal === true);
  if (shouldSignal) markConnectorDeliverySignal(message);
  if (!alreadyEstablished && clean(input.source) && clean(input.source) !== "live") {
    await appendEvent({
      type: "codex_final_projection_recovered",
      threadId: thread.id,
      expectedGeneration,
      turnId: clean(input.turnId || message.codexTurnId || message.executorTurnId) || null,
      itemId: clean(message.codexItemId || message.executorItemId) || null,
      projectionSource: clean(input.source),
      messageId: message.id,
      repairAction: "established_final_delivery",
      outcome: "pending",
    }, env).catch(() => {});
    if (clean(input.source) === "doctor") {
      await appendEvent({
        type: "codex_final_delivery_backfilled",
        threadId: thread.id,
        expectedGeneration,
        turnId: clean(input.turnId || message.codexTurnId || message.executorTurnId) || null,
        itemId: clean(message.codexItemId || message.executorItemId) || null,
        projectionSource: "doctor",
        messageId: message.id,
        repairAction: "backfilled_final_delivery",
        outcome: "pending",
      }, env).catch(() => {});
    }
  }
  return { ok: true, final: true, signaled: shouldSignal, pendingCreated: !alreadyEstablished, message };
}
