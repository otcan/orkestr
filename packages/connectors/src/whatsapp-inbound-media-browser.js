// In-browser fallbacks for inbound WhatsApp media downloads.
//
// The callbacks passed to `pupPage.evaluate` run inside WhatsApp Web, so they
// cannot reference module helpers. Each one catches its own errors and
// returns `{ error, media }` with the error name/constructor/stack head and
// non-secret media metadata, because minified WhatsApp Web errors surface in
// Node with a single-letter message only.

import { inboundMediaBrowserFailureError } from "./whatsapp-inbound-media-diagnostics.js";
import { selfDecryptWhatsAppMedia } from "./whatsapp-media-self-decrypt.js";

function unwrap(result, source, onMedia) {
  if (result && typeof result === "object" && !result.data) {
    if (result.media && typeof onMedia === "function") onMedia(result.media);
    if (result.error) throw inboundMediaBrowserFailureError(result, source);
    return null;
  }
  return result || null;
}

export async function browserBlobInboundMedia({ client = null, eventId = "", withTimeout = (promise) => promise, onMedia = null } = {}) {
  if (!eventId || !client?.pupPage || typeof client.pupPage.evaluate !== "function") return null;
  const result = await withTimeout(client.pupPage.evaluate(async (messageId) => {
    const describeError = (error) => ({
      name: String(error?.name || ""),
      constructorName: String(error?.constructor?.name || ""),
      message: String(error?.message ?? error ?? ""),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.code ?? null,
      stackHead: String(error?.stack || "").split("\n").slice(0, 6).join("\n"),
    });
    const describe = (msg) => {
      if (!msg) return { found: false };
      const author = String(msg.author?._serialized || msg.id?.participant?._serialized || "");
      const device = author.match(/:(\d+)@/);
      const t = Number(msg.t || 0);
      const keyTs = Number(msg.mediaKeyTimestamp || 0);
      return {
        found: true,
        type: String(msg.type || ""),
        mimetype: String(msg.mimetype || ""),
        hasMediaKey: Boolean(msg.mediaKey),
        hasDirectPath: Boolean(msg.directPath),
        mediaStage: String(msg.mediaData?.mediaStage || ""),
        isForwarded: Boolean(msg.isForwarded),
        fromMe: Boolean(msg.id?.fromMe),
        senderDevice: device ? device[1] : "",
        messageAgeSec: t ? Math.max(0, Math.round(Date.now() / 1000 - t)) : null,
        mediaKeyAgeSec: keyTs ? Math.max(0, Math.round(Date.now() / 1000 - keyTs)) : null,
        size: Number(msg.size || 0) || 0,
      };
    };
    let model = null;
    try {
      const collections = window.require?.("WAWebCollections");
      model = collections?.Msg?.get?.(messageId)
        || (typeof collections?.Msg?.getMessagesById === "function"
          ? (await collections.Msg.getMessagesById([messageId]))?.messages?.[0]
          : null);
      if (!model) return null;

      let resolved = null;
      if (typeof window.WWebJS?.resolveMediaBlob === "function") {
        resolved = await window.WWebJS.resolveMediaBlob(messageId);
      } else {
        if (!model.mediaData || model.mediaData.mediaStage === "REUPLOADING") return { media: describe(model) };
        await model.downloadMedia({
          downloadEvenIfExpensive: true,
          rmrReason: 1,
          isUserInitiated: true,
        });
        const stage = String(model.mediaData?.mediaStage || "");
        if (stage.includes("ERROR") || stage === "FETCHING") return { media: describe(model) };
        const cache = window.require?.("WAWebMediaInMemoryBlobCache")?.InMemoryMediaBlobCache;
        const cached = cache?.get?.(model.mediaObject?.filehash);
        const blob = cached || model.mediaObject?.mediaBlob?.forceToBlob?.() || null;
        if (blob) {
          resolved = {
            blob,
            mimetype: model.mimetype,
            filename: model.filename,
            filesize: model.size,
          };
        }
      }
      if (!resolved?.blob || typeof resolved.blob.arrayBuffer !== "function") return { media: describe(model) };
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(await resolved.blob.arrayBuffer()),
        mimetype: String(resolved.mimetype || model.mimetype || ""),
        filename: String(resolved.filename || model.filename || ""),
        filesize: Number(resolved.filesize || model.size || 0) || undefined,
      };
    } catch (error) {
      return { error: describeError(error), media: describe(model) };
    }
  }, eventId));
  return unwrap(result, "browser_blob", onMedia);
}

export async function browserStoreInboundMedia({ client = null, eventId = "", chatId = "", withTimeout = (promise) => promise, onMedia = null, selfDecrypt = selfDecryptWhatsAppMedia } = {}) {
  if (!eventId || !client?.pupPage || typeof client.pupPage.evaluate !== "function") return null;
  const result = await withTimeout(client.pupPage.evaluate(async (messageId, expectedChatId) => {
    const describeError = (error) => ({
      name: String(error?.name || ""),
      constructorName: String(error?.constructor?.name || ""),
      message: String(error?.message ?? error ?? ""),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.code ?? null,
      stackHead: String(error?.stack || "").split("\n").slice(0, 6).join("\n"),
    });
    const describe = (msg) => {
      if (!msg) return { found: false };
      const author = String(msg.author?._serialized || msg.id?.participant?._serialized || "");
      const device = author.match(/:(\d+)@/);
      const t = Number(msg.t || 0);
      const keyTs = Number(msg.mediaKeyTimestamp || 0);
      return {
        found: true,
        type: String(msg.type || ""),
        mimetype: String(msg.mimetype || ""),
        hasMediaKey: Boolean(msg.mediaKey),
        hasDirectPath: Boolean(msg.directPath),
        mediaStage: String(msg.mediaData?.mediaStage || ""),
        isForwarded: Boolean(msg.isForwarded),
        fromMe: Boolean(msg.id?.fromMe),
        senderDevice: device ? device[1] : "",
        messageAgeSec: t ? Math.max(0, Math.round(Date.now() / 1000 - t)) : null,
        mediaKeyAgeSec: keyTs ? Math.max(0, Math.round(Date.now() / 1000 - keyTs)) : null,
        size: Number(msg.size || 0) || 0,
      };
    };
    const idValues = (value) => {
      if (!value) return [];
      if (typeof value === "string" || typeof value === "number") return [String(value)];
      return [value._serialized, value.id, value.id?._serialized, value.id?.id]
        .filter((candidate) => typeof candidate === "string" || typeof candidate === "number")
        .map(String);
    };
    const matchesMessageId = (candidate) => [candidate?.id, candidate?.__x_id]
      .flatMap(idValues)
      .includes(messageId);
    let model = null;
    try {
      const collections = window.require?.("WAWebCollections");
      model = collections?.Msg?.get?.(messageId) || null;
      if (!model && typeof collections?.Msg?.getMessagesById === "function") {
        model = (await collections.Msg.getMessagesById([messageId]))?.messages?.[0] || null;
      }
      if (!model && expectedChatId) {
        const widFactory = window.require?.("WAWebWidFactory");
        const chatWid = widFactory?.createWid ? widFactory.createWid(expectedChatId) : expectedChatId;
        const chat = collections?.Chat?.get?.(chatWid) || collections?.Chat?.get?.(expectedChatId);
        const messages = typeof chat?.msgs?.getModelsArray === "function" ? chat.msgs.getModelsArray() : [];
        model = messages.find(matchesMessageId) || null;
      }
      if (!model?.directPath || !model?.mediaKey) return model ? { media: describe(model) } : null;
      const mockQpl = {
        addAnnotations() { return this; },
        addPoint() { return this; },
      };
      const decrypted = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
        directPath: model.directPath,
        encFilehash: model.encFilehash,
        filehash: model.filehash,
        mediaKey: model.mediaKey,
        mediaKeyTimestamp: model.mediaKeyTimestamp,
        type: model.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
        mimetype: String(model.mimetype || ""),
        filename: String(model.filename || ""),
        filesize: Number(model.size || 0) || undefined,
      };
    } catch (error) {
      const out = { error: describeError(error), media: describe(model) };
      // WhatsApp Web decrypted the file but rejected its sniffed content type.
      // Hand the (secret, in-memory only) keys back so Node can decrypt it.
      if (String(error?.name || "") === "InvalidMediaFileType" && model?.directPath && model?.mediaKey) {
        const key = model.mediaKey;
        const mediaKey = typeof key === "string" ? key : btoa(String.fromCharCode(...new Uint8Array(key)));
        out.selfDecrypt = {
          directPath: String(model.directPath),
          mediaKey,
          type: String(model.type || ""),
          mimetype: String(model.mimetype || ""),
          filename: String(model.filename || ""),
          encFilehash: String(model.encFilehash || ""),
          filehash: String(model.filehash || ""),
        };
      }
      return out;
    }
  }, eventId, chatId));
  if (result?.selfDecrypt && typeof selfDecrypt === "function") {
    const keys = result.selfDecrypt;
    delete result.selfDecrypt;
    if (result.media && typeof onMedia === "function") onMedia(result.media);
    try {
      return await selfDecrypt(keys);
    } catch (decryptError) {
      const error = inboundMediaBrowserFailureError(result, "browser_store");
      error.selfDecryptError = String(decryptError?.code || decryptError?.message || decryptError);
      throw error;
    }
  }
  return unwrap(result, "browser_store", onMedia);
}

// Asks WhatsApp Web to fetch the media the way a user click on an expired
// attachment does (`downloadMedia` with `isUserInitiated: true`). For expired
// or missing media WhatsApp Web answers that by sending a media re-upload
// request to the sender's phone and moving the message to the REUPLOADING
// stage. Everything is feature-detected; absence returns a reason, never throws.
export async function requestInboundMediaReupload({ client = null, eventId = "", withTimeout = (promise) => promise } = {}) {
  if (!eventId) return { requested: false, reason: "missing_event_id" };
  if (!client?.pupPage || typeof client.pupPage.evaluate !== "function") return { requested: false, reason: "browser_page_unavailable" };
  try {
    const result = await withTimeout(client.pupPage.evaluate(async (messageId) => {
      const describeError = (error) => ({
        name: String(error?.name || ""),
        constructorName: String(error?.constructor?.name || ""),
        message: String(error?.message ?? error ?? ""),
        status: error?.status ?? error?.statusCode ?? null,
        stackHead: String(error?.stack || "").split("\n").slice(0, 6).join("\n"),
      });
      const collections = window.require?.("WAWebCollections");
      const model = collections?.Msg?.get?.(messageId)
        || (typeof collections?.Msg?.getMessagesById === "function"
          ? (await collections.Msg.getMessagesById([messageId]))?.messages?.[0]
          : null);
      if (!model) return { requested: false, reason: "message_not_found" };
      const stageBefore = String(model.mediaData?.mediaStage || "");
      if (stageBefore === "RESOLVED") return { requested: false, reason: "already_resolved", stageBefore };
      if (stageBefore === "REUPLOADING") return { requested: false, reason: "reupload_in_progress", stageBefore };
      if (typeof model.downloadMedia !== "function") return { requested: false, reason: "download_media_unavailable", stageBefore };
      try {
        await model.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
      } catch (error) {
        return { requested: true, stageBefore, stageAfter: String(model.mediaData?.mediaStage || ""), error: describeError(error) };
      }
      return { requested: true, stageBefore, stageAfter: String(model.mediaData?.mediaStage || "") };
    }, eventId));
    if (!result || typeof result !== "object") return { requested: false, reason: "no_result" };
    return result;
  } catch (error) {
    return { requested: false, reason: "evaluate_failed", error: String(error?.message || error || "") };
  }
}
