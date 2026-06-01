function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export const OrkestrEventTypes = Object.freeze({
  threadInputQueued: "thread.input.queued",
  runtimeTurnStarted: "runtime.turn.started",
  runtimeNeedsApproval: "runtime.needs_approval",
  assistantProgressImported: "assistant.progress.imported",
  assistantFinalImported: "assistant.final.imported",
  threadInputDelivered: "thread.input.delivered",
  threadInputFailed: "thread.input.failed",
  whatsappMirrorRequested: "whatsapp.mirror.requested",
  whatsappMirrorDelivered: "whatsapp.mirror.delivered",
  typingStateChanged: "typing.state.changed",
  timerDue: "timer.due",
  workerCreated: "worker.created",
});

export const legacyTurnLifecyclePrefix = "turn_lifecycle";

export function turnLifecycleEventName(type = "") {
  return `${legacyTurnLifecyclePrefix}_${lower(type) || "event"}`;
}

export function orkestrEventIdempotencyKey(event = {}) {
  return [
    clean(event.type),
    clean(event.threadId),
    clean(event.messageId),
    clean(event.turnId),
    clean(event.connector),
    clean(event.chatId),
    clean(event.deliveryType),
  ].join("|");
}

export function normalizeOrkestrEvent(event = {}) {
  return {
    ...event,
    type: clean(event.type),
    threadId: clean(event.threadId) || null,
    messageId: clean(event.messageId) || null,
    turnId: clean(event.turnId) || null,
    idempotencyKey: clean(event.idempotencyKey) || orkestrEventIdempotencyKey(event),
  };
}
