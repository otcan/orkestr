// Glue between the chat history / exact recovery paths and the bounded
// earlier-message loader. Keeps the large bridge module to a few call sites.

import { loadEarlierLocalWhatsAppMessages, publicHistoryLoad } from "./whatsapp-history-loader.js";
import { evaluateHistoryRead, recordHistoryRead } from "./whatsapp-history-health.js";

// When fewer messages than requested are visible, try loading earlier
// messages and re-read the in-memory collection. Never throws; the original
// messages are kept when loading fails or yields nothing new.
export async function augmentShortHistory({ accountId = "", client = null, chatId = "", requested = 0, messages = [], readCollection = null, env = process.env } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const wanted = Number(requested || 0) || 0;
  if (!wanted || list.length >= wanted || !client?.pupPage) {
    recordHistoryRead(accountId, chatId, evaluateHistoryRead({ requested: wanted, messages: list }));
    return { messages: list, load: null, replaced: false };
  }
  const load = await loadEarlierLocalWhatsAppMessages(client, chatId, { targetCount: wanted }, env).catch(() => null);
  let result = list;
  let replaced = false;
  if (load && Number(load.after || 0) > list.length && typeof readCollection === "function") {
    const cached = await Promise.resolve(readCollection(client, chatId, wanted)).catch(() => null);
    if (cached?.found && Array.isArray(cached.messages) && cached.messages.length > list.length) {
      result = cached.messages;
      replaced = true;
    }
  }
  recordHistoryRead(accountId, chatId, evaluateHistoryRead({ requested: wanted, messages: result, load }));
  return { messages: result, load: publicHistoryLoad(load), replaced };
}

// Search beyond the in-memory messages for an exact event id by loading
// earlier pages. Returns the message (via `readById`) or how far it searched.
export async function findMessageBeyondMemory({ client = null, chatId = "", eventId = "", readById = null, env = process.env } = {}) {
  if (!client?.pupPage || !eventId || typeof readById !== "function") return { message: null, searched: null };
  const load = await loadEarlierLocalWhatsAppMessages(client, chatId, { matchEventId: eventId }, env).catch(() => null);
  const searched = publicHistoryLoad(load);
  if (!load?.matchedId) return { message: null, searched };
  const message = await Promise.resolve(readById(client, load.matchedId, chatId)).catch(() => null);
  return { message: message || null, searched };
}
