// Inject the product formatter so a minimal transport installation can reuse
// its existing immutable Orkestr release without copying the application.
// Chunks are returned exactly as the worker will send them: the local bridge
// trims outbound text, and timer notifications prove the exact text, so a
// fixed-width cut that lands next to whitespace must not leave it on a chunk
// edge (a trailing space made the proof mismatch and blocked every send).
const sendable = chunks => chunks.map(chunk => chunk.trim()).filter(Boolean);
export function scopedGroupReplyChunks({text, message, thread, messages, config, formatter, env = process.env, deliveryType = 'final'}) {
  const clean = formatter ? formatter.stripWhatsAppDebugFooter(text) : text;
  const prefix = String(config.replyPrefix || '').trim();
  const content = prefix && !clean.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix} ${clean}` : clean;
  const chunks = content.match(/[\s\S]{1,1400}/gu) || [];
  if (!chunks.length) return chunks;
  const footerEnv = config.appendDebugFooter === true ? {...env, ORKESTR_WHATSAPP_DEBUG_FOOTER: '1'} : env;
  if (!formatter || config.appendDebugFooter === false || !formatter.shouldAppendWhatsAppDebugFooter(message, footerEnv, deliveryType, thread)) return sendable(chunks);
  const footer = formatter.whatsappDebugFooter({message, thread, messages, deliveryType, env: footerEnv});
  if ([...footer].length > 1400) throw new Error('group_footer_too_large');
  const last = chunks.length - 1;
  if ([...chunks[last]].length + [...footer].length + 2 <= 1400) chunks[last] += `\n\n${footer}`;
  else chunks.push(footer);
  return sendable(chunks);
}
