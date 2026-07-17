function clean(value = "") {
  return String(value || "").trim();
}

export function isRoutableWhatsAppConversationId(value = "") {
  const id = clean(value);
  const match = id.match(/^([^@\s]+)@(c\.us|g\.us|lid)$/i);
  if (!match) return false;
  return !/^0+(?::0+)?$/.test(match[1]);
}
