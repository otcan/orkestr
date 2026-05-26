import { listThreadMessages } from "./threads.js";
import { clean } from "./codex-app-server-common.js";

const whatsappSources = new Set(["whatsapp", "whatsapp_inbound", "whatsapp_client"]);

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

export function whatsappOrigin(message = {}) {
  return clean(message.connector).toLowerCase() === "whatsapp" ||
    whatsappSources.has(clean(message.source).toLowerCase());
}

export function latestWhatsAppInput(messages = [], beforeTimestamp = null, thread = null) {
  const beforeMs = beforeTimestamp ? timestampMs(beforeTimestamp) : 0;
  return [...messages].reverse().find((message) =>
    message?.role === "user" &&
    whatsappOrigin(message) &&
    clean(message.chatId || thread?.binding?.chatId) &&
    (!beforeMs || timestampMs(message.timestamp || message.createdAt) <= beforeMs + 1000),
  ) || null;
}

export async function latestWhatsAppParent(thread, timestamp, env = process.env) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  return latestWhatsAppInput(messages, timestamp, thread);
}

function whatsappParentChatId(parent = null, thread = null) {
  return clean(parent?.chatId || thread?.binding?.chatId);
}

function whatsappParentAccountId(parent = null, thread = null) {
  const binding = thread?.binding || {};
  return clean(parent?.accountId || binding.responderAccountId || binding.outboundAccountId);
}

export function whatsappProjectionFields(parent = null, thread = null) {
  return {
    parentMessageId: parent?.id || null,
    connector: parent ? "whatsapp" : "",
    chatId: whatsappParentChatId(parent, thread),
    accountId: whatsappParentAccountId(parent, thread),
  };
}
