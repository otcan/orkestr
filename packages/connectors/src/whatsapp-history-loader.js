// Bounded, feature-detected loading of earlier WhatsApp Web messages.
//
// whatsapp-web.js `Chat.fetchMessages()` only loads earlier messages through
// `require('WAWebChatLoadMessages').loadEarlierMsgs({ chat })`. When a new
// WhatsApp Web build changes that internal, the call either throws a minified
// error or silently returns nothing, and history reads only see what is
// already in memory. This module retries with the known loader signatures,
// stops on no progress, and returns content-free diagnostics (counts, flags,
// error metadata) so the caller can re-read the in-memory collection.

export const HISTORY_LOAD_DEFAULTS = Object.freeze({
  maxPages: 3,
  maxMessages: 200,
  timeoutMs: 15_000,
});

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function historyLoadOptions(options = {}, env = process.env) {
  return {
    maxPages: boundedInt(options.maxPages ?? env.ORKESTR_WHATSAPP_HISTORY_LOAD_MAX_PAGES, HISTORY_LOAD_DEFAULTS.maxPages, 0, 10),
    maxMessages: boundedInt(options.maxMessages ?? env.ORKESTR_WHATSAPP_HISTORY_LOAD_MAX_MESSAGES, HISTORY_LOAD_DEFAULTS.maxMessages, 1, 1000),
    timeoutMs: boundedInt(options.timeoutMs ?? env.ORKESTR_WHATSAPP_HISTORY_LOAD_TIMEOUT_MS, HISTORY_LOAD_DEFAULTS.timeoutMs, 100, 120_000),
    targetCount: boundedInt(options.targetCount, 0, 0, 1000),
    matchEventId: String(options.matchEventId || "").trim(),
  };
}

// Runs inside the WhatsApp Web page. Must stay self-contained: puppeteer
// serializes the function source. Only counts, booleans, timestamps and error
// metadata leave the page, plus the matched serialized id for exact lookups.
export function inPageLoadEarlierMessages(chatId, options) {
  const started = Date.now();
  const deadline = started + Number(options.timeoutMs || 15000);
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\d{6,}/g, "<digits>");
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };
  const errorMeta = (strategy, error) => ({
    strategy,
    name: clip(error?.name || typeof error, 60),
    constructorName: clip(error?.constructor?.name || "", 60),
    message: clip(error?.message ?? error, 160),
    stackHead: String(error?.stack || "").split("\n").slice(0, 4).map((line) => clip(line.trim(), 200)).filter(Boolean),
  });
  const load = (name) => {
    try {
      return typeof window.require === "function" ? window.require(name) : null;
    } catch {
      return null;
    }
  };
  const result = {
    ok: false,
    chatFound: false,
    before: 0,
    after: 0,
    pages: 0,
    strategy: "",
    strategiesTried: [],
    reachedStart: null,
    timedOut: false,
    matched: false,
    matchedId: "",
    oldestTimestamp: 0,
    unreadCount: 0,
    lastActivityTimestamp: 0,
    errors: [],
    durationMs: 0,
  };
  const collections = load("WAWebCollections");
  const widFactory = load("WAWebWidFactory");
  let chat = null;
  try {
    const wid = widFactory?.createWid ? widFactory.createWid(chatId) : chatId;
    chat = collections?.Chat?.get?.(wid) || collections?.Chat?.get?.(chatId) || null;
  } catch (error) {
    result.errors.push(errorMeta("chat_lookup", error));
  }
  const models = () => {
    try {
      return typeof chat?.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray() : [];
    } catch {
      return [];
    }
  };
  const target = String(options.matchEventId || "");
  const idMatches = (message) => {
    const key = message?.id || {};
    const serialized = String(key._serialized || (typeof key === "string" ? key : "") || "");
    const local = String(key.id || "");
    if (!target) return "";
    if (serialized === target || local === target) return serialized || target;
    if (serialized && (serialized.endsWith(`_${target}`) || serialized.includes(`_${target}_`))) return serialized;
    const targetTail = target.split("_").filter(Boolean);
    if (local && targetTail.includes(local) && targetTail.length > 1) return serialized || target;
    return "";
  };
  const findMatch = () => {
    for (const message of models()) {
      const found = idMatches(message);
      if (found) return found;
    }
    return "";
  };
  const oldest = () => {
    let min = 0;
    for (const message of models()) {
      const t = Number(message?.t || 0);
      if (t > 0 && (!min || t < min)) min = t;
    }
    return min;
  };
  const loadState = () => {
    const state = chat?.msgs?.msgLoadState;
    if (!state || typeof state !== "object") return null;
    const flag = state.noEarlierMsgs ?? state.__x_noEarlierMsgs;
    return typeof flag === "boolean" ? flag : null;
  };
  return (async () => {
    if (!chat) {
      result.durationMs = Date.now() - started;
      return result;
    }
    result.chatFound = true;
    result.unreadCount = Number(chat.unreadCount || 0) || 0;
    result.lastActivityTimestamp = Number(chat.t || 0) || 0;
    result.before = models().length;
    result.matchedId = findMatch();
    const loader = load("WAWebChatLoadMessages");
    const strategies = [];
    if (typeof loader?.loadEarlierMsgs === "function") {
      strategies.push(["chat_load_messages_object", () => loader.loadEarlierMsgs({ chat })]);
      strategies.push(["chat_load_messages_positional", () => loader.loadEarlierMsgs(chat)]);
    }
    const legacy = window.Store?.ConversationMsgs;
    if (typeof legacy?.loadEarlierMsgs === "function") {
      strategies.push(["store_conversation_msgs", () => legacy.loadEarlierMsgs(chat)]);
    }
    if (typeof chat.msgs?.loadEarlierMsgs === "function") {
      strategies.push(["chat_msgs_collection", () => chat.msgs.loadEarlierMsgs()]);
    }
    const maxPages = Number(options.maxPages || 0);
    const maxMessages = Number(options.maxMessages || 200);
    const targetCount = Number(options.targetCount || 0);
    const withDeadline = (promise) => {
      let timer;
      return Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("__deadline__"), Math.max(1, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
    };
    let active = 0;
    while (result.pages < maxPages && strategies.length) {
      if (result.matchedId) break;
      const count = models().length;
      if (targetCount > 0 && count >= targetCount) break;
      if (count >= maxMessages) break;
      if (loadState() === true) break;
      if (Date.now() >= deadline) {
        result.timedOut = true;
        break;
      }
      let progressed = false;
      for (let index = active; index < strategies.length; index += 1) {
        const [name, run] = strategies[index];
        if (!result.strategiesTried.includes(name)) result.strategiesTried.push(name);
        try {
          const outcome = await withDeadline(run());
          if (outcome === "__deadline__") {
            result.timedOut = true;
            break;
          }
        } catch (error) {
          if (result.errors.length < 6) result.errors.push(errorMeta(name, error));
          continue;
        }
        if (models().length > count) {
          active = index;
          result.strategy = name;
          progressed = true;
          break;
        }
      }
      result.pages += 1;
      result.matchedId = findMatch();
      if (!progressed || result.timedOut) break;
    }
    result.after = models().length;
    result.matched = Boolean(result.matchedId);
    result.reachedStart = loadState();
    result.oldestTimestamp = oldest();
    result.ok = result.errors.length === 0 || result.after > result.before;
    result.durationMs = Date.now() - started;
    return result;
  })();
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function loadEarlierLocalWhatsAppMessages(client, chatId = "", options = {}, env = process.env) {
  const id = String(chatId || "").trim();
  if (!id || !client?.pupPage || typeof client.pupPage.evaluate !== "function") return null;
  const resolved = historyLoadOptions(options, env);
  if (resolved.maxPages <= 0 && !resolved.matchEventId) return null;
  try {
    return await withTimeout(
      client.pupPage.evaluate(inPageLoadEarlierMessages, id, resolved),
      resolved.timeoutMs + 5_000,
      "whatsapp_history_load",
    );
  } catch (error) {
    return {
      ok: false,
      chatFound: null,
      before: 0,
      after: 0,
      pages: 0,
      strategy: "",
      strategiesTried: [],
      reachedStart: null,
      timedOut: /_timeout$/.test(String(error?.message || "")),
      matched: false,
      matchedId: "",
      errors: [{ strategy: "evaluate", name: String(error?.name || "Error").slice(0, 60), message: String(error?.message || error).replace(/\d{6,}/g, "<digits>").slice(0, 160), stackHead: [] }],
    };
  }
}

// Content-free summary of a load attempt, safe for events, API payloads and skip details.
export function publicHistoryLoad(load = null) {
  if (!load || typeof load !== "object") return null;
  return {
    ok: load.ok === true,
    chatFound: typeof load.chatFound === "boolean" ? load.chatFound : null,
    before: Number(load.before || 0) || 0,
    after: Number(load.after || 0) || 0,
    pages: Number(load.pages || 0) || 0,
    strategy: String(load.strategy || ""),
    strategiesTried: Array.isArray(load.strategiesTried) ? load.strategiesTried.map(String).slice(0, 6) : [],
    reachedStart: typeof load.reachedStart === "boolean" ? load.reachedStart : null,
    timedOut: load.timedOut === true,
    matched: load.matched === true,
    oldestLoadedAt: Number(load.oldestTimestamp) > 0 ? new Date(Number(load.oldestTimestamp) * 1000).toISOString() : null,
    durationMs: Number(load.durationMs || 0) || 0,
    errors: (Array.isArray(load.errors) ? load.errors : []).slice(0, 6).map((error) => ({
      strategy: String(error?.strategy || ""),
      name: String(error?.name || ""),
      constructorName: String(error?.constructorName || ""),
      message: String(error?.message || ""),
      stackHead: Array.isArray(error?.stackHead) ? error.stackHead.map(String).slice(0, 4) : [],
    })),
  };
}
