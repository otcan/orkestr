function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

export function timeoutMs(value, fallback = 5_000, max = 5_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function boundedResult(promise, ms = 5_000, fallback = {}) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function deliveredAssistantMessage(message = {}) {
  if (message.role !== "assistant") return false;
  if (lower(message.deliveryState) === "failed") return false;
  return ["completed", "delivered", ""].includes(lower(message.state)) ||
    ["completed", "delivered", ""].includes(lower(message.deliveryState));
}

function whatsappMessage(message = {}) {
  return lower(message.connector) === "whatsapp" ||
    ["whatsapp", "whatsapp_inbound", "whatsapp_client"].includes(lower(message.source)) ||
    lower(message.originSurface) === "whatsapp";
}

export function buildTraceIndex(traces = []) {
  const byTraceId = new Map();
  const byMessageId = new Map();
  for (const trace of Array.isArray(traces) ? traces : []) {
    const routerTraceId = clean(trace.routerTraceId);
    const messageId = clean(trace.messageId);
    if (routerTraceId && !byTraceId.has(routerTraceId)) byTraceId.set(routerTraceId, trace);
    if (messageId && !byMessageId.has(messageId)) byMessageId.set(messageId, trace);
  }
  return {
    byTraceId,
    byMessageId,
    forMessage(message = {}) {
      const routerTraceId = clean(message.routerTraceId);
      if (routerTraceId && byTraceId.has(routerTraceId)) return byTraceId.get(routerTraceId);
      return byMessageId.get(clean(message.id)) || null;
    },
  };
}

function chatKey(message = {}) {
  return clean(message.chatId);
}

function assistantForUser({ byChat = new Map(), blank = null, any = null } = {}, userMessage = {}) {
  const key = chatKey(userMessage);
  if (!key) return any || null;
  return byChat.get(key) || blank || null;
}

function newerWhatsAppUserFromState({ byChat = new Map(), blank = null, any = null } = {}, userMessage = {}) {
  const key = chatKey(userMessage);
  if (!key) return any || null;
  return byChat.get(key) || blank || null;
}

function setLookup(objectMap, idMap, message = {}, value = null) {
  objectMap.set(message, value);
  const id = clean(message.id);
  if (id && !idMap.has(id)) idMap.set(id, value);
}

function getLookup(objectMap, idMap, message = {}) {
  if (objectMap.has(message)) return objectMap.get(message) || null;
  const id = clean(message.id);
  return id ? idMap.get(id) || null : null;
}

export function buildMessageIndex(messages = [], whatsappMessageFn = whatsappMessage) {
  const list = Array.isArray(messages) ? messages : [];
  const newerAssistantByMessage = new WeakMap();
  const olderAssistantByMessage = new WeakMap();
  const newerWhatsAppUserByMessage = new WeakMap();
  const newerAssistantById = new Map();
  const olderAssistantById = new Map();
  const newerWhatsAppUserById = new Map();
  const laterAssistant = { byChat: new Map(), blank: null, any: null };
  const laterUser = { byChat: new Map(), blank: null, any: null };
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    setLookup(newerAssistantByMessage, newerAssistantById, message, assistantForUser(laterAssistant, message));
    setLookup(newerWhatsAppUserByMessage, newerWhatsAppUserById, message, newerWhatsAppUserFromState(laterUser, message));
    if (deliveredAssistantMessage(message)) {
      laterAssistant.any = message;
      const key = chatKey(message);
      if (key) laterAssistant.byChat.set(key, message);
      else laterAssistant.blank = message;
    }
    if (message?.role === "user" && (typeof whatsappMessageFn !== "function" || whatsappMessageFn(message))) {
      laterUser.any = message;
      const key = chatKey(message);
      if (key) laterUser.byChat.set(key, message);
      else laterUser.blank = message;
    }
  }

  const priorAssistant = { byChat: new Map(), blank: null, any: null };
  for (const message of list) {
    setLookup(olderAssistantByMessage, olderAssistantById, message, assistantForUser(priorAssistant, message));
    if (deliveredAssistantMessage(message)) {
      priorAssistant.any = message;
      const key = chatKey(message);
      if (key) priorAssistant.byChat.set(key, message);
      else priorAssistant.blank = message;
    }
  }

  return {
    newerAssistant(message = {}) {
      return getLookup(newerAssistantByMessage, newerAssistantById, message);
    },
    olderAssistant(message = {}) {
      return getLookup(olderAssistantByMessage, olderAssistantById, message);
    },
    newerWhatsAppUser(message = {}) {
      return getLookup(newerWhatsAppUserByMessage, newerWhatsAppUserById, message);
    },
  };
}

export function scopedMessageIdsForTraces(traces = []) {
  return new Set((Array.isArray(traces) ? traces : []).flatMap((trace) => [clean(trace.messageId)]).filter(Boolean));
}
