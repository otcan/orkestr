import { parseThreadInputCommand } from "../../core/src/thread-commands.js";

const mirrorDisabledActiveStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const mirrorDisabledActiveDeliveryStates = new Set([
  "awaiting_ack",
  "awaiting_runtime_completion",
  "blocked_frozen_runtime",
  "delivering",
  "interrupting",
  "recovering_stale_ack",
  "retrying_delivery",
  "waiting_runtime_ready",
  "waiting_runtime_start",
  "waking",
]);

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
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

function queueNoticePreview(message) {
  const text = pickString(message?.text, message?.promptFile ? "message from prompt file" : "message");
  const parsed = parseThreadInputCommand({ text });
  const previewText = parsed.command === "interrupt" && parsed.text ? parsed.text : text;
  const normalized = previewText.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function blockedFrozenRuntimeWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  if (role !== "user" || deliveryState !== "blocked_frozen_runtime") return null;
  return whatsappQueueNoticeOrigin(message, thread, state);
}

function recoveryActionForMessage(message) {
  const role = String(message?.role || "").trim().toLowerCase();
  if (role !== "user") return null;
  const observedVia = String(message?.observedVia || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const parsed = parseThreadInputCommand({ text: message?.text || "" });
  if (observedVia === "orkestr_stop_command") return { action: "stop", rawCommand: parsed.rawCommand || "stop" };
  if (observedVia === "orkestr_safe_reset_command") return { action: "safe_reset", rawCommand: parsed.rawCommand || "safe_reset" };
  if (observedVia === "orkestr_hard_reset_command") return { action: "hard_reset", rawCommand: parsed.rawCommand || "hard_reset" };
  if (observedVia === "orkestr_reset_command") {
    return { action: parsed.rawCommand === "restart" ? "restart" : "reset", rawCommand: parsed.rawCommand || "reset" };
  }
  if (observedVia === "orkestr_interrupt_command") {
    return {
      action: "interrupt",
      rawCommand: parsed.rawCommand || (message.forceDeliveryAfterInterrupt === true ? "now" : "interrupt"),
      queuedPayload: deliveryState === "interrupting" || message.forceDeliveryAfterInterrupt === true,
    };
  }
  return null;
}

function recoveryActionRequestedWhatsAppDeliveryTarget(message, thread, state) {
  const action = recoveryActionForMessage(message);
  if (!action) return null;
  const target = whatsappQueueNoticeOrigin(message, thread, state);
  return target ? { ...target, ...action } : null;
}

function recoveryExhaustedWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const observedVia = String(message?.observedVia || "").trim().toLowerCase();
  if (role !== "user" || observedVia !== "stale_ack_recovery_exhausted") return null;
  if (messageState !== "failed" && deliveryState !== "failed") return null;
  return whatsappQueueNoticeOrigin(message, thread, state);
}

function mirrorDisabledWhatsAppDeliveryTarget({ message, thread, state, kind = "", mirroringAllowed = true } = {}) {
  if (kind !== "thread" || mirroringAllowed) return null;
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  if (role !== "user") return null;
  if (!mirrorDisabledActiveStates.has(messageState) && !mirrorDisabledActiveDeliveryStates.has(deliveryState)) return null;
  return whatsappQueueNoticeOrigin(message, thread, state);
}

function formatWhatsAppBlockedFrozenRuntimeNotice(message) {
  const preview = queueNoticePreview(message);
  return [
    "Codex pane looks frozen.",
    "",
    "Orkestr paused automatic recovery and did not restart or resend anything.",
    `Your message is blocked until the pane changes or you request a manual recovery: "${preview}".`,
  ].join("\n");
}

function formatWhatsAppRecoveryActionRequested(message, target = {}) {
  const preview = queueNoticePreview(message);
  if (target.action === "stop") {
    return [
      "Stop requested.",
      "",
      "Orkestr interrupted the current Codex turn for this thread.",
    ].join("\n");
  }
  if (target.action === "restart") {
    return [
      "Restart requested.",
      "",
      "Orkestr reset the current Codex runtime and resumed the thread.",
    ].join("\n");
  }
  if (target.action === "reset") {
    return [
      "Reset requested.",
      "",
      "Orkestr reset the current Codex runtime and resumed the thread.",
    ].join("\n");
  }
  if (target.action === "hard_reset") {
    return [
      "Hard reset requested.",
      "",
      "Orkestr created a recovery checkpoint when possible, then restarted the Codex pane.",
    ].join("\n");
  }
  if (target.action === "safe_reset") {
    return [
      "Safe reset requested.",
      "",
      "Orkestr saved recent Orkestr context and started a fresh Codex session for this thread.",
    ].join("\n");
  }
  if (target.queuedPayload) {
    return [
      "Interrupt requested.",
      "",
      `Orkestr interrupted the current Codex turn and queued your message for the next turn: "${preview}".`,
    ].join("\n");
  }
  return [
    "Interrupt requested.",
    "",
    "Orkestr interrupted the current Codex turn.",
  ].join("\n");
}

function formatWhatsAppRecoveryExhausted(message) {
  const preview = queueNoticePreview(message);
  return [
    "Manual recovery needed.",
    "",
    "Orkestr stopped retrying this message to avoid duplicate input.",
    `Open the thread or request /restart, then resend if needed: "${preview}".`,
  ].join("\n");
}

function formatWhatsAppMirrorDisabled() {
  return [
    "Message routed to Orkestr.",
    "",
    "WhatsApp mirroring is disabled for this thread, so Codex replies will only appear in the Orkestr UI.",
  ].join("\n");
}

export function routerUpdateWhatsAppDeliveryTarget({ message, thread, state, kind = "", mirroringAllowed = true } = {}) {
  const blockedFrozenTarget = blockedFrozenRuntimeWhatsAppDeliveryTarget(message, thread, state);
  if (blockedFrozenTarget) {
    return {
      ...blockedFrozenTarget,
      routerUpdateType: "blocked_frozen_runtime",
      text: formatWhatsAppBlockedFrozenRuntimeNotice(message),
      skipIfAssistantOutput: true,
    };
  }
  const recoveryActionTarget = recoveryActionRequestedWhatsAppDeliveryTarget(message, thread, state);
  if (recoveryActionTarget) {
    return {
      ...recoveryActionTarget,
      routerUpdateType: "recovery_action_requested",
      text: formatWhatsAppRecoveryActionRequested(message, recoveryActionTarget),
    };
  }
  const recoveryExhaustedTarget = recoveryExhaustedWhatsAppDeliveryTarget(message, thread, state);
  if (recoveryExhaustedTarget) {
    return {
      ...recoveryExhaustedTarget,
      routerUpdateType: "recovery_exhausted",
      text: formatWhatsAppRecoveryExhausted(message),
    };
  }
  const mirrorDisabledTarget = mirrorDisabledWhatsAppDeliveryTarget({ message, thread, state, kind, mirroringAllowed });
  if (mirrorDisabledTarget) {
    return {
      ...mirrorDisabledTarget,
      routerUpdateType: "mirror_disabled",
      text: formatWhatsAppMirrorDisabled(),
    };
  }
  return null;
}
