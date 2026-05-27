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

export function threadWhatsAppBindingParent(thread = null) {
  const binding = thread?.binding || {};
  const connector = clean(binding.connector || "whatsapp").toLowerCase();
  const chatId = clean(binding.chatId);
  if (connector !== "whatsapp" || !chatId) return null;
  if (binding.enabled === false || binding.mirrorToWhatsApp === false || binding.mirrorReplies === false) return null;
  return {
    id: null,
    connector: "whatsapp",
    source: "whatsapp",
    chatId,
    accountId: clean(binding.responderAccountId || binding.outboundAccountId),
  };
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

export function codexAppServerMessageFields(codexThreadId = "", input = {}) {
  const turnId = clean(input.turnId || input.codexTurnId);
  const itemId = clean(input.itemId || input.codexItemId);
  const requestId = clean(input.requestId || input.codexRequestId);
  return {
    originSurface: "codex",
    originTransport: "codex-app-server",
    executorKind: "codex",
    executorTransport: "app-server",
    executorThreadId: clean(codexThreadId),
    codexThreadId: clean(codexThreadId),
    ...(turnId ? { executorTurnId: turnId, codexTurnId: turnId } : {}),
    ...(itemId ? { executorItemId: itemId, codexItemId: itemId } : {}),
    ...(requestId ? { executorRequestId: requestId, codexRequestId: requestId } : {}),
  };
}
