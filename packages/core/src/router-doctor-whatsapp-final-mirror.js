import { resourceOwnerUserId } from "./policy.js";
import { recordRouterTraceEvent } from "./router-traces.js";
import { updateThreadMessage } from "./threads.js";
import { abortable, throwIfAborted } from "./router-doctor-abort.js";
import { replyDeliveryBindingFence, replyDeliveryIntentStatusPatch, trustedUiReplyDeliveryIntent } from "./reply-delivery-intent.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

export function sourceRevisionForMessage(message = {}) {
  const parsed = Number(message.revision || 1);
  return String(Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1);
}

export function whatsappAssistantFinal(message = {}, whatsappMessageFn = null) {
  return message.role === "assistant" &&
    lower(message.state) === "completed" &&
    lower(message.phase || "final_answer") === "final_answer" &&
    (typeof whatsappMessageFn === "function" ? whatsappMessageFn(message) : lower(message.connector) === "whatsapp") &&
    Boolean(clean(message.chatId)) &&
    Boolean(
      clean(message.routerTraceId || message.turnId || message.mirrorOutboxJobId) ||
      ["pending_whatsapp_mirror", "delivered", "delivery_uncertain", "failed_retryable"].includes(lower(message.deliveryState))
    );
}

export function deliveredWhatsAppMirrorMessage(message = {}) {
  return lower(message.deliveryState) === "delivered" || Boolean(clean(message.deliveredAt || message.mirrorOutboxJobId));
}

export function outboxJobForFinalMessage(jobs = [], message = {}) {
  const messageId = clean(message.id);
  return (jobs || []).find((job) =>
    lower(job.connector) === "whatsapp" &&
    lower(job.deliveryType) === "final" &&
    clean(job.sourceMessageId) === messageId
  ) || null;
}

export function orphanedWhatsAppFinalAnswerIssues({
  messages = [],
  connectorOutboxJobs = [],
  thread = {},
  whatsappMessageFn = null,
  accountIdForThreadFn = null,
  issueFn = null,
} = {}) {
  const makeIssue = typeof issueFn === "function"
    ? issueFn
    : (code, severity, summary, detail = {}) => ({ code, severity, summary, ...detail });
  const issues = [];
  for (const message of messages.filter((item) => whatsappAssistantFinal(item, whatsappMessageFn))) {
    const job = outboxJobForFinalMessage(connectorOutboxJobs, message);
    if (job || deliveredWhatsAppMirrorMessage(message)) continue;
    issues.push(makeIssue("orphaned_whatsapp_final_answer", "error", "Completed WhatsApp assistant final has no mirror delivery marker or connector outbox job.", {
      threadId: thread.id,
      messageId: message.id,
      routerTraceId: clean(message.routerTraceId),
      chatId: clean(message.chatId),
      accountId: clean(message.accountId || (typeof accountIdForThreadFn === "function" ? accountIdForThreadFn(thread) : "")),
      sourceRevision: sourceRevisionForMessage(message),
    }));
  }
  const existingMessageIds = new Set(issues.map((issue) => clean(issue.messageId)));
  for (const parent of messages) {
    const intent = trustedUiReplyDeliveryIntent(parent);
    if (!intent || intent.status !== "pending_reply") continue;
    const message = messages.find((candidate) =>
      candidate.role === "assistant" &&
      lower(candidate.state) === "completed" &&
      lower(candidate.phase || "final_answer") === "final_answer" &&
      clean(candidate.parentMessageId) === clean(parent.id)
    );
    if (!message || existingMessageIds.has(clean(message.id))) continue;
    const job = outboxJobForFinalMessage(connectorOutboxJobs, message);
    if (job || deliveredWhatsAppMirrorMessage(message)) continue;
    issues.push(makeIssue("orphaned_ui_whatsapp_reply_delivery", "error", "Completed WebUI-requested final has no WhatsApp connector outbox job.", {
      threadId: thread.id,
      messageId: message.id,
      parentMessageId: parent.id,
      replyDeliveryIntentId: clean(intent.id),
      chatId: clean(intent.target?.chatId),
      accountId: clean(intent.target?.accountId),
      sourceRevision: sourceRevisionForMessage(message),
    }));
  }
  return issues;
}

export async function repairOrphanedWhatsAppFinalAnswer(item = {}, context = {}) {
  const { env, thread, ensureConnectorOutboxJobFn, accountIdForThreadFn, signal } = context;
  if (typeof ensureConnectorOutboxJobFn !== "function") return null;
  const message = (Array.isArray(context.messages) ? context.messages : []).find((entry) => clean(entry.id) === clean(item.messageId));
  if (!message) return null;
  const parent = (Array.isArray(context.messages) ? context.messages : []).find((entry) => clean(entry.id) === clean(item.parentMessageId || message.parentMessageId));
  const fence = replyDeliveryBindingFence(parent || {}, thread || {});
  if (fence.applies && !fence.allowed) {
    const patch = replyDeliveryIntentStatusPatch(parent, "policy_skipped", { reason: fence.reason });
    if (patch) await updateThreadMessage(thread.id, parent.id, patch, env).catch(() => null);
    return { ok: false, skipped: true, reason: fence.reason };
  }
  const chatId = clean(item.chatId || message.chatId || thread?.binding?.chatId);
  if (!chatId) return null;
  const accountId = clean(item.accountId || message.accountId || (typeof accountIdForThreadFn === "function" ? accountIdForThreadFn(thread) : ""));
  const ownerUserId = resourceOwnerUserId(thread || {}, env);
  throwIfAborted(signal);
  const result = await abortable(ensureConnectorOutboxJobFn({
    tenantId: ownerUserId,
    ownerUserId,
    connector: "whatsapp",
    accountId,
    chatId,
    threadId: thread.id,
    sourceEventId: clean(message.eventId || message.sourceEventId || message.id),
    sourceMessageId: clean(message.id),
    sourceRevision: sourceRevisionForMessage(message),
    deliveryType: "final",
    payload: { text: clean(message.text) },
    metadata: {
      kind: "thread",
      parentMessageId: clean(message.parentMessageId),
      routerTraceId: clean(message.routerTraceId),
      repairedBy: "router_doctor_whatsapp",
    },
  }, env), signal);
  throwIfAborted(signal);
  await abortable(updateThreadMessage(thread.id, message.id, {
    mirrorOutboxJobId: result.job.id,
    mirrorDeliveryType: "final",
    deliveryState: "pending_whatsapp_mirror",
    deliveryLastAttemptAt: nowIso(),
    deliveryError: "",
  }, env).catch(() => null), signal);
  throwIfAborted(signal);
  await abortable(recordRouterTraceEvent({
    routerTraceId: clean(message.routerTraceId),
    connector: "whatsapp",
    threadId: thread.id,
    messageId: message.id,
    phase: "assistant_seen",
    reason: "router_doctor_enqueued_orphaned_final_answer",
    deliveryType: "final",
    chatId,
    accountId,
    connectorOutboxJobId: result.job.id,
  }, env).catch(() => null), signal);
  return {
    code: "enqueue_orphaned_final_answer_mirror",
    ok: true,
    threadId: thread.id,
    messageId: message.id,
    outboxJobId: result.job.id,
    state: result.job.state,
    created: result.created === true,
  };
}
