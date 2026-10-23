const REPLY_TEXT_MAX = 500;
const REPLY_SNIPPET_MAX = 80;
const collapse = value => String(value || '').replace(/\s+/g, ' ').trim();
const clip = (value, max) => { const text = collapse(value); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text; };

// The structured reply-to for an input that quoted another message, or null.
// An unresolvable quote is marked `unavailable` instead of guessed. `own` is the
// text Orkestr itself sent (from the relay's journal) when the quote is one of
// its replies. The visible line is what the model reads.
export function buildReplyTo(input, {own = null, ownChatId = '', timeZone = 'Europe/Berlin'} = {}) {
  if (!input.quote_row) return null;
  const quotedId = input.quote_id || null;
  const body = own?.text || input.quote_body || '';
  if (!Number(input.quote_resolved) && !own) {
    return {replyTo: {messageId: quotedId, author: input.quote_author || null, sentAt: input.quote_sent_at || null, text: '', isOwnReply: false, unavailable: true},
      line: '[Replying to an unavailable message]'};
  }
  const sentAt = input.quote_sent_at || own?.sentAt || null;
  const authorDigits = String(input.quote_author || '').split('@')[0];
  const ownerAuthored = !own && Boolean(authorDigits) && authorDigits === String(ownChatId).split('@')[0];
  const replyTo = {messageId: quotedId, author: own ? 'orkestr' : (input.quote_author || null), sentAt, text: clip(body, REPLY_TEXT_MAX), isOwnReply: Boolean(own)};
  let time = '';
  if (sentAt) {
    try { time = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone}).format(new Date(sentAt)); } catch { time = ''; }
  }
  const who = own ? 'Orkestr message' : (ownerAuthored ? 'your message' : 'earlier message');
  const line = `[Replying to ${who}${time ? ` from ${time}` : ''}: "${clip(body, REPLY_SNIPPET_MAX)}"]`;
  return {replyTo, line};
}

