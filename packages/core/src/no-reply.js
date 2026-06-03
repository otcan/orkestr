export const NO_REPLY_TOKEN = "NO_REPLY";
export const NO_REPLY_VISIBILITY = "silent";
export const NO_REPLY_REASON = "no_reply";

function clean(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return clean(value).toLowerCase();
}

export function isNoReplyText(value) {
  return clean(value) === NO_REPLY_TOKEN;
}

export function isNoReplyAssistantMessage(message = {}) {
  if (cleanLower(message?.role) !== "assistant") return false;
  if (isNoReplyText(message?.text)) return true;
  return cleanLower(message?.visibility) === NO_REPLY_VISIBILITY &&
    cleanLower(message?.silentReason) === NO_REPLY_REASON;
}

export function normalizeNoReplyAssistantMessage(message = {}) {
  if (cleanLower(message?.role) !== "assistant") return message;
  if (isNoReplyText(message?.text)) {
    return {
      ...message,
      text: NO_REPLY_TOKEN,
      visibility: NO_REPLY_VISIBILITY,
      silentReason: NO_REPLY_REASON,
    };
  }
  if (cleanLower(message?.silentReason) !== NO_REPLY_REASON) return message;
  const next = { ...message };
  delete next.silentReason;
  if (cleanLower(next.visibility) === NO_REPLY_VISIBILITY) delete next.visibility;
  return next;
}
