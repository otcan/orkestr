import { createHash, randomUUID } from "node:crypto";
import { incrementCounter, observeHistogram } from "./observability.js";

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function enabled(value, fallback = true) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "on"].includes(text);
}

function selectedThreadIds(env = process.env) {
  return new Set(clean(env.ORKESTR_WEBUI_WHATSAPP_REPLY_DELIVERY_THREAD_IDS)
    .split(/[\s,]+/g)
    .map(clean)
    .filter(Boolean));
}

export function uiReplyDeliveryFeatureGate(thread = {}, env = process.env) {
  if (!enabled(env.ORKESTR_WEBUI_WHATSAPP_REPLY_DELIVERY, true)) {
    return { enabled: false, reason: "feature_disabled" };
  }
  const selected = selectedThreadIds(env);
  if (selected.size && !selected.has(clean(thread.id))) {
    return { enabled: false, reason: "thread_not_selected" };
  }
  return { enabled: true, reason: "" };
}

function recordReplyDeliveryState(state, requestedAt = "") {
  incrementCounter("orkestr_ui_whatsapp_reply_delivery_total", { state });
  const started = Date.parse(clean(requestedAt));
  if (Number.isFinite(started) && state !== "accepted") {
    observeHistogram(
      "orkestr_ui_whatsapp_reply_delivery_terminal_latency_seconds",
      Math.max(0, Date.now() - started) / 1000,
      { state },
      [1, 5, 15, 30, 60, 120, 300, 900],
    );
  }
}

export function recordUiReplyDeliveryMetric(state, requestedAt = "") {
  const allowed = new Set([
    "outbox_created",
    "duplicate_suppressed",
  ]);
  const normalized = clean(state).toLowerCase();
  if (allowed.has(normalized)) recordReplyDeliveryState(normalized, requestedAt);
}

function bindingAccountId(binding = {}) {
  return clean(
    binding.replyAccountId ||
    binding.bridgeAccountId ||
    binding.responderConnectorAccountId ||
    binding.responderAccountId ||
    binding.outboundAccountId,
  );
}

function bindingIdentity(binding = {}) {
  return clean(binding.id || binding.bindingId) || "thread-binding";
}

export function whatsappReplyDeliveryBindingRevision(binding = {}) {
  const material = JSON.stringify({
    id: bindingIdentity(binding),
    connector: clean(binding.connector || "whatsapp").toLowerCase(),
    chatId: clean(binding.chatId),
    accountId: bindingAccountId(binding),
    enabled: binding.enabled !== false,
    routeEligible: binding.routeEligible !== false,
    mirrorToWhatsApp: binding.mirrorToWhatsApp !== false,
    mirrorReplies: binding.mirrorReplies !== false,
    deprecated: binding.deprecated === true,
    retired: binding.retired === true,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export function whatsappReplyDeliveryBindingEligible(binding = {}) {
  return clean(binding.connector || "whatsapp").toLowerCase() === "whatsapp" &&
    Boolean(clean(binding.chatId)) &&
    Boolean(bindingAccountId(binding)) &&
    binding.enabled !== false &&
    binding.routeEligible !== false &&
    binding.mirrorToWhatsApp !== false &&
    binding.mirrorReplies !== false &&
    binding.deprecated !== true &&
    binding.retired !== true;
}

export function createUiReplyDeliveryIntent(thread = {}, options = {}) {
  if (clean(options.mode).toLowerCase() !== "bound_whatsapp") return null;
  const binding = thread.binding || {};
  const requestedAt = clean(options.requestedAt) || nowIso();
  const featureGate = uiReplyDeliveryFeatureGate(thread, options.env || process.env);
  const eligible = featureGate.enabled && whatsappReplyDeliveryBindingEligible(binding);
  const target = {
    threadId: clean(thread.id),
    ownerUserId: clean(thread.ownerUserId),
    bindingId: bindingIdentity(binding),
    bindingRevision: whatsappReplyDeliveryBindingRevision(binding),
    chatId: clean(binding.chatId),
    accountId: bindingAccountId(binding),
  };
  const intent = {
    version: 1,
    id: clean(options.id) || randomUUID(),
    serverAuthored: true,
    channel: "whatsapp",
    mode: "bound_whatsapp",
    status: eligible ? "pending_reply" : "policy_skipped",
    reason: eligible ? "" : featureGate.reason || "binding_not_eligible",
    requestedAt,
    requestedByUserId: clean(options.requestedByUserId),
    target,
  };
  recordReplyDeliveryState(eligible ? "accepted" : "policy_skipped", requestedAt);
  return intent;
}

function serverUiReplyDeliveryIntent(message = {}) {
  const intent = message.replyDeliveryIntent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  if (intent.serverAuthored !== true || intent.channel !== "whatsapp" || intent.mode !== "bound_whatsapp") return null;
  if (clean(message.source).toLowerCase() !== "ui" || clean(message.originSurface).toLowerCase() !== "webui") return null;
  return intent;
}

export function trustedUiReplyDeliveryIntent(message = {}) {
  const intent = serverUiReplyDeliveryIntent(message);
  if (!intent) return null;
  const target = intent.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (!clean(target.threadId) || !clean(target.chatId) || !clean(target.bindingRevision)) return null;
  return intent;
}

export function uiReplyDeliveryProjectionParent(message = {}) {
  const intent = trustedUiReplyDeliveryIntent(message);
  if (!intent || !["pending_reply", "queued"].includes(clean(intent.status).toLowerCase())) return null;
  return {
    ...message,
    connector: "whatsapp",
    chatId: clean(intent.target.chatId),
    accountId: clean(intent.target.accountId),
  };
}

export function replyDeliveryBindingFence(parent = {}, thread = {}) {
  const intent = trustedUiReplyDeliveryIntent(parent);
  if (!intent) return { applies: false, allowed: true, reason: "" };
  if (!["pending_reply", "queued"].includes(clean(intent.status).toLowerCase())) {
    return { applies: true, allowed: false, reason: clean(intent.reason) || `intent_${clean(intent.status) || "not_pending"}`, intent };
  }
  const binding = thread.binding || {};
  if (!whatsappReplyDeliveryBindingEligible(binding)) {
    return { applies: true, allowed: false, reason: "binding_not_eligible", intent };
  }
  const target = intent.target || {};
  if (clean(target.threadId) !== clean(thread.id)) {
    return { applies: true, allowed: false, reason: "thread_changed", intent };
  }
  if (clean(target.ownerUserId) !== clean(thread.ownerUserId)) {
    return { applies: true, allowed: false, reason: "owner_changed", intent };
  }
  if (clean(target.bindingId) !== bindingIdentity(binding) || clean(target.bindingRevision) !== whatsappReplyDeliveryBindingRevision(binding)) {
    return { applies: true, allowed: false, reason: "binding_changed", intent };
  }
  return {
    applies: true,
    allowed: true,
    reason: "",
    intent,
    chatId: clean(target.chatId),
    accountId: clean(target.accountId),
  };
}

export function replyDeliveryIntentStatusPatch(message = {}, status = "", options = {}) {
  const intent = trustedUiReplyDeliveryIntent(message);
  if (!intent) return null;
  const normalized = clean(status).toLowerCase();
  if (!normalized) return null;
  if (clean(intent.status).toLowerCase() === normalized && clean(intent.reason) === clean(options.reason)) return null;
  const timestamp = clean(options.timestamp) || nowIso();
  recordReplyDeliveryState(normalized, intent.requestedAt);
  return {
    replyDeliveryIntent: {
      ...intent,
      status: normalized,
      reason: clean(options.reason),
      updatedAt: timestamp,
      ...(normalized === "delivered" ? { deliveredAt: timestamp } : {}),
      ...(["policy_skipped", "retry_exhausted", "delivery_unknown"].includes(normalized) ? { terminalAt: timestamp } : {}),
      ...(clean(options.outboxId) ? { outboxId: clean(options.outboxId) } : {}),
      ...(clean(options.connectorMessageId) ? { connectorMessageId: clean(options.connectorMessageId) } : {}),
    },
  };
}

export function publicReplyDeliveryIntentMessage(message = {}) {
  const intent = serverUiReplyDeliveryIntent(message);
  if (!intent) return message;
  return {
    ...message,
    replyDeliveryIntent: {
      version: intent.version,
      id: intent.id,
      channel: intent.channel,
      mode: intent.mode,
      status: intent.status,
      reason: intent.reason,
      requestedAt: intent.requestedAt,
      updatedAt: intent.updatedAt,
      deliveredAt: intent.deliveredAt,
      terminalAt: intent.terminalAt,
    },
  };
}
