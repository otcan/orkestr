// Read-only WhatsApp Web store probe.
//
// Runs a fixed, predefined set of side-effect-free page checks (no caller JS)
// to show whether the WhatsApp Web internals the bridge relies on still exist
// in the running WhatsApp Web build. The result carries versions, typeof /
// arity / counts / flags and error metadata only: never message bodies, media
// keys, phone numbers, chat names or ids.

import { createRequire } from "node:module";
import { loadEarlierLocalWhatsAppMessages, publicHistoryLoad } from "./whatsapp-history-loader.js";

const VERSION_PATTERN = /^[0-9][0-9A-Za-z.\-_]{0,40}$/;

let cachedWwebjsVersion;

export function whatsappWebJsVersion() {
  if (cachedWwebjsVersion !== undefined) return cachedWwebjsVersion;
  try {
    const require = createRequire(import.meta.url);
    const version = String(require("whatsapp-web.js/package.json")?.version || "");
    cachedWwebjsVersion = VERSION_PATTERN.test(version) ? version : "";
  } catch {
    cachedWwebjsVersion = "";
  }
  return cachedWwebjsVersion;
}

// Runs inside the WhatsApp Web page; self-contained for puppeteer serialization.
export function inPageStoreProbe(chatId) {
  const kind = (value) => (value === null ? "null" : typeof value);
  const load = (name) => {
    try {
      return { present: typeof window.require === "function" && Boolean(window.require(name)), module: window.require(name) };
    } catch (error) {
      return { present: false, module: null, error: String(error?.name || "Error").slice(0, 60) };
    }
  };
  const fn = (owner, name) => {
    let value;
    try {
      value = owner ? owner[name] : undefined;
    } catch {
      value = undefined;
    }
    return { type: kind(value), arity: typeof value === "function" ? value.length : null };
  };
  const version = () => {
    const candidates = [];
    try {
      candidates.push(window.Debug?.VERSION);
    } catch {}
    try {
      candidates.push(window.require?.("WAWebBuildConstants")?.VERSION_STR);
    } catch {}
    const found = candidates.find((value) => typeof value === "string" && value);
    return found ? String(found).slice(0, 40) : "";
  };
  const collections = load("WAWebCollections");
  const downloads = load("WAWebDownloadManager");
  const chatLoad = load("WAWebChatLoadMessages");
  const widFactory = load("WAWebWidFactory");
  const findChat = load("WAWebFindChatAction");
  const downloadManager = downloads.module?.downloadManager;
  let chat = null;
  let chatLookupError = "";
  try {
    const wid = widFactory.module?.createWid ? widFactory.module.createWid(chatId) : chatId;
    chat = collections.module?.Chat?.get?.(wid) || collections.module?.Chat?.get?.(chatId) || null;
  } catch (error) {
    chatLookupError = String(error?.name || "Error").slice(0, 60);
  }
  let inMemoryCount = null;
  try {
    inMemoryCount = typeof chat?.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray().length : null;
  } catch {
    inMemoryCount = null;
  }
  const loadState = chat?.msgs?.msgLoadState;
  const flag = (value) => (typeof value === "boolean" ? value : null);
  let globalMsgCount = null;
  try {
    globalMsgCount = typeof collections.module?.Msg?.getModelsArray === "function" ? collections.module.Msg.getModelsArray().length : null;
  } catch {
    globalMsgCount = null;
  }
  return {
    waWebVersion: version(),
    internals: {
      windowStore: { type: kind(window.Store), msg: kind(window.Store?.Msg), chat: kind(window.Store?.Chat), conversationMsgsLoadEarlier: fn(window.Store?.ConversationMsgs, "loadEarlierMsgs") },
      wwebjs: { present: Boolean(window.WWebJS), getChat: fn(window.WWebJS, "getChat"), getMessageModel: fn(window.WWebJS, "getMessageModel") },
      collections: {
        present: collections.present,
        error: collections.error || "",
        msg: kind(collections.module?.Msg),
        chat: kind(collections.module?.Chat),
        msgGet: fn(collections.module?.Msg, "get"),
        msgGetMessagesById: fn(collections.module?.Msg, "getMessagesById"),
        globalMsgCount,
      },
      downloadManager: {
        present: downloads.present,
        error: downloads.error || "",
        downloadManager: kind(downloadManager),
        downloadAndMaybeDecrypt: fn(downloadManager, "downloadAndMaybeDecrypt"),
      },
      chatLoadMessages: {
        present: chatLoad.present,
        error: chatLoad.error || "",
        loadEarlierMsgs: fn(chatLoad.module, "loadEarlierMsgs"),
      },
      findChatAction: { present: findChat.present, findOrCreateLatestChat: fn(findChat.module, "findOrCreateLatestChat") },
      widFactory: { present: widFactory.present, createWid: fn(widFactory.module, "createWid") },
    },
    chat: {
      found: Boolean(chat),
      lookupError: chatLookupError,
      inMemoryCount,
      unreadCount: Number(chat?.unreadCount || 0) || 0,
      hasLastActivity: Number(chat?.t || 0) > 0,
      lastActivityAt: Number(chat?.t || 0) > 0 ? new Date(Number(chat.t) * 1000).toISOString() : null,
      msgsLoadEarlierFn: kind(chat?.msgs?.loadEarlierMsgs),
      msgLoadState: loadState && typeof loadState === "object"
        ? {
            noEarlierMsgs: flag(loadState.noEarlierMsgs ?? loadState.__x_noEarlierMsgs),
            isLoadingEarlierMsgs: flag(loadState.isLoadingEarlierMsgs ?? loadState.__x_isLoadingEarlierMsgs),
            contextLoaded: flag(loadState.contextLoaded ?? loadState.__x_contextLoaded),
          }
        : null,
    },
  };
}

const SAFE_TEXT = /[^A-Za-z0-9 _.:()\-]/g;

function safeText(value, max = 60) {
  return String(value ?? "").replace(/\d{6,}/g, "<digits>").replace(SAFE_TEXT, "_").slice(0, max);
}

function sanitizeNode(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeText(value, 60);
  if (Array.isArray(value)) return value.slice(0, 10).map((entry) => sanitizeNode(entry, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) out[safeText(key, 40)] = sanitizeNode(entry, depth + 1);
    return out;
  }
  return null;
}

// Allow-list shape: every string is reduced to a short safe token so no
// content can leak even if WhatsApp Web changes what these fields hold.
export function publicStoreProbe(raw = {}, load = null) {
  const probe = raw && typeof raw === "object" ? raw : {};
  const version = String(probe.waWebVersion || "");
  const chat = probe.chat && typeof probe.chat === "object" ? probe.chat : {};
  return {
    waWebVersion: VERSION_PATTERN.test(version) ? version : "",
    wwebjsVersion: whatsappWebJsVersion(),
    internals: sanitizeNode(probe.internals || {}),
    chat: {
      found: chat.found === true,
      lookupError: safeText(chat.lookupError, 60),
      inMemoryCount: Number.isFinite(chat.inMemoryCount) ? chat.inMemoryCount : null,
      unreadCount: Number(chat.unreadCount || 0) || 0,
      hasLastActivity: chat.hasLastActivity === true,
      lastActivityAt: typeof chat.lastActivityAt === "string" && !Number.isNaN(Date.parse(chat.lastActivityAt)) ? new Date(chat.lastActivityAt).toISOString() : null,
      msgsLoadEarlierFn: safeText(chat.msgsLoadEarlierFn, 20),
      msgLoadState: chat.msgLoadState ? sanitizeNode(chat.msgLoadState) : null,
    },
    loadAttempt: load ? sanitizeLoad(publicHistoryLoad(load)) : null,
  };
}

function sanitizeLoad(load) {
  if (!load) return null;
  return {
    ...load,
    strategy: safeText(load.strategy, 40),
    strategiesTried: load.strategiesTried.map((entry) => safeText(entry, 40)),
    errors: load.errors.map((error) => ({
      strategy: safeText(error.strategy, 40),
      name: safeText(error.name, 60),
      constructorName: safeText(error.constructorName, 60),
      message: safeText(error.message, 160),
      stackHead: error.stackHead.map((line) => String(line).replace(/\d{6,}/g, "<digits>").slice(0, 200)),
    })),
  };
}

export async function runLocalWhatsAppStoreProbe(client, chatId = "", options = {}, env = process.env) {
  const id = String(chatId || "").trim();
  if (!client?.pupPage || typeof client.pupPage.evaluate !== "function") {
    return { ok: false, reason: "pup_page_unavailable", wwebjsVersion: whatsappWebJsVersion() };
  }
  const timeoutMs = Math.max(500, Math.min(30_000, Number(options.timeoutMs || 10_000) || 10_000));
  let raw;
  try {
    let timer;
    raw = await Promise.race([
      client.pupPage.evaluate(inPageStoreProbe, id),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("whatsapp_store_probe_timeout")), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    return {
      ok: false,
      reason: "store_probe_failed",
      error: { name: safeText(error?.name, 60), message: safeText(error?.message, 160) },
      wwebjsVersion: whatsappWebJsVersion(),
    };
  }
  const load = id && options.attemptLoad !== false && raw?.chat?.found
    ? await loadEarlierLocalWhatsAppMessages(client, id, { maxPages: 1, maxMessages: 1000, targetCount: 0, timeoutMs: Math.min(timeoutMs, 10_000) }, env)
    : null;
  return { ok: true, observedAt: new Date().toISOString(), ...publicStoreProbe(raw, load) };
}
