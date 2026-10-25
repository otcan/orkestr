// Reply payloads for the scoped group relay and its timer notifications.
// Only Node built-ins are imported so the standalone bridge's graph stays closed.
import crypto from 'node:crypto';

export const SCOPED_REPLY_DEFAULT_CHARS = 20000;
export const SCOPED_REPLY_MIN_CHARS = 1000;
export const SCOPED_REPLY_MAX_CHARS = 60000;
export const SCOPED_FOOTER_MAX_CHARS = 4000;
export const SCOPED_ATTACHED_MARKER = '… (full reply attached)';
// Largest single WhatsApp text the scoped send path accepts (String#length):
// the reply budget plus the attachment marker and the footer.
export const SCOPED_SEND_MAX_TEXT_LENGTH = 65000;
export const SCOPED_DOCUMENT_MIMETYPE = 'text/markdown';
export const SCOPED_DOCUMENT_MAX_CHARS = 2_000_000;
export const SCOPED_DOCUMENT_NAME = /^reply-[0-9a-f]{10}\.md$/;
const TRUNCATED_NOTE = '\n\n[Reply truncated: exceeds the attachment limit]';
// A split looks for a natural boundary only in the last quarter of the window.
const BOUNDARY_WINDOW = 0.25;

const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;

// Relay config `maxReplyChars`, then env ORKESTR_WHATSAPP_MAX_REPLY_CHARS,
// then the default; clamped to the supported range.
export function scopedGroupReplyLimit(config = {}, env = process.env) {
  for (const raw of [config?.maxReplyChars, env?.ORKESTR_WHATSAPP_MAX_REPLY_CHARS]) {
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    return Math.min(SCOPED_REPLY_MAX_CHARS, Math.max(SCOPED_REPLY_MIN_CHARS, Math.floor(value)));
  }
  return SCOPED_REPLY_DEFAULT_CHARS;
}

// A payload entry is either a text string (every payload frozen by an older
// build is one) or {document: {filename, mimetype, text}}.
export const isReplyDocument = entry => Boolean(entry && typeof entry === 'object' && entry.document);

export function validReplyDocument(document) {
  return Boolean(document && typeof document === 'object' && SCOPED_DOCUMENT_NAME.test(document.filename || '')
    && document.mimetype === SCOPED_DOCUMENT_MIMETYPE && typeof document.text === 'string' && document.text.trim()
    && document.text.length <= SCOPED_DOCUMENT_MAX_CHARS);
}

// The canonical string form of an entry: the text itself, or a fixed-order
// JSON envelope for a document. It is what timer proofs store and what the
// send journal hashes, so a document is authorized and deduplicated exactly
// like a text. Timer and post texts start with their header line, never with "{".
// The header line of a relayed timer-run or conversation-post reply.
// V2 conversation posts (coordinator notes, operator alerts, assistant
// questions) reach V1 as pseudo timer turns whose source timer id is "post"
// and whose parent text is the post label; the V2 adapter also exports the
// post author. Only real timers are labelled as timers.
export const POST_TIMER_SOURCE_ID = 'post';
const oneLine = value => String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);

export function scopedReplyHeader({label, timerId, postAuthor} = {}) {
  const name = oneLine(label);
  if (String(timerId || '').trim() !== POST_TIMER_SOURCE_ID) return `⏰ ${name || 'Scheduled task'}`;
  const author = String(postAuthor || '').trim().toLowerCase() || ({operator: 'operator', system: 'operator', question: 'assistant_question'})[name.toLowerCase()] || 'coordinator';
  if (author === 'operator') return '⚙️ System:';
  if (author === 'assistant_question') return `❓ ${name || 'Question'}:`;
  return `🤖 ${name || 'Coordinator'}:`;
}

export function encodeReplyEntry(entry) {
  if (!isReplyDocument(entry)) return entry;
  const {filename, mimetype, text} = entry.document;
  return JSON.stringify({document: {filename, mimetype, text}});
}

export function decodeReplyEntry(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('{"document":')) return stored;
  try {
    const parsed = JSON.parse(stored);
    if (validReplyDocument(parsed?.document) && encodeReplyEntry(parsed) === stored) return parsed;
  } catch { /* an unparseable value stays text */ }
  return stored;
}

// Send fields for a stored (string) entry: {text} or {document}.
export function replyEntrySendFields(stored) {
  const entry = decodeReplyEntry(stored);
  return isReplyDocument(entry) ? {document: entry.document} : {text: entry};
}

// Largest end <= `end` that does not split a surrogate pair or a grapheme
// cluster (emoji ZWJ sequences, flags, skin tones, combining marks).
function safeEnd(text, end) {
  if (end >= text.length) return text.length;
  let safe = end;
  if (segmenter) {
    const start = Math.max(0, end - 128);
    let boundary = start;
    for (const {index} of segmenter.segment(text.slice(start, Math.min(text.length, end + 128)))) {
      if (start + index > end) break;
      boundary = start + index;
    }
    if (boundary > 0 && (boundary > start || start === 0)) safe = boundary;
  }
  const code = text.charCodeAt(safe);
  if (safe > 0 && code >= 0xDC00 && code <= 0xDFFF) safe--;
  return safe;
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*(?=\s)/gu;

// The first part of `text` within `limit` code units: cut at the last
// paragraph break, line break, sentence end or space in the final quarter of
// the window, and hard cut (grapheme-safe) only when none exists.
export function scopedReplyPreview(text, limit) {
  if (text.length <= limit) return text;
  const end = safeEnd(text, limit);
  const floor = Math.floor(end * (1 - BOUNDARY_WINDOW));
  let cut = end;
  const paragraph = text.lastIndexOf('\n\n', end), line = text.lastIndexOf('\n', end);
  if (paragraph >= floor && paragraph > 0) cut = paragraph;
  else if (line >= floor && line > 0) cut = line;
  else {
    let sentence = -1;
    for (const match of text.slice(floor, Math.min(text.length, end + 1)).matchAll(SENTENCE_END)) {
      const at = floor + match.index + match[0].length;
      if (at <= end) sentence = at;
    }
    if (sentence > 0) cut = sentence;
    else for (let i = end; i >= floor && i > 0; i--) if (text[i] === ' ' || text[i] === '\t') { cut = i; break; }
  }
  return text.slice(0, Math.max(1, cut)).trimEnd() || text.slice(0, end);
}

export function scopedReplyDocumentName(seed) {
  return `reply-${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 10)}.md`;
}

// Inject the product formatter so a minimal transport installation can reuse
// its existing immutable Orkestr release without copying the application.
// A reply within the budget is one message. A longer one is one message with
// the first part, the attachment marker and the footer, followed by the full
// text as a Markdown document. Callers freeze the returned entries before the
// first send attempt; retries reuse them, so older frozen chunks stay intact.
export function scopedGroupReplyChunks({text, message, thread, messages, config, formatter, env = process.env, deliveryType = 'final'}) {
  const clean = formatter ? formatter.stripWhatsAppDebugFooter(text) : text;
  const prefix = String(config.replyPrefix || '').trim();
  const content = prefix && !clean.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix} ${clean}` : clean;
  if (!content.trim()) return [];
  const limit = scopedGroupReplyLimit(config, env);
  const footerEnv = config.appendDebugFooter === true ? {...env, ORKESTR_WHATSAPP_DEBUG_FOOTER: '1'} : env;
  let suffix = '';
  if (formatter && config.appendDebugFooter !== false && formatter.shouldAppendWhatsAppDebugFooter(message, footerEnv, deliveryType, thread)) {
    const footer = formatter.whatsappDebugFooter({message, thread, messages, deliveryType, env: footerEnv});
    if (footer.length > SCOPED_FOOTER_MAX_CHARS) throw new Error('group_footer_too_large');
    suffix = `\n\n${footer}`;
  }
  // Entries are exactly what is sent: the bridge trims outbound text, so an
  // untrimmed entry would no longer match its frozen timer proof.
  const body = content.trim();
  // The footer rides on the message and does not count against the budget.
  if (body.length <= limit) return [body + suffix];
  const marker = `\n\n${SCOPED_ATTACHED_MARKER}`;
  // A footer already embedded at the end of the reply text (a final "dbg:"
  // block of up to five lines) stays on the message too, not only in the file.
  const embedded = suffix ? null : body.match(/\n\n((?:dbg: |⚡ Quick:)[^\n]*(?:\n[^\n]+){0,4})$/);
  if (embedded && embedded[1].length <= SCOPED_FOOTER_MAX_CHARS) suffix = `\n\n${embedded[1]}`;
  const lead = embedded && suffix ? body.slice(0, embedded.index).trimEnd() : body;
  const preview = scopedReplyPreview(lead, limit - marker.length);
  const whole = clean.trim();
  const full = whole.length > SCOPED_DOCUMENT_MAX_CHARS
    ? scopedReplyPreview(whole, SCOPED_DOCUMENT_MAX_CHARS - TRUNCATED_NOTE.length) + TRUNCATED_NOTE : whole;
  const filename = scopedReplyDocumentName(message?.id || content);
  return [preview + marker + suffix, {document: {filename, mimetype: SCOPED_DOCUMENT_MIMETYPE, text: full}}];
}
