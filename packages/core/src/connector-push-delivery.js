import { appendAgentMessage, enqueueAgentMessage } from "./messages.js";
import { appendThreadMessage, enqueueThreadInput, getThread } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function sourceItemId(item = {}) {
  return clean(item.sourceItemId || item.id || item.messageId || item.externalId || item.threadId);
}

export function normalizeConnectorPushDeliveryMode(value = "", fallback = "prompt") {
  const mode = lower(value);
  if (["notification", "notify", "chat", "chatui", "outbound"].includes(mode)) return "notification";
  if (["prompt", "thread", "codex"].includes(mode)) return "prompt";
  return fallback;
}

function threadDeliveryDefaults(thread, input = {}) {
  const binding = thread?.binding || {};
  if (lower(binding.connector) !== "whatsapp" && !binding.chatId) return input;
  const chatId = clean(input.chatId || binding.chatId);
  if (!chatId) return input;
  return {
    ...input,
    chatId,
    accountId: clean(
      input.accountId ||
      binding.responderAccountId ||
      binding.outboundAccountId ||
      binding.senderAccountId ||
      binding.inboundAccountId,
    ),
  };
}

function connectorPromptInput(push, item, text) {
  return {
    source: "connector_prompt_push",
    connector: push.connector,
    originSurface: push.connector,
    originTransport: push.deliveryMode === "notification" ? "prompt-push-notification" : "prompt-push",
    externalId: sourceItemId(item),
    text,
    ownerUserId: push.ownerUserId,
  };
}

export async function enqueueConnectorPushDelivery(push, item, text, env = process.env) {
  const input = connectorPromptInput(push, item, text);
  if (push.deliveryMode === "notification") {
    if (push.targetType === "agent") {
      return appendAgentMessage(push.target, { ...input, role: "assistant", state: "completed" }, env);
    }
    const thread = await getThread(push.target, env);
    return appendThreadMessage(thread?.id || push.target, threadDeliveryDefaults(thread, {
      ...input,
      role: "assistant",
      state: "completed",
      phase: "notification",
    }), env);
  }
  if (push.targetType === "agent") return enqueueAgentMessage(push.target, input, env);
  const thread = await getThread(push.target, env);
  return enqueueThreadInput(thread?.id || push.target, threadDeliveryDefaults(thread, {
    ...input,
    visibility: "internal",
  }), env);
}
