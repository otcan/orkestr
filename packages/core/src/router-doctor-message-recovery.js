import { deliverPendingThreadInputs } from "./runtime-leases.js";
import { recordRouterTraceEvent } from "./router-traces.js";
import { phaseSet } from "./router-doctor-trace-rules.js";
import { updateThreadMessage } from "./threads.js";

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

function ageMs(value = "") {
  const ms = dateMs(value);
  return ms ? Math.max(0, Date.now() - ms) : 0;
}

function sameChat(left = {}, right = {}) {
  const leftChat = clean(left.chatId);
  const rightChat = clean(right.chatId);
  return !leftChat || !rightChat || leftChat === rightChat;
}

function newerWhatsAppUser(messages = [], userMessage = {}, whatsappMessageFn = null) {
  const userTs = dateMs(userMessage.createdAt || userMessage.updatedAt);
  return messages.find((message) =>
    message.role === "user" &&
    (typeof whatsappMessageFn !== "function" || whatsappMessageFn(message)) &&
    sameChat(message, userMessage) &&
    dateMs(message.createdAt || message.updatedAt) > userTs
  ) || null;
}

export function traceScopedMessage(message = {}, traces = [], routerTraceId = "") {
  if (!routerTraceId) return true;
  if (clean(message.routerTraceId) === routerTraceId) return true;
  const messageIds = new Set(traces.map((trace) => clean(trace.messageId)).filter(Boolean));
  return messageIds.has(clean(message.id)) || messageIds.has(clean(message.parentMessageId));
}

export function traceScopedOutboxJob(job = {}, traces = [], routerTraceId = "") {
  if (!routerTraceId) return true;
  if (clean(job.routerTraceId || job.metadata?.routerTraceId) === routerTraceId) return true;
  const messageIds = new Set(traces.map((trace) => clean(trace.messageId)).filter(Boolean));
  return messageIds.has(clean(job.sourceMessageId)) || messageIds.has(clean(job.sourceEventId));
}

export function queueNoticeWithoutRuntimeDelivery(message = {}, trace = null, thresholdMs = 60_000) {
  if (!message || message.role !== "user") return false;
  if (!["waiting_runtime_ready", "waiting_runtime_start", "awaiting_active_turn", "interrupting"].includes(lower(message.deliveryState))) return false;
  if (trace && phaseSet(trace).has("delivered_to_runtime")) return false;
  return ageMs(message.updatedAt || message.createdAt) >= thresholdMs;
}

export function runtimeDeliveryMissingAssistantIssue({
  message,
  messages,
  trace,
  status,
  thresholdMs,
  runtimeDelivered,
  shortCircuitTrace,
  assistant,
  terminalUserMessageFn,
  runtimeReadyFn,
  whatsappMessageFn,
  issueFn,
} = {}) {
  if (shortCircuitTrace || !terminalUserMessageFn(message) || !runtimeDelivered || assistant) return null;
  if (newerWhatsAppUser(messages, message, whatsappMessageFn) || !runtimeReadyFn(status)) return null;
  const messageAgeMs = ageMs(message.updatedAt || message.createdAt);
  if (messageAgeMs < thresholdMs) return null;
  return issueFn("runtime_delivery_completed_without_assistant", "error", "WhatsApp input reached an idle runtime but produced no newer same-chat assistant reply.", {
    messageId: message.id,
    routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
    messageState: clean(message.state),
    deliveryState: clean(message.deliveryState),
    ageMs: messageAgeMs,
    runtimeState: clean(status.state),
  });
}

export async function repairRuntimeDeliveryMissingAssistant(item = {}, { env, thread } = {}) {
  const updated = await updateThreadMessage(thread.id, item.messageId, {
    state: "queued",
    deliveryState: "retrying_delivery",
    error: "router_doctor_requeued_missing_assistant",
    deliveryNextAttemptAt: null,
  }, env);
  await recordRouterTraceEvent({
    routerTraceId: item.routerTraceId,
    connector: "whatsapp",
    threadId: thread.id,
    messageId: item.messageId,
    phase: "queued",
    reason: "router_doctor_requeued_missing_assistant",
    terminal: false,
  }, env).catch(() => null);
  const delivered = await deliverPendingThreadInputs(thread.id, env, { processApiAgent: true });
  return { code: "requeue_runtime_delivery_without_assistant", ok: true, threadId: thread.id, messageId: item.messageId, state: updated?.state || "", delivered };
}
