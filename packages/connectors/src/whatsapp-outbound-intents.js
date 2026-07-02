import crypto from "node:crypto";
import { whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function clean(value) {
  return String(value || "").trim();
}

function dateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function newerIso(...values) {
  return [...values].sort((left, right) => dateMs(right) - dateMs(left))[0] || "";
}

function statusRank(value) {
  const status = clean(value).toLowerCase();
  if (status === "delivered") return 4;
  if (status === "skipped" || status === "cancelled") return 3;
  if (status === "pending") return 2;
  if (status === "failed") return 1;
  return 0;
}

export function whatsappOutboundIntentRetentionLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_OUTBOUND_INTENT_RETENTION || env.ORKESTR_WHATSAPP_OUTBOUND_DELIVERY_RETENTION || 5000);
  return Number.isFinite(parsed) ? Math.max(500, Math.floor(parsed)) : 5000;
}

export function whatsappOutboundIntentBootstrapWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_OUTBOUND_INTENT_BOOTSTRAP_WINDOW_MS || 15 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 15 * 60 * 1000;
}

export function whatsappLiveOutputRecoveryWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_LIVE_OUTPUT_RECOVERY_WINDOW_MS || 2 * 60 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 2 * 60 * 60 * 1000;
}

export function outboundMirrorMessageSetKey({ kind = "", agentId = "", threadId = "" } = {}) {
  return [clean(kind), clean(agentId), clean(threadId)].join("|");
}

export function outboundMirrorMessageCursor(message = {}, index = 0) {
  const parsed = Number(message?.cursor || 0);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return Math.max(1, Number(index || 0) + 1);
}

export function outboundIntentKey(input = {}) {
  const raw = [
    pickString(input.kind),
    pickString(input.deliveryType),
    pickString(input.routerUpdateType),
    pickString(input.chatId),
    pickString(input.accountId),
    pickString(input.messageId),
    pickString(input.sourceMessageId),
    pickString(input.textKey),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function mergedIntent(existing = {}, next = {}) {
  const existingRank = statusRank(existing.status);
  const nextRank = statusRank(next.status);
  if (nextRank > existingRank) return { ...existing, ...next };
  if (existingRank > nextRank) return { ...next, ...existing };
  const existingUpdated = dateMs(existing.updatedAt || existing.deliveredAt || existing.createdAt);
  const nextUpdated = dateMs(next.updatedAt || next.deliveredAt || next.createdAt);
  return nextUpdated >= existingUpdated ? { ...existing, ...next } : { ...next, ...existing };
}

export function mergeWhatsAppOutboundIntents(existing = [], next = [], env = process.env) {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const intentId = pickString(item?.intentId, outboundIntentKey(item));
    if (!intentId) continue;
    const normalized = { ...item, intentId };
    merged.set(intentId, merged.has(intentId) ? mergedIntent(merged.get(intentId), normalized) : normalized);
  }
  const intents = [...merged.values()].sort((left, right) =>
    dateMs(left.updatedAt || left.deliveredAt || left.createdAt) - dateMs(right.updatedAt || right.deliveredAt || right.createdAt)
  );
  const pending = intents.filter((intent) => clean(intent.status || "pending").toLowerCase() === "pending");
  const finished = intents.filter((intent) => clean(intent.status || "pending").toLowerCase() !== "pending");
  return [
    ...finished.slice(-whatsappOutboundIntentRetentionLimit(env)),
    ...pending,
  ];
}

export function mergeWhatsAppOutboundMirrorCursors(existing = [], next = []) {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const messageSetKey = pickString(item?.messageSetKey, outboundMirrorMessageSetKey(item));
    if (!messageSetKey) continue;
    const cursor = Math.max(0, Number(item?.cursor || 0) || 0);
    const previous = merged.get(messageSetKey);
    const previousCursor = Number(previous?.cursor || 0) || 0;
    if (!previous || cursor > previousCursor) {
      merged.set(messageSetKey, { ...item, messageSetKey, cursor });
    }
  }
  return [...merged.values()].sort((left, right) => clean(left.messageSetKey).localeCompare(clean(right.messageSetKey)));
}

const emptyOutboundMirrorCursors = Object.freeze([]);
const outboundMirrorCursorMapCache = new WeakMap();

export function outboundMirrorCursorMap(cursors = []) {
  const list = Array.isArray(cursors) ? cursors : emptyOutboundMirrorCursors;
  const cached = outboundMirrorCursorMapCache.get(list);
  if (cached) return cached;
  const map = new Map(list
    .map((cursor) => [pickString(cursor.messageSetKey, outboundMirrorMessageSetKey(cursor)), cursor])
    .filter(([key]) => key));
  outboundMirrorCursorMapCache.set(list, map);
  return map;
}

function whatsappMessageOrigin(message = {}, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
}

function recoverableCurrentAssistantOutput(message = {}) {
  const source = clean(message?.source);
  return clean(message?.role).toLowerCase() === "assistant" &&
    clean(message?.state).toLowerCase() === "completed" &&
    (source === "codex-app-server" || source === "api-session");
}

function threadAllowsLiveRecovery(thread = null) {
  const binding = thread?.binding || {};
  return whatsappBindingIsRouteEligible(binding) &&
    binding.mirrorToWhatsApp !== false &&
    binding.mirrorReplies !== false;
}

function boundThreadOrigin({ message = {}, thread = null, kind = "" } = {}) {
  if (kind !== "thread") return false;
  const binding = thread?.binding || {};
  if (clean(binding.connector || "whatsapp").toLowerCase() !== "whatsapp") return false;
  const bindingChatId = pickString(binding.chatId);
  const messageChatId = pickString(message.chatId, bindingChatId);
  return Boolean(bindingChatId && messageChatId === bindingChatId);
}

function liveRecoveryWindowAllowed(message = {}, env = process.env) {
  const windowMs = whatsappLiveOutputRecoveryWindowMs(env);
  if (!windowMs) return false;
  const messageMs = dateMs(message.createdAt || message.timestamp);
  return Boolean(messageMs && Date.now() - messageMs <= windowMs);
}

function historySyncedCodexFinalRecoveryAllowed({ message = {}, parent = null, state = null, thread = null, kind = "" } = {}) {
  if (clean(message?.source).toLowerCase() !== "codex-app-server-import") return false;
  if (clean(message?.observedVia).toLowerCase() !== "codex_app_server_history_sync") return false;
  if (clean(message?.role).toLowerCase() !== "assistant") return false;
  if (clean(message?.state).toLowerCase() !== "completed") return false;
  if (clean(message?.phase || "final_answer").toLowerCase() !== "final_answer") return false;
  return whatsappMessageOrigin(parent, state) ||
    whatsappMessageOrigin(message, state) ||
    boundThreadOrigin({ message, thread, kind });
}

function freshOutOfBandNotification({ message = {}, thread = null, kind = "", env = process.env } = {}) {
  if (clean(message.phase).toLowerCase() !== "notification") return false;
  if (!pickString(message.chatId)) return false;
  if (!boundThreadOrigin({ message, thread, kind })) return false;
  const windowMs = whatsappOutboundIntentBootstrapWindowMs(env);
  if (!windowMs) return false;
  const messageMs = dateMs(message.createdAt || message.timestamp);
  return Boolean(messageMs && Date.now() - messageMs <= windowMs);
}

export function canRecoverLiveWhatsAppOutboundIntent({
  state = null,
  messageSetKey = "",
  messageCursor = 0,
  message = {},
  parent = null,
  thread = null,
  kind = "",
  env = process.env,
} = {}) {
  const cursor = Math.max(0, Number(messageCursor || 0) || 0);
  const existingCursor = outboundMirrorCursorMap(state?.outboundMirrorCursors || []).get(messageSetKey);
  if (!existingCursor || cursor > Number(existingCursor.cursor || 0)) return false;
  if (!recoverableCurrentAssistantOutput(message)) return false;
  if (!threadAllowsLiveRecovery(thread)) return false;
  if (!boundThreadOrigin({ message, thread, kind })) return false;
  if (!whatsappMessageOrigin(parent, state) && !whatsappMessageOrigin(message, state)) return false;
  return liveRecoveryWindowAllowed(message, env);
}

function bootstrapAllowed({ message = {}, parent = null, state = null, thread = null, kind = "", env = process.env } = {}) {
  const windowMs = whatsappOutboundIntentBootstrapWindowMs(env);
  if (!windowMs) return false;
  const messageMs = dateMs(message.createdAt || message.timestamp);
  if (!messageMs || Date.now() - messageMs > windowMs) return false;
  return whatsappMessageOrigin(parent, state) ||
    whatsappMessageOrigin(message, state) ||
    boundThreadOrigin({ message, thread, kind });
}

export function canCreateWhatsAppOutboundIntent({
  state = null,
  messageSetKey = "",
  messageCursor = 0,
  message = {},
  parent = null,
  thread = null,
  kind = "",
  env = process.env,
} = {}) {
  const cursor = Math.max(0, Number(messageCursor || 0) || 0);
  const existingCursor = outboundMirrorCursorMap(state?.outboundMirrorCursors || []).get(messageSetKey);
  if (existingCursor) {
    if (cursor > Number(existingCursor.cursor || 0)) return { ok: true, reason: "new_after_cursor" };
    if (canRecoverLiveWhatsAppOutboundIntent({
      state,
      messageSetKey,
      messageCursor,
      message,
      parent,
      thread,
      kind,
      env,
    })) {
      return { ok: true, reason: "live_bound_recovery" };
    }
    if (freshOutOfBandNotification({ message, thread, kind, env })) {
      return { ok: true, reason: "fresh_notification_after_cursor" };
    }
    if (historySyncedCodexFinalRecoveryAllowed({ message, parent, state, thread, kind })) {
      return { ok: true, reason: "history_synced_codex_final_recovery" };
    }
    return { ok: false, reason: "missing_outbound_intent" };
  }
  return bootstrapAllowed({ message, parent, state, thread, kind, env })
    ? { ok: true, reason: "bootstrap_current_turn" }
    : { ok: false, reason: "missing_outbound_intent" };
}

export function advanceWhatsAppOutboundMirrorCursors(state = {}, messageSets = []) {
  const now = new Date().toISOString();
  const next = [];
  for (const { kind = "", agentId = "", threadId = "", messages = [] } of messageSets) {
    const messageSetKey = outboundMirrorMessageSetKey({ kind, agentId, threadId });
    const cursor = Math.max(0, ...messages.map((message, index) => outboundMirrorMessageCursor(message, index)));
    if (!messageSetKey || !cursor) continue;
    next.push({ messageSetKey, kind, agentId: agentId || null, threadId: threadId || null, cursor, updatedAt: now });
  }
  const merged = mergeWhatsAppOutboundMirrorCursors(state.outboundMirrorCursors || [], next);
  const before = JSON.stringify(state.outboundMirrorCursors || []);
  const after = JSON.stringify(merged);
  state.outboundMirrorCursors = merged;
  return before !== after;
}

export function markWhatsAppOutboundIntent(outboundIntents = [], intentId = "", patch = {}) {
  const now = new Date().toISOString();
  const next = outboundIntents.map((intent) => {
    const currentId = pickString(intent.intentId, outboundIntentKey(intent));
    if (currentId !== intentId) return intent;
    return {
      ...intent,
      ...patch,
      intentId: currentId,
      updatedAt: pickString(patch.updatedAt) || now,
      lastChangedAt: newerIso(patch.deliveredAt, patch.failedAt, patch.updatedAt, now),
    };
  });
  return next;
}
