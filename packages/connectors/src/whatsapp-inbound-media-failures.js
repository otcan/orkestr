import { appendThreadMessage, listThreads } from "../../core/src/threads.js";
import { appendEvent } from "../../storage/src/store.js";
import { bindingAccountIds, whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";

function clean(value = "") {
  return String(value || "").trim();
}

function inboundMediaFailureThread(threads = [], { accountId = "", chatId = "" } = {}) {
  const account = clean(accountId);
  const chat = clean(chatId);
  if (!chat) return null;
  const candidates = (Array.isArray(threads) ? threads : []).filter((thread) => {
    const binding = thread?.binding || {};
    if (!whatsappBindingIsRouteEligible(binding)) return false;
    if (clean(binding.connector || "whatsapp").toLowerCase() !== "whatsapp") return false;
    if (clean(binding.chatId) !== chat) return false;
    const accounts = bindingAccountIds(binding);
    return !accounts.size || !account || accounts.has(account);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

const MEDIA_TYPE_LABELS = Object.freeze({
  image: "image",
  video: "video",
  gif: "GIF",
  document: "document",
  audio: "audio file",
  ptt: "voice note",
  sticker: "sticker",
});

export function inboundMediaTypeLabel(messageType = "") {
  return MEDIA_TYPE_LABELS[clean(messageType).toLowerCase()] || "attachment";
}

function retryWindowText(retriedForMs = 0) {
  const minutes = Math.round((Number(retriedForMs) || 0) / 60_000);
  if (minutes >= 2) return ` over about ${minutes} minutes`;
  if (minutes === 1) return " over about a minute";
  return "";
}

export function inboundMediaFailureText(messageType = "", { retriedForMs = 0 } = {}) {
  const type = clean(messageType).toLowerCase();
  const windowText = retryWindowText(retriedForMs);
  if (type === "ptt" || type === "audio") {
    return `Orkestr received a WhatsApp voice-note event, but the linked WhatsApp session could not download its audio after repeated attempts${windowText}. It was not sent to the assistant. Please resend the voice note; if it fails again, send it as an audio file.`;
  }
  const label = inboundMediaTypeLabel(type);
  return `Orkestr received a WhatsApp ${label}, but the linked WhatsApp session could not download the file after repeated attempts${windowText}. It was not sent to the assistant. Please resend the ${label}.`;
}

export function inboundMediaRecoveredText(messageType = "") {
  const label = inboundMediaTypeLabel(messageType);
  return `Recovered the WhatsApp ${label} that could not be downloaded at first. It has been sent to the assistant; no need to resend it.`;
}

async function appendInboundMediaNotice(thread, fields = {}, env = process.env) {
  return appendThreadMessage(thread.id, {
    role: "assistant",
    phase: "notification",
    state: "completed",
    connector: "whatsapp",
    dedupeAssistantByIdempotencyKey: true,
    ...fields,
  }, env);
}

export async function recordWhatsAppInboundMediaFailure(input = {}, env = process.env) {
  const accountId = clean(input.accountId);
  const eventId = clean(input.eventId);
  const chatId = clean(input.chatId);
  if (!eventId || !chatId) return { recorded: false, reason: "missing_identity" };

  const thread = inboundMediaFailureThread(await listThreads(env).catch(() => []), { accountId, chatId });
  if (!thread) return { recorded: false, reason: "bound_thread_not_found_or_ambiguous" };

  const idempotencyKey = `whatsapp-inbound-media-failure:${accountId || "default"}:${eventId}`;
  const message = await appendInboundMediaNotice(thread, {
    source: "whatsapp-inbound-media-warning",
    text: inboundMediaFailureText(input.messageType, { retriedForMs: input.retriedForMs }),
    chatId,
    accountId,
    eventId,
    sourceEventId: eventId,
    noticeCause: "whatsapp_inbound_media_download_failed",
    idempotencyKey,
  }, env);
  const recorded = message?.duplicate !== true;
  await appendEvent({
    type: "whatsapp_local_inbound_media_failure_warning_recorded",
    accountId,
    eventId,
    chatId,
    threadId: thread.id,
    messageType: clean(input.messageType).toLowerCase(),
    outcome: recorded ? "recorded" : "deduplicated",
  }, env).catch(() => {});
  return {
    recorded,
    duplicate: message?.duplicate === true,
    reason: recorded ? "recorded" : "deduplicated",
    threadId: thread.id,
    messageId: message?.id || "",
  };
}

export async function recordWhatsAppInboundMediaRecovered(input = {}, env = process.env) {
  const accountId = clean(input.accountId);
  const eventId = clean(input.eventId);
  const chatId = clean(input.chatId);
  if (!eventId || !chatId) return { recorded: false, reason: "missing_identity" };
  const threads = await listThreads(env).catch(() => []);
  const preferred = clean(input.threadId)
    ? threads.find((thread) => thread?.id === clean(input.threadId) && clean(thread?.binding?.chatId) === chatId)
    : null;
  const thread = preferred || inboundMediaFailureThread(threads, { accountId, chatId });
  if (!thread) return { recorded: false, reason: "bound_thread_not_found_or_ambiguous" };
  const message = await appendInboundMediaNotice(thread, {
    source: "whatsapp-inbound-media-recovered",
    text: inboundMediaRecoveredText(input.messageType),
    chatId,
    accountId,
    eventId,
    sourceEventId: eventId,
    noticeCause: "whatsapp_inbound_media_recovered",
    idempotencyKey: `whatsapp-inbound-media-recovered:${accountId || "default"}:${eventId}`,
  }, env);
  const recorded = message?.duplicate !== true;
  await appendEvent({
    type: "whatsapp_local_inbound_media_recovered_notice_recorded",
    accountId,
    eventId,
    chatId,
    threadId: thread.id,
    messageType: clean(input.messageType).toLowerCase(),
    attempt: Number(input.attempt || 0) || 0,
    outcome: recorded ? "recorded" : "deduplicated",
  }, env).catch(() => {});
  return { recorded, duplicate: message?.duplicate === true, threadId: thread.id, messageId: message?.id || "" };
}
