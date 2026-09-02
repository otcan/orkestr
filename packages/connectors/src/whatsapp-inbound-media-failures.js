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

function inboundMediaFailureText(messageType = "") {
  const type = clean(messageType).toLowerCase();
  if (type === "ptt" || type === "audio") {
    return "Orkestr received a WhatsApp voice-note event, but the linked WhatsApp session could not download its audio after repeated attempts. It was not sent to the assistant. Please resend the voice note; if it fails again, send it as an audio file.";
  }
  return "Orkestr received a WhatsApp attachment event, but the linked WhatsApp session could not download the file after repeated attempts. It was not sent to the assistant. Please resend the attachment.";
}

export async function recordWhatsAppInboundMediaFailure(input = {}, env = process.env) {
  const accountId = clean(input.accountId);
  const eventId = clean(input.eventId);
  const chatId = clean(input.chatId);
  if (!eventId || !chatId) return { recorded: false, reason: "missing_identity" };

  const thread = inboundMediaFailureThread(await listThreads(env).catch(() => []), { accountId, chatId });
  if (!thread) return { recorded: false, reason: "bound_thread_not_found_or_ambiguous" };

  const idempotencyKey = `whatsapp-inbound-media-failure:${accountId || "default"}:${eventId}`;
  const message = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "whatsapp-inbound-media-warning",
    phase: "notification",
    state: "completed",
    text: inboundMediaFailureText(input.messageType),
    connector: "whatsapp",
    chatId,
    accountId,
    eventId,
    sourceEventId: eventId,
    noticeCause: "whatsapp_inbound_media_download_failed",
    idempotencyKey,
    dedupeAssistantByIdempotencyKey: true,
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
