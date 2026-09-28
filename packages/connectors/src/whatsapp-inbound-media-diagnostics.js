// Diagnostics for inbound WhatsApp media download failures.
//
// WhatsApp Web throws minified errors whose `message` is often a single
// letter, so the failure record keeps the error name, constructor, status and
// the head of the stack, plus non-secret media metadata. Media keys, direct
// paths, phone numbers and file contents are never recorded.

const STACK_HEAD_LINES = 6;
const MAX_TEXT = 400;

function clip(value = "", max = MAX_TEXT) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function scalar(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return clip(value, 80);
}

export function stackHead(stack = "", lines = STACK_HEAD_LINES) {
  return String(stack || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, lines)
    .join("\n");
}

export function serializeInboundMediaError(error, source = "") {
  if (error === undefined || error === null) return null;
  if (typeof error !== "object") {
    return { source: String(source || ""), name: "", constructorName: typeof error, message: clip(error), status: null, code: null, stackHead: "" };
  }
  const browser = error.browserError && typeof error.browserError === "object" ? error.browserError : null;
  return {
    source: String(source || error.mediaSource || ""),
    name: clip(browser?.name || error.name || "", 80),
    constructorName: clip(browser?.constructorName || error.constructor?.name || "", 80),
    message: clip(browser?.message ?? error.message ?? ""),
    status: scalar(browser?.status ?? error.status ?? error.statusCode),
    code: scalar(browser?.code ?? error.code),
    stackHead: clip(stackHead(browser?.stackHead || error.stack || ""), 1200),
  };
}

function authorDevice(value = "") {
  const match = String(value || "").match(/:(\d+)@/);
  return match ? match[1] : "";
}

function serializedValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value._serialized || value.id?._serialized || "");
}

// Short, non-identifying id prefix. Phone-originated message ids typically
// start with 3A/3B/4A while web/desktop ids start with 3EB0.
export function inboundMediaIdPrefix(message = {}) {
  const local = String(message?.id?.id || "").trim();
  return local ? local.slice(0, 4).toUpperCase() : "";
}

export function describeInboundMediaMessage(message = {}, nowMs = Date.now()) {
  const data = message?._data && typeof message._data === "object" ? message._data : {};
  const timestamp = Number(message?.timestamp || data.t || 0) || 0;
  const author = serializedValue(message?.author || message?.id?.participant || data.author);
  const mediaStage = data.mediaData?.mediaStage || message?.mediaData?.mediaStage || "";
  return {
    type: String(message?.type || data.type || ""),
    mimetype: String(data.mimetype || message?.mimetype || ""),
    hasMediaKey: Boolean(data.mediaKey || message?.mediaKey),
    hasDirectPath: Boolean(data.directPath || message?.directPath),
    mediaStage: String(mediaStage || ""),
    isForwarded: Boolean(message?.isForwarded || data.isForwarded),
    fromMe: Boolean(message?.fromMe ?? message?.id?.fromMe),
    senderDevice: authorDevice(author),
    messageAgeSec: timestamp ? Math.max(0, Math.round(nowMs / 1000 - timestamp)) : null,
    idPrefix: inboundMediaIdPrefix(message),
    size: Number(data.size || message?.size || 0) || 0,
  };
}

const BROWSER_MEDIA_FIELDS = ["type", "mimetype", "hasMediaKey", "hasDirectPath", "mediaStage", "isForwarded", "fromMe", "senderDevice", "messageAgeSec", "mediaKeyAgeSec", "size", "found"];

export function sanitizeBrowserMediaDescription(value = null) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const field of BROWSER_MEDIA_FIELDS) {
    if (value[field] !== undefined) out[field] = scalar(value[field]);
  }
  return out;
}

// Turns a `{ error, media }` payload returned by an in-browser fallback into
// a thrown Error that still carries the browser-side name/constructor/stack.
export function inboundMediaBrowserFailureError(payload = {}, source = "") {
  const browserError = payload?.error && typeof payload.error === "object" ? payload.error : {};
  const error = new Error(String(browserError.message || payload?.reason || "whatsapp_inbound_media_browser_fallback_failed"));
  error.name = String(browserError.name || "Error");
  error.mediaSource = source;
  error.browserError = {
    name: String(browserError.name || ""),
    constructorName: String(browserError.constructorName || ""),
    message: String(browserError.message ?? ""),
    status: browserError.status ?? null,
    code: browserError.code ?? null,
    stackHead: String(browserError.stackHead || ""),
  };
  error.browserMedia = sanitizeBrowserMediaDescription(payload?.media);
  return error;
}

// Accumulates per-attempt source errors for one download cycle.
export function createInboundMediaDiagnostics(message = {}, nowMs = Date.now()) {
  const attempts = [];
  let browserMedia = null;
  return {
    record(attempt, source, error) {
      if (!error) return;
      if (error.browserMedia) browserMedia = error.browserMedia;
      attempts.push({ attempt, ...serializeInboundMediaError(error, source) });
      if (attempts.length > 12) attempts.shift();
    },
    noteBrowserMedia(value) {
      const sanitized = sanitizeBrowserMediaDescription(value);
      if (sanitized) browserMedia = sanitized;
    },
    summary(lastError = null) {
      return {
        error: serializeInboundMediaError(lastError),
        attemptErrors: attempts.slice(),
        media: describeInboundMediaMessage(message, nowMs),
        browserMedia,
      };
    },
  };
}
