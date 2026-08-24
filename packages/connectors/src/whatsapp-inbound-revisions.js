import { resourceOwnerUserId } from "../../core/src/policy.js";
import { ensureRouterTurn, recordRouterTraceEvent } from "../../core/src/router-traces.js";
import { listThreadMessages, updateThreadMessage } from "../../core/src/threads.js";
import { appendEvent } from "../../storage/src/store.js";
import { updateRemoteWhatsAppThreadInput } from "./whatsapp-remote-runtime.js";

function clean(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function sameSender(left = {}, right = {}) {
  const leftFrom = clean(left.from, left.sender, left.author);
  const rightFrom = clean(right.from, right.sender, right.author);
  return !leftFrom || !rightFrom || leftFrom === rightFrom;
}

function mergedText(left = "", right = "") {
  const first = String(left || "").trim();
  const second = String(right || "").trim();
  if (!first) return second;
  if (!second || first.includes(second)) return first;
  return `${first}\n\n${second}`;
}

function mergedAttachments(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const attachment of Array.isArray(group) ? group : []) {
      const key = [
        clean(attachment?.path, attachment?.url, attachment?.id, attachment?.remoteAttachmentId),
        clean(attachment?.filename, attachment?.name),
        clean(attachment?.mimetype, attachment?.type),
      ].join("\n");
      if (key.trim() && seen.has(key)) continue;
      if (key.trim()) seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function hasAttachments(message = {}) {
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

function payloadsCanCoalesce(existing = {}, input = {}) {
  if (!hasAttachments(existing) && !hasAttachments(input)) return false;
  const existingText = String(existing.text || "").trim();
  const nextText = String(input.text || "").trim();
  if (existingText && nextText && existingText === nextText) return false;
  return true;
}

function recentCoalescibleInput(messages = [], input = {}, windowMs = 0) {
  if (windowMs <= 0 || clean(input.promptFile)) return null;
  const receivedMs = timestampMs(input.receivedAt || input.timestamp) || Date.now();
  return [...messages].reverse().find((message) => {
    if (message?.role !== "user") return false;
    if (message.source !== "whatsapp_inbound" || message.connector !== "whatsapp") return false;
    if (clean(message.promptFile)) return false;
    if (!payloadsCanCoalesce(message, input)) return false;
    if (clean(message.chatId) !== clean(input.chatId)) return false;
    if (!sameSender(message, input)) return false;
    const state = clean(message.state).toLowerCase();
    if (state === "failed" || state === "cancelled") return false;
    const messageMs = timestampMs(message.createdAt || message.timestamp);
    if (!messageMs || receivedMs - messageMs < 0 || receivedMs - messageMs > windowMs) return false;
    return !messages.some((candidate) =>
      candidate?.role === "assistant" &&
      candidate.parentMessageId === message.id &&
      candidate.state === "completed"
    );
  }) || null;
}

function attachmentRecoverySourceEventId(input = {}) {
  return input.attachmentRecovery === true ? clean(input.sourceEventId) : "";
}

function attachmentRecoveryEvent(state = {}, input = {}, threadId = "") {
  const sourceEventId = attachmentRecoverySourceEventId(input);
  if (!sourceEventId) return null;
  return [...(state.inboundEvents || [])].reverse().find((event) =>
    clean(event.eventId, event.sourceEventId) === sourceEventId &&
    (!threadId || !clean(event.threadId) || clean(event.threadId) === clean(threadId)) &&
    Boolean(clean(event.messageId))
  ) || null;
}

export async function coalesceWhatsAppInboundRevision({
  thread,
  messageInput,
  input = {},
  state = {},
  eventId,
  canonicalEventId,
  routerTraceId,
  turnId,
  accountId,
  coalesceWindowMs = 0,
  env = process.env,
} = {}) {
  if (!thread?.id) return null;
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const recoveryEvent = attachmentRecoveryEvent(state, input, thread.id);
  const recoveryMessageId = clean(recoveryEvent?.messageId);
  const recoveryTarget = recoveryMessageId
    ? messages.find((message) => message.id === recoveryMessageId && message.role === "user" && message.source === "whatsapp_inbound") || null
    : null;
  const existing = recoveryTarget || recentCoalescibleInput(messages, messageInput, coalesceWindowMs);
  if (!existing) return null;
  const attachmentRecovery = Boolean(recoveryTarget);
  const coalescedEventIds = [
    ...new Set([
      ...(Array.isArray(existing.coalescedEventIds) ? existing.coalescedEventIds : []),
      clean(existing.sourceEventId),
      eventId,
    ].filter(Boolean)),
  ];
  const patch = {
    text: mergedText(existing.text, messageInput.text),
    attachments: mergedAttachments(existing.attachments, messageInput.attachments),
    coalescedEventIds,
    coalescedAt: new Date().toISOString(),
    coalescedCount: coalescedEventIds.length,
    ...(attachmentRecovery ? {
      whatsappInboundRevisionIds: [
        ...new Set([
          ...(Array.isArray(existing.whatsappInboundRevisionIds) ? existing.whatsappInboundRevisionIds : []),
          eventId,
        ].filter(Boolean)),
      ],
      whatsappInboundRevisionSourceEventId: attachmentRecoverySourceEventId(input),
      whatsappInboundRevisionState: "updated_original",
    } : {}),
  };
  if (messageInput.steerActiveTurn === true) patch.steerActiveTurn = true;
  if (clean(messageInput.codexDeliveryMode)) patch.codexDeliveryMode = clean(messageInput.codexDeliveryMode);
  const message = await updateThreadMessage(thread.id, existing.id, patch, env);
  await appendEvent({
    type: "whatsapp_inbound_coalesced",
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    threadId: thread.id,
    messageId: message.id,
    chatId: clean(messageInput.chatId),
    accountId,
    coalescedCount: patch.coalescedCount,
    attachmentRecovery,
    previousState: clean(existing.state),
  }, env).catch(() => {});
  return {
    message,
    previousState: clean(existing.state).toLowerCase(),
    attachmentRecovery,
  };
}

export async function finishWhatsAppInboundRevision({
  coalesced,
  input,
  state,
  writeState,
  thread,
  threadRoute,
  remoteRuntime = null,
  eventId,
  canonicalEventId,
  routerTraceId,
  turnId,
  threadId,
  chatId,
  from,
  accountId,
  inboundDedupeKey,
  scheduleThreadKick,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  let message = coalesced.message;
  let runtimeEdit = null;
  let fallbackReason = "";
  if (remoteRuntime) {
    try {
      const result = await updateRemoteWhatsAppThreadInput({ thread, message, revisionId: eventId }, env, fetchImpl);
      runtimeEdit = {
        supported: true,
        duplicate: result?.duplicate === true,
        remoteMessageId: clean(result?.message?.id, result?.message?.messageId, message.remoteMessageId),
      };
      message = await updateThreadMessage(thread.id, message.id, {
        whatsappInboundRevisionState: "remote_updated",
        whatsappInboundRevisionRemoteMessageId: runtimeEdit.remoteMessageId,
        whatsappInboundRevisionFallback: false,
      }, env).catch(() => message);
    } catch (error) {
      fallbackReason = [404, 405, 409, 410, 501].includes(Number(error?.statusCode || 0))
        ? "remote_edit_unsupported_or_expired"
        : "remote_edit_failed";
      runtimeEdit = {
        supported: false,
        statusCode: Number(error?.statusCode || 0) || null,
        error: clean(error?.message, fallbackReason),
      };
    }
  } else if (!["queued", "pending_delivery"].includes(coalesced.previousState)) {
    fallbackReason = "local_runtime_edit_expired";
  }
  if (fallbackReason) {
    message = await updateThreadMessage(thread.id, message.id, {
      whatsappInboundRevisionState: "stored_without_runtime_resubmit",
      whatsappInboundRevisionFallback: true,
      whatsappInboundRevisionFallbackReason: fallbackReason,
      whatsappInboundRevisionNotice: "Attachment update saved on the original WhatsApp input; Codex input was not submitted again.",
    }, env).catch(() => message);
    await appendEvent({
      type: "whatsapp_inbound_revision_fallback",
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      threadId,
      messageId: message.id,
      chatId,
      accountId,
      reason: fallbackReason,
      remoteEditStatusCode: runtimeEdit?.statusCode || null,
    }, env).catch(() => {});
  }
  const event = {
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    agentId: null,
    threadId,
    messageId: message.id,
    chatId,
    from,
    accountId,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
    coalesced: true,
    attachmentRecovery: coalesced.attachmentRecovery,
    attachmentUpdateMode: fallbackReason ? "stored_without_runtime_resubmit" : remoteRuntime ? "remote_edit" : "local_edit",
    receivedAt: clean(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeState(state, env);
  const terminalFallback = Boolean(fallbackReason);
  await ensureRouterTurn({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    eventId,
    threadId,
    messageId: message.id,
    state: terminalFallback ? "skipped" : "queued",
  }, env).catch(() => null);
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    sourceEventId: eventId,
    threadId,
    messageId: message.id,
    phase: terminalFallback ? "skipped" : "queued",
    reason: fallbackReason || (remoteRuntime ? "coalesced_inbound_remote_edit" : "coalesced_inbound_burst"),
    terminal: terminalFallback || undefined,
  }, env).catch(() => {});
  if (!terminalFallback && !remoteRuntime && thread && input.deferApiAgentAutoRun !== true) scheduleThreadKick(thread, env);
  return {
    duplicate: false,
    coalesced: true,
    attachmentRecovery: coalesced.attachmentRecovery,
    attachmentUpdateMode: event.attachmentUpdateMode,
    ...(runtimeEdit ? { runtimeEdit } : {}),
    ...(fallbackReason ? { fallback: true, fallbackReason } : {}),
    event,
    agentId: null,
    threadId,
    ownerUserId: resourceOwnerUserId(thread, env),
    autoProvisioned: threadRoute.autoProvisioned === true,
    createdThread: threadRoute.createdThread === true,
    userId: threadRoute.user?.id || null,
    message,
  };
}
