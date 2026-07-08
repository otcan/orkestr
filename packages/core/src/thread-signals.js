import { appendEvent } from "../../storage/src/store.js";
import { appendThreadMessage } from "./threads.js";

export const threadSignalPhase = "signal";
export const threadSignalDeliveryModes = new Set(["record_only", "notify_passively"]);

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function modeKey(value = "") {
  return lower(value).replace(/[-\s]+/g, "_");
}

export function normalizeThreadSignalDeliveryMode(value = "", fallback = "notify_passively") {
  const mode = modeKey(value);
  if (["record", "record_only", "history", "history_only", "silent", "store", "store_only"].includes(mode)) return "record_only";
  if (["notify", "notify_passively", "passive_notify", "passive_notification", "chat", "chat_history", "visible"].includes(mode)) return "notify_passively";
  return threadSignalDeliveryModes.has(fallback) ? fallback : "notify_passively";
}

export function isThreadSignalMessage(message = {}) {
  return lower(message.phase) === threadSignalPhase;
}

export function threadSignalMirrorsToConnector(message = {}) {
  if (!isThreadSignalMessage(message)) return false;
  return normalizeThreadSignalDeliveryMode(message.signalMode, "record_only") === "notify_passively";
}

export async function appendThreadSignal(threadId, input = {}, env = process.env) {
  const signalMode = normalizeThreadSignalDeliveryMode(input.signalMode || input.signalDeliveryMode || input.deliveryMode);
  const connector = clean(input.connector);
  const signalKind = clean(input.signalKind || input.kind || input.originSurface || connector || "generic");
  const message = await appendThreadMessage(threadId, {
    ...input,
    role: "assistant",
    state: "completed",
    phase: threadSignalPhase,
    source: clean(input.source) || "connector_signal",
    connector,
    originSurface: clean(input.originSurface || signalKind),
    originTransport: clean(input.originTransport) || (signalMode === "notify_passively" ? "passive-signal-notify" : "passive-signal"),
    visibility: clean(input.visibility) || "visible",
    codexDeliveryMode: "passive",
    signalKind,
    signalMode,
  }, env);
  await appendEvent({
    type: "thread_signal_appended",
    threadId,
    messageId: message.id,
    source: message.source || "",
    connector: message.connector || "",
    signalKind: message.signalKind || "",
    signalMode: message.signalMode || "",
  }, env).catch(() => {});
  return message;
}
