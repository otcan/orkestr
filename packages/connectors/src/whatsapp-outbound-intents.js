import crypto from "node:crypto";

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
  if (status === "pending") return 3;
  if (status === "failed") return 2;
  if (status === "skipped") return 1;
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
    if (!previous || cursor > previousCursor || (cursor === previousCursor && dateMs(item.updatedAt) > dateMs(previous.updatedAt))) {
      merged.set(messageSetKey, { ...item, messageSetKey, cursor });
    }
  }
  return [...merged.values()].sort((left, right) => clean(left.messageSetKey).localeCompare(clean(right.messageSetKey)));
}

export function outboundMirrorCursorMap(cursors = []) {
  return new Map((cursors || [])
    .map((cursor) => [pickString(cursor.messageSetKey, outboundMirrorMessageSetKey(cursor)), cursor])
    .filter(([key]) => key));
}

function whatsappMessageOrigin(message = {}, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
}

function boundThreadOrigin({ message = {}, thread = null, kind = "" } = {}) {
  if (kind !== "thread") return false;
  const binding = thread?.binding || {};
  if (clean(binding.connector || "whatsapp").toLowerCase() !== "whatsapp") return false;
  const bindingChatId = pickString(binding.chatId);
  const messageChatId = pickString(message.chatId, bindingChatId);
  return Boolean(bindingChatId && messageChatId === bindingChatId);
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
    return cursor > Number(existingCursor.cursor || 0)
      ? { ok: true, reason: "new_after_cursor" }
      : { ok: false, reason: "missing_outbound_intent" };
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
