// Durable mirror acknowledgement for delegated (remote runtime) WhatsApp threads.
//
// A remote runtime that advertises `mirrorAck` keeps every exported reply listed
// until V1 reports what its WhatsApp outbox did with it. The cursor is durable on
// the V1 side: each mirrored assistant message records `remoteMirrorAck` once the
// runtime confirmed the report, so a restart resends only unconfirmed reports and
// the runtime treats a repeated report as a no-op. Reports are derived only from
// existing outbox receipts; they never send, retry or replay a WhatsApp message.
import { isNoReplyAssistantMessage } from "../../core/src/no-reply.js";
import { listThreadMessages, updateThreadMessage } from "../../core/src/threads.js";
import { appendEvent } from "../../storage/src/store.js";
import { remoteRuntimeProgressMessage, threadSuppressesWhatsAppUpdates } from "./whatsapp-mirror-policy.js";

const terminalOutcomes = new Set(["delivered", "suppressed", "no_reply", "failed"]);
const failedStates = new Set(["failed", "dead_letter", "partial_delivery"]);
const notSentStates = new Set(["suppressed", "skipped"]);

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function stringList(value) {
  return (Array.isArray(value) ? value : [value]).map((item) => pickString(item)).filter(Boolean).slice(0, 32);
}

export function remoteMirrorAckSupported(payload = {}) {
  return Number(payload?.mirrorAck?.version) === 1;
}

function latestIntent(state, messageId) {
  const intents = Array.isArray(state?.outboundIntents) ? state.outboundIntents : [];
  for (let index = intents.length - 1; index >= 0; index -= 1) {
    if (pickString(intents[index]?.messageId) === messageId) return intents[index];
  }
  return null;
}

// Maps V1's own delivery evidence to one report. null means "not decided yet".
export function remoteMirrorAckReport(message = {}, intent = null, { updatesSuppressed = false } = {}) {
  if (isNoReplyAssistantMessage(message)) return { outcome: "no_reply", reason: "no_reply" };
  const state = pickString(message.deliveryState).toLowerCase();
  const outboxJobId = pickString(message.mirrorOutboxJobId, intent?.connectorOutboxJobId);
  if (state === "delivered") {
    if (!outboxJobId) return null;
    return {
      outcome: "delivered",
      deliveryState: state,
      outboxJobId,
      connectorMessageIds: stringList(message.whatsappMessageIds?.length ? message.whatsappMessageIds : message.whatsappMessageId),
      ...(pickString(message.deliveredAt) ? { deliveredAt: pickString(message.deliveredAt) } : {}),
    };
  }
  if (notSentStates.has(state)) return { outcome: "suppressed", deliveryState: state, reason: state, ...(outboxJobId ? { outboxJobId } : {}) };
  if (failedStates.has(state)) return { outcome: "failed", deliveryState: state, reason: state, ...(outboxJobId ? { outboxJobId } : {}) };
  if (state === "delivery_uncertain") return { outcome: "uncertain", deliveryState: state, reason: state, ...(outboxJobId ? { outboxJobId } : {}) };
  const status = pickString(intent?.status).toLowerCase();
  if (status === "skipped") {
    return { outcome: "suppressed", reason: pickString(intent.error, intent.reason, "skipped"), ...(outboxJobId ? { outboxJobId } : {}) };
  }
  if (status === "failed") return { outcome: "failed", reason: pickString(intent.error, intent.reason, "failed"), ...(outboxJobId ? { outboxJobId } : {}) };
  if (status === "delivered" && outboxJobId) {
    return { outcome: "delivered", outboxJobId, connectorMessageIds: stringList(intent.whatsappMessageIds || intent.messageIds) };
  }
  // Suppressed progress leaves no outbox record; the same thread policy that
  // made the mirror skip it decides the report.
  if (!state && updatesSuppressed && remoteRuntimeProgressMessage(message)) {
    return { outcome: "suppressed", reason: "updates_suppressed" };
  }
  return null;
}

function rejectedStatus(error) {
  const status = Number(error?.statusCode || 0);
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

export async function acknowledgeRemoteMirrorDeliveries({
  thread,
  remote,
  postAck,
  readState = async () => null,
  env = process.env,
  // Optional current message list of the thread (read-only); read when absent.
  messages: currentMessages = null,
} = {}) {
  const messages = Array.isArray(currentMessages) ? currentMessages : await listThreadMessages(thread.id, env);
  const byId = new Map(messages.map((message) => [message.id, message]));
  let state;
  const counts = { acknowledged: 0, rejected: 0, failed: 0 };
  for (const message of messages) {
    if (message.role !== "assistant" || message.remoteBackend !== remote.backendId ||
        message.remoteThreadId !== remote.remoteThreadId || !pickString(message.remoteMessageId)) continue;
    const prior = message.remoteMirrorAck || null;
    if (prior && (terminalOutcomes.has(prior.outcome) || prior.rejected)) continue;
    const parent = byId.get(pickString(message.parentMessageId));
    // Orphan replies have no runtime parent to settle; they are never reported.
    if (!parent || parent.role !== "user" || !pickString(parent.remoteMessageId)) continue;
    const needsIntent = !isNoReplyAssistantMessage(message) && !pickString(message.deliveryState);
    if (needsIntent && state === undefined) state = await readState().catch(() => null);
    const report = remoteMirrorAckReport(message, needsIntent ? latestIntent(state, message.id) : null, {
      updatesSuppressed: threadSuppressesWhatsAppUpdates(thread, pickString(message.chatId, thread?.binding?.chatId), env),
    });
    if (!report || prior?.outcome === report.outcome) continue;
    const body = {
      ...report,
      remoteMessageId: pickString(message.remoteMessageId),
      parentPublicMessageId: parent.id,
      localMessageId: message.id,
      publicThreadId: thread.id,
    };
    try {
      const result = await postAck(body);
      await updateThreadMessage(thread.id, message.id, {
        remoteMirrorAck: {
          outcome: report.outcome,
          sequence: Number(result?.sequence || message.remoteExportSequence || 0) || null,
          ackedThrough: Number(result?.ackedThrough || 0) || 0,
          acknowledgedAt: new Date().toISOString(),
        },
      }, env);
      counts.acknowledged += 1;
    } catch (error) {
      if (rejectedStatus(error)) {
        // A definite refusal is final for this report; record it for operators
        // instead of resubmitting it on every delivery cycle.
        await updateThreadMessage(thread.id, message.id, {
          remoteMirrorAck: {
            outcome: report.outcome,
            rejected: pickString(error.message, "rejected"),
            acknowledgedAt: new Date().toISOString(),
          },
        }, env).catch(() => null);
        counts.rejected += 1;
      } else {
        counts.failed += 1;
      }
      await appendEvent({
        type: "whatsapp_remote_runtime_mirror_ack_failed",
        threadId: thread.id,
        messageId: message.id,
        remoteBackend: remote.backendId,
        remoteThreadId: remote.remoteThreadId,
        outcome: report.outcome,
        rejected: rejectedStatus(error),
        error: error.message || String(error),
      }, env).catch(() => {});
    }
  }
  return counts;
}
