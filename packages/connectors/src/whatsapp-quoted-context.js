// Quoted/reply context of an inbound whatsapp-web.js message, so triggers and
// threads can see what a message answers. Best effort: never throws.
export async function whatsappQuotedContext(message) {
  if (!message?.hasQuotedMsg || typeof message.getQuotedMessage !== "function") return null;
  try {
    const quoted = await message.getQuotedMessage();
    if (!quoted) return null;
    return {
      messageId: String(quoted.id?._serialized || quoted.id?.id || "") || null,
      from: String(quoted.author || quoted.from || "") || null,
      text: String(quoted.body || "").slice(0, 4000),
    };
  } catch {
    return null;
  }
}
