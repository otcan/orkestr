import { updateAgentMessage } from "../../core/src/messages.js";
import { appendEvent } from "../../storage/src/store.js";
import { updateThreadMessage } from "../../core/src/threads.js";
import { parseThreadInputCommand } from "../../core/src/thread-commands.js";
import { whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";
import { stripWhatsAppDebugFooter } from "./whatsapp-formatting.js";
import { shouldMirrorWhatsAppProgress, shouldMirrorWhatsAppReply } from "./whatsapp-mirror-policy.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function latestProgressReplyForParent(messages, parentId, env = process.env) {
  return [...messages]
    .reverse()
    .find((candidate) =>
      candidate.role === "assistant" &&
      candidate.state === "completed" &&
      candidate.parentMessageId === parentId &&
      shouldMirrorWhatsAppProgress(candidate, env)
    ) || null;
}

export function completedFinalReplyForParent(messages, parentId) {
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    candidate.parentMessageId === parentId &&
    shouldMirrorWhatsAppReply(candidate)
  ) || null;
}

function messageTimeMs(message = {}) {
  const ms = Date.parse(String(message.timestamp || message.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function completedFinalReplyForTypingParent(messages = [], parent = null, chatId = "") {
  if (!parent) return null;
  const direct = completedFinalReplyForParent(messages, parent.id);
  if (direct) return direct;
  const parentMs = messageTimeMs(parent);
  if (!parentMs) return null;
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    shouldMirrorWhatsAppReply(candidate) &&
    messageTimeMs(candidate) >= parentMs &&
    (!chatId || !candidate.chatId || candidate.chatId === chatId)
  ) || null;
}

function whatsappTypingCooldownMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS || env.WHATSAPP_TYPING_COOLDOWN_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 10_000;
}

function latestOutboundDeliveryForTypingParent(state = null, parent = null, chatId = "", predicate = null) {
  if (!parent || !chatId) return null;
  const parentMs = messageTimeMs(parent);
  return [...(state?.outboundDeliveries || [])]
    .reverse()
    .find((delivery) => {
      if (delivery.chatId !== chatId) return false;
      if (predicate && !predicate(delivery)) return false;
      if (parent.id && delivery.parentMessageId === parent.id) return true;
      const deliveredMs = Date.parse(String(delivery.deliveredAt || ""));
      return Number.isFinite(deliveredMs) && (!parentMs || deliveredMs >= parentMs);
    }) || null;
}

function latestFinalOutboundDeliveryForTypingParent(state = null, parent = null, chatId = "") {
  return latestOutboundDeliveryForTypingParent(state, parent, chatId, (delivery) =>
    String(delivery?.deliveryType || "").trim().toLowerCase() === "final"
  );
}

function typingCooldownActive(state = null, parent = null, chatId = "", env = process.env) {
  const cooldownMs = whatsappTypingCooldownMs(env);
  if (!cooldownMs) return false;
  const delivery = latestOutboundDeliveryForTypingParent(state, parent, chatId);
  const deliveredMs = Date.parse(String(delivery?.deliveredAt || ""));
  return Number.isFinite(deliveredMs) && Date.now() - deliveredMs < cooldownMs;
}

export function whatsappOutboundDeliveryRetentionLimit(env = process.env) {
  const raw = env.ORKESTR_WHATSAPP_OUTBOUND_DELIVERY_RETENTION;
  const parsed = Number(raw || 5000);
  const minimum = raw ? 1 : 500;
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : 5000;
}

function whatsappReplyBackfillWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_REPLY_BACKFILL_WINDOW_MS || 15 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 15 * 60 * 1000;
}

function whatsappProgressBackfillWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_PROGRESS_BACKFILL_WINDOW_MS || 5 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5 * 60 * 1000;
}

function oldestOutboundDeliveryMs(outboundDeliveries = []) {
  return Math.min(
    ...outboundDeliveries
      .map((delivery) => Date.parse(String(delivery?.deliveredAt || "")))
      .filter(Number.isFinite),
  );
}

export function staleUntrackedWhatsAppReply(message = {}, outboundDeliveries = [], env = process.env) {
  const messageMs = messageTimeMs(message);
  if (!messageMs) return false;
  const backfillWindowMs = whatsappReplyBackfillWindowMs(env);
  if (backfillWindowMs && Date.now() - messageMs > backfillWindowMs) return true;
  if (outboundDeliveries.length < whatsappOutboundDeliveryRetentionLimit(env)) return false;
  const oldestDeliveryMs = oldestOutboundDeliveryMs(outboundDeliveries);
  return Number.isFinite(oldestDeliveryMs) && messageMs < oldestDeliveryMs;
}

export function staleUntrackedWhatsAppProgress(message = {}, outboundDeliveries = [], env = process.env) {
  const messageMs = messageTimeMs(message);
  if (!messageMs) return false;
  const backfillWindowMs = whatsappProgressBackfillWindowMs(env);
  if (backfillWindowMs && Date.now() - messageMs > backfillWindowMs) return true;
  if (outboundDeliveries.length < whatsappOutboundDeliveryRetentionLimit(env)) return false;
  const oldestDeliveryMs = oldestOutboundDeliveryMs(outboundDeliveries);
  return Number.isFinite(oldestDeliveryMs) && messageMs < oldestDeliveryMs;
}

export function threadAllowsWhatsAppMirroring(thread) {
  if (!thread?.binding) return true;
  return whatsappBindingIsRouteEligible(thread.binding) &&
    thread.binding.mirrorToWhatsApp !== false &&
    thread.binding.mirrorReplies !== false;
}

export function boundThreadWhatsAppAssistantOrigin({ message = {}, thread = null, kind = "" } = {}) {
  if (kind !== "thread" || !threadAllowsWhatsAppMirroring(thread)) return false;
  const binding = thread?.binding || {};
  if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return false;
  const bindingChatId = pickString(binding.chatId);
  const messageChatId = pickString(message.chatId, bindingChatId);
  return Boolean(bindingChatId && messageChatId === bindingChatId);
}

function whatsappMessageOrigin(message, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
}

export function initialQueueDeliveryState(status = null, message = null) {
  const parsed = parseThreadInputCommand({ text: message?.text || "" });
  if (parsed.command === "interrupt") return "interrupting";
  if (!status) return "";
  const state = String(status.state || "").trim().toLowerCase();
  const runtimeKind = String(status.runtimeKind || status.runtimeState || "").trim().toLowerCase();
  if (runtimeKind === "api-agent") {
    return state === "working" ? "awaiting_runtime_completion" : "waiting_runtime_ready";
  }
  const isCodexAppServer = runtimeKind === "codex-app-server";
  if (isCodexAppServer && state === "working") return "awaiting_active_turn";
  if (isCodexAppServer && state === "awaiting_approval") return "awaiting_approval";
  if (isCodexAppServer && ["sleeping", "waking", "unloaded", "notloaded", "failed", "migration_required"].includes(state)) {
    return "waking";
  }
  if (isCodexAppServer) return "";
  if (state === "working") return "awaiting_runtime_completion";
  if (state === "waking" || state === "sleeping") return "waiting_runtime_start";
  if (!status.sessionName) return "waiting_runtime_start";
  if (status.promptReady === false) return "waiting_runtime_ready";
  return "";
}

function runtimeKindFromStatus(status = null) {
  return String(status?.runtimeKind || status?.runtimeState || "").trim().toLowerCase();
}

function runtimeStateFromStatus(status = null) {
  return String(status?.state || status?.status || "").trim().toLowerCase();
}

function runtimeActiveTurnId(status = null) {
  return String(status?.activeTurnId || status?.turnId || "").trim();
}

function runtimeTypingActive(status = null) {
  if (!status) return false;
  const lifecycle = status.turnLifecycle && typeof status.turnLifecycle === "object" ? status.turnLifecycle : null;
  if (lifecycle) {
    if (lifecycle.awaitingApproval === true || lifecycle.queued === true) return false;
    if (Object.prototype.hasOwnProperty.call(lifecycle, "typingActive")) return lifecycle.typingActive === true;
  }
  const state = runtimeStateFromStatus(status);
  if (state === "frozen" || status.frozen === true) return false;
  const isCodexAppServer = runtimeKindFromStatus(status) === "codex-app-server";
  if (isCodexAppServer) {
    if (!runtimeActiveTurnId(status)) return false;
    if (state === "awaiting_approval") return false;
  }
  const explicitForeground = status.typingActive === true || status.foregroundWorking === true;
  if (explicitForeground) return true;
  const hasExplicitForegroundSignal = Object.prototype.hasOwnProperty.call(status, "typingActive") ||
    Object.prototype.hasOwnProperty.call(status, "foregroundWorking");
  if (hasExplicitForegroundSignal) return false;
  if (status.backgroundWork === true || status.progress?.staleWorkingPrompt === true) return false;
  if (isCodexAppServer) return status.working === true || state === "working" || state === "running";
  return status.working === true || state === "working" || state === "running";
}

function deferredWhatsAppTypingDeliveryState(message = {}) {
  const deliveryState = String(message.deliveryState || "").trim().toLowerCase();
  return [
    "awaiting_active_turn",
    "awaiting_approval",
    "interrupting",
  ].includes(deliveryState);
}

function latestWhatsAppTypingParent(messages = [], thread = null, state = null) {
  return [...messages].reverse().find((message) => {
    if (String(message?.role || "").trim().toLowerCase() !== "user") return false;
    if (!whatsappMessageOrigin(message, state)) return false;
    const chatId = pickString(message.chatId, thread?.binding?.chatId);
    if (!chatId) return false;
    const messageState = String(message.state || "").trim().toLowerCase();
    if (messageState === "failed") return false;
    if (deferredWhatsAppTypingDeliveryState(message)) return false;
    if (latestFinalOutboundDeliveryForTypingParent(state, message, chatId)) return false;
    if (completedFinalReplyForTypingParent(messages, message, chatId)) return false;
    return true;
  }) || null;
}

export function whatsappTypingTargetForThread({ thread, messages = [], status = null, state = null, env = process.env } = {}) {
  if (!threadAllowsWhatsAppMirroring(thread)) return null;
  if (!runtimeTypingActive(status)) return null;
  const parent = latestWhatsAppTypingParent(messages, thread, state);
  if (!parent) return null;
  const chatId = pickString(parent.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  if (typingCooldownActive(state, parent, chatId, env)) return null;
  return {
    threadId: thread?.id || null,
    messageId: parent.id || null,
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      parent.accountId,
    ),
  };
}

function passiveMirrorCanCompleteParent(parent, reply, chatId, state = null) {
  if (!parent || parent.role !== "user" || !whatsappMessageOrigin(parent, state)) return false;
  const parentState = String(parent.state || "").trim().toLowerCase();
  const parentDeliveryState = String(parent.deliveryState || "").trim().toLowerCase();
  const recoverableStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running", "failed"]);
  const recoverableDeliveryStates = new Set([
    "awaiting_ack",
    "awaiting_ack_unobserved",
    "awaiting_runtime_completion",
    "blocked_frozen_runtime",
    "codex_app_server_sending",
    "delivering",
    "failed",
    "recovering_stale_ack",
    "retrying_delivery",
    "waiting_runtime_ready",
    "waiting_runtime_start",
    "waking",
  ]);
  if (parentDeliveryState && !recoverableDeliveryStates.has(parentDeliveryState)) return false;
  if (!recoverableStates.has(parentState) && !recoverableDeliveryStates.has(parentDeliveryState)) return false;
  const parentChatId = pickString(parent.chatId, reply?.chatId);
  const replyChatId = pickString(chatId, reply?.chatId, parent.chatId);
  return !parentChatId || !replyChatId || parentChatId === replyChatId;
}

export function completedAssistantReplyForParent(messages, parent, chatId, state = null) {
  if (!parent?.id) return null;
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    candidate.parentMessageId === parent.id &&
    shouldMirrorWhatsAppReply(candidate) &&
    passiveMirrorCanCompleteParent(parent, candidate, chatId, state)
  ) || null;
}

export async function completePassiveMirrorParent({ kind, agentId, threadId, parent, reply, chatId, delivery = null, state, env }) {
  if (!passiveMirrorCanCompleteParent(parent, reply, chatId, state)) return null;
  const previousState = parent.state || null;
  const previousDeliveryState = parent.deliveryState || null;
  const patch = {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: delivery?.deliveredAt || new Date().toISOString(),
    observedVia: "whatsapp_passive_mirror_delivery",
    passiveMirrorMessageId: reply?.id || null,
    error: null,
  };
  const updated = kind === "thread"
    ? await updateThreadMessage(threadId, parent.id, patch, env)
    : await updateAgentMessage(agentId, parent.id, patch, env);
  Object.assign(parent, updated);
  await appendEvent({
    type: "whatsapp_passive_mirror_parent_completed",
    kind,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: parent.id,
    replyMessageId: reply?.id || null,
    chatId: pickString(chatId, reply?.chatId, parent.chatId),
    previousState,
    previousDeliveryState,
  }, env).catch(() => {});
  return updated;
}

export async function recoverParentsForAlreadyMirroredReplies(messageSets, deliveredIds, outboundDeliveries, state, env) {
  const deliveriesByMessageId = new Map((outboundDeliveries || [])
    .filter((delivery) => delivery?.messageId)
    .map((delivery) => [delivery.messageId, delivery]));
  for (const { agentId, threadId, messages, kind } of messageSets) {
    for (const reply of messages) {
      if (reply.role !== "assistant" || reply.state !== "completed" || !deliveredIds.has(reply.id)) continue;
      if (!shouldMirrorWhatsAppReply(reply)) continue;
      const parent = messages.find((entry) => entry.id === reply.parentMessageId);
      if (!parent) continue;
      const delivery = deliveriesByMessageId.get(reply.id) || null;
      await completePassiveMirrorParent({
        kind,
        agentId,
        threadId,
        parent,
        reply,
        chatId: pickString(reply.chatId, parent.chatId, delivery?.chatId),
        delivery,
        state,
        env,
      }).catch(() => null);
    }
  }
}

export function failedWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const observedVia = String(message?.observedVia || "").trim().toLowerCase();
  if (role !== "user" || (messageState !== "failed" && deliveryState !== "failed")) return null;
  if (observedVia === "stale_ack_recovery_exhausted") return null;
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

export function formatWhatsAppDeliveryFailure(message) {
  const reason = pickString(message.error, message.deliveryError, "Orkestr could not confirm this message reached Codex.")
    .replace(/\s+/g, " ")
    .slice(0, 600)
    .trim();
  return [
    "Delivery failed",
    "",
    "Your message could not be delivered to Codex.",
    `Reason: ${reason || "Unknown error."}`,
  ].join("\n");
}

function whatsappQueueNoticeOrigin(message, thread, state) {
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

export function queuedInputWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  if (role !== "user") return null;
  if (!["queued", "pending_delivery"].includes(messageState)) return null;
  const queueableStates = [
    "awaiting_runtime_completion", "awaiting_active_turn", "awaiting_approval", "interrupting",
    "recovering_stale_ack", "retrying_delivery", "waiting_runtime_ready", "waiting_runtime_start", "waking",
  ];
  if (!queueableStates.includes(deliveryState)) return null;
  const target = whatsappQueueNoticeOrigin(message, thread, state);
  return target ? { ...target, reason: deliveryState || messageState } : null;
}

function queueNoticePreview(message) {
  const text = stripQueuePreviewDebugFooter(pickString(message?.text, message?.promptFile ? "message from prompt file" : "message"));
  const parsed = parseThreadInputCommand({ text });
  const previewText = stripQueuePreviewNoticeWrappers(stripQueuePreviewDebugFooter(parsed.command === "interrupt" && parsed.text ? parsed.text : text));
  const normalized = previewText.replace(/\s+/g, " ").trim();
  if (generatedQueueNoticePreviewFragment(normalized)) return "";
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function stripQueuePreviewDebugFooter(text) {
  return stripWhatsAppDebugFooter(text).replace(/\s+dbg:\s*m:[^\n]*$/i, "").trim();
}

function stripQueuePreviewNoticeWrappers(text) {
  let current = String(text || "").trim();
  for (let i = 0; i < 5; i += 1) {
    const next = stripQueuePreviewNoticeWrapper(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function stripQueuePreviewNoticeWrapper(text) {
  const value = String(text || "").trim();
  const patterns = [
    /^Queued for the next Codex turn:\s*["“](.*)["”]\.?\s*$/i,
    /^Added after the current Codex turn:\s*["“](.*)["”]\.\s*Use \/now to interrupt\.?\s*$/i,
    /^Queued your message while Orkestr prepares this thread:\s*["“](.*)["”]\.?\s*$/i,
    /^Runtime handoff is taking longer than expected:\s*["“](.*)["”]\.?\s*$/i,
    /^Waking this Orkestr thread and queued your message:\s*["“](.*)["”]\.?\s*$/i,
    /^Waking this thread\. Your message will run after startup:\s*["“](.*)["”]\.?\s*$/i,
    /^Queued your latest message while current work is still running:\s*["“](.*)["”]\.?\s*$/i,
    /^Queued behind current work:\s*["“](.*)["”]\.?\s*$/i,
    /^Interrupting the current Codex turn and queued your message:\s*["“](.*)["”]\.?\s*$/i,
    /^Queued your latest message while Orkestr recovers this thread:\s*["“](.*)["”]\.?\s*$/i,
    /^Delivery is paused to avoid duplicates\. Orkestr is recovering this thread:\s*["“](.*)["”]\.?\s*$/i,
    /^Queued your message while Codex is waiting for approval:\s*["“](.*)["”]\.\s*Send \/approve or \/deny to answer the approval request\.?\s*$/i,
    /^Codex is waiting for approval\. Your message is held:\s*["“](.*)["”]\.\s*Send \/approve or \/deny\.?\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  const prefixes = [
    /^Queued for the next Codex turn:\s*["“]?/i,
    /^Added after the current Codex turn:\s*["“]?/i,
    /^Queued your message while Orkestr prepares this thread:\s*["“]?/i,
    /^Runtime handoff is taking longer than expected:\s*["“]?/i,
    /^Waking this Orkestr thread and queued your message:\s*["“]?/i,
    /^Waking this thread\. Your message will run after startup:\s*["“]?/i,
    /^Queued your latest message while current work is still running:\s*["“]?/i,
    /^Queued behind current work:\s*["“]?/i,
    /^Interrupting the current Codex turn and queued your message:\s*["“]?/i,
    /^Queued your latest message while Orkestr recovers this thread:\s*["“]?/i,
    /^Delivery is paused to avoid duplicates\. Orkestr is recovering this thread:\s*["“]?/i,
    /^Queued your message while Codex is waiting for approval:\s*["“]?/i,
    /^Codex is waiting for approval\. Your message is held:\s*["“]?/i,
  ];
  for (const prefix of prefixes) {
    if (prefix.test(value)) {
      return value
        .replace(prefix, "")
        .replace(/\s*Send \/approve or \/deny to answer the approval request\.?\s*$/i, "")
        .replace(/\s*Send \/approve or \/deny\.?\s*$/i, "")
        .replace(/\s*Use \/now to interrupt\.?\s*$/i, "")
        .replace(/["”]\.?\s*$/, "")
        .trim();
    }
  }
  return value;
}

function generatedQueueNoticePreviewFragment(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!value) return false;
  const prefixes = [
    "queued for the nex",
    "added after the current codex turn",
    "queued your message while orkestr prepares",
    "runtime handoff is taking longer than expected",
    "waking this orkestr thread and queued",
    "waking this thread. your message will run after startup",
    "queued your latest message while current work",
    "queued behind current work",
    "interrupting the current codex turn and queued",
    "queued your latest message while orkestr recovers",
    "delivery is paused to avoid duplicates",
    "queued your message while codex is waiting",
    "codex is waiting for approval",
  ];
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function queueNoticePreviewClause(preview) {
  return preview ? `: "${preview}".` : ".";
}

export function formatWhatsAppQueueNotice(message, reason = "") {
  const preview = queueNoticePreview(message);
  const normalizedReason = String(reason || "").trim().toLowerCase();
  if (normalizedReason === "awaiting_active_turn") {
    return `Added after the current Codex turn${queueNoticePreviewClause(preview)} Use /now to interrupt.`;
  }
  if (normalizedReason === "awaiting_approval") {
    return `Codex is waiting for approval. Your message is held${queueNoticePreviewClause(preview)} Send /approve or /deny.`;
  }
  if (["waiting_runtime_start", "waking"].includes(normalizedReason)) {
    return `Waking this thread. Your message will run after startup${queueNoticePreviewClause(preview)}`;
  }
  if (normalizedReason === "awaiting_runtime_completion") {
    return `Queued behind current work${queueNoticePreviewClause(preview)}`;
  }
  if (normalizedReason === "interrupting") {
    return `Interrupting the current Codex turn and queued your message${queueNoticePreviewClause(preview)}`;
  }
  if (["recovering_stale_ack", "retrying_delivery"].includes(normalizedReason)) {
    return `Delivery is paused to avoid duplicates. Orkestr is recovering this thread${queueNoticePreviewClause(preview)}`;
  }
  if (normalizedReason === "waiting_runtime_ready") {
    return `Runtime handoff is taking longer than expected${queueNoticePreviewClause(preview)}`;
  }
  return `Queued for delivery${queueNoticePreviewClause(preview)}`;
}

export function queuedModeWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const mode = String(message?.text || "").trim().match(/^\/(code|coding|plan|planning)\b/i)?.[1]?.toLowerCase();
  if (role !== "user" || messageState !== "queued" || deliveryState !== "waiting_runtime_ready" || !mode) return null;
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    mode: mode === "coding" ? "code" : mode === "planning" ? "plan" : mode,
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

export function formatWhatsAppModeQueued(mode) {
  return `Mode switch queued. Orkestr will switch to ${mode} when Codex is ready.`;
}
