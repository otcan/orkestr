const DEFAULT_REPLY_PREFIX = "orkestr:";

function cleanText(value) {
  return String(value || "").trim();
}

export function defaultWhatsAppReplyPrefix(env = process.env) {
  return cleanText(env.ORKESTR_WHATSAPP_REPLY_PREFIX) || DEFAULT_REPLY_PREFIX;
}

export function configuredWhatsAppChatNamePrefix(env = process.env) {
  return cleanText(env.ORKESTR_WHATSAPP_CHAT_NAME_PREFIX).replace(/-+$/g, "");
}

export function applyWhatsAppChatNamePrefix(name, env = process.env) {
  const cleanName = cleanText(name);
  const prefix = configuredWhatsAppChatNamePrefix(env);
  if (!cleanName || !prefix) return cleanName;
  const lowerName = cleanName.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerName === lowerPrefix || lowerName.startsWith(`${lowerPrefix}-`)) return cleanName;
  return `${prefix}-${cleanName}`;
}

export function stripWhatsAppChatNamePrefix(name, env = process.env) {
  const cleanName = cleanText(name);
  const prefix = configuredWhatsAppChatNamePrefix(env);
  if (!cleanName || !prefix) return cleanName;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleanName.replace(new RegExp(`^${escaped}[-_\\s]*`, "i"), "").trim();
}
