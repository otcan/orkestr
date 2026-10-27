// A grouped V2 Deep final quotes the newest WhatsApp input it answers.
//
// V2 (PR #377) may answer a burst of owner messages that queued while Deep was
// busy with ONE Deep final. That final is parented to the burst's first input
// and marks `quoteSource: true` with `sourceInputId`, the adapter id of the
// burst's LAST input (imported as remoteQuoteSource / remoteOriginalInputId).
// The relay then sends the final as a reply-quote of that WhatsApp message.
//
// Same rules as a burst Quick reply (#369): the quote is presentation only.
// Any missing or ambiguous link, or an id that is not an input of this chat,
// drops the quote and the reply is still sent. A quoted send that fails is
// retried once unquoted with the same requestId; the quote is not part of the
// transport's hashed material, so a first attempt that did reach WhatsApp
// answers the retry as a duplicate and the reply is never sent twice.
import {validQuotedMessageId} from './whatsapp-scoped-group-formatting.js';

const pick = value => typeof value === 'string' && value ? value : '';

// The WhatsApp input id a grouped Deep final quotes, or ''.
// `routedFor(threadId, localMessageId)` returns the relay-routed WhatsApp ids of
// one local message; `inChat(id, chatId)` proves the id is an input of the chat.
export function quotedGroupInput({answer, messages = [], input, group, routedFor, inChat}) {
  if (answer?.remoteQuoteSource !== true || answer.remoteLayer !== 'deep'
      || !['final_answer', 'final'].includes(answer.phase)) return '';
  const source = pick(answer.remoteOriginalInputId), remoteThreadId = pick(answer.remoteThreadId);
  if (!source || !remoteThreadId || typeof routedFor !== 'function' || typeof inChat !== 'function') return '';
  const locals = messages.filter(m => m?.role === 'user' && m.remoteMessageId === source && m.remoteThreadId === remoteThreadId);
  if (locals.length !== 1) return '';
  let ids = [];
  try { ids = routedFor(group.threadId, locals[0].id); } catch { return ''; }
  if (!Array.isArray(ids) || ids.length !== 1) return '';
  const id = pick(ids[0]);
  // The parent itself needs no quote: a lone input is never quoted.
  if (!validQuotedMessageId(id) || id === input?.id) return '';
  try { return inChat(id, input?.chat_id) ? id : ''; } catch { return ''; }
}

// The relay's own journals: its routed inputs and the chat's recorded inputs.
export function relayQuoteLookups(relayDb, inboxDb) {
  return {
    routedFor: (threadId, messageId) => relayDb.prepare('SELECT id FROM routed WHERE thread_id=? AND message_id=? LIMIT 2')
      .all(threadId, messageId).map(row => row.id),
    inChat: (id, chatId) => Boolean(inboxDb.prepare('SELECT 1 FROM group_input WHERE id=? AND chat_id=?').get(id, chatId)),
  };
}

// Send one text chunk, quoted when `quotedMessageId` is set; a failed or
// unconfirmed quoted attempt is retried once unquoted under the same request.
export async function sendQuotedOnce(send, payload, quotedMessageId, onFallback = () => {}) {
  if (!quotedMessageId) return send(payload);
  try {
    const result = await send({...payload, quotedMessageId});
    if (result?.ok === true && result.ids?.length) return result;
  } catch { /* degrade below */ }
  onFallback();
  return send(payload);
}
