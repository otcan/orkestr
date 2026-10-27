// Replies to V2 timer turns on a thread delegated to the remote runtime.
//
// A V2 timer fires inside the remote runtime, so its reply has no relay-routed
// WhatsApp input to answer. V1 materializes a local parent for it (source
// "orkestr-v2-timer") and records a server event; the timer notification loop
// then delivers the imported reply to the thread's own bound chat through the
// same proof journal, route fence and uncertain rules as a V1 timer run, and
// reports the outcome back to V1 (`scoped-relay-delivery`) so the mirror
// acknowledgement settles the remote input. Proof chain: server event -> its
// materialized parent (bound to this remote thread) -> the imported final
// reply whose parentMessageId is that parent.
//
// Kept free of core imports: the standalone bridge's import graph stays closed.
import {notificationKey} from './whatsapp-timer-notification-proof.js';
import {FAST_TIMER_SOURCE_ID, encodeReplyEntry, validQuotedMessageId, replyEntrySendFields, scopedGroupReplyChunks, scopedReplyDeliveryType, scopedReplyHeader} from './whatsapp-scoped-group-formatting.js';

export const remoteTimerParentEvent = 'whatsapp_remote_timer_parent_materialized';
const remoteTimerParentSource = 'orkestr-v2-timer';
const finalPhases = new Set(['final', 'final_answer']);
const visible = m => !['hidden', 'internal', 'private'].includes(m.visibility) && m.signalMode !== 'record_only' && m.deliveryMode !== 'record_only' && m.notify !== false && m.notificationEligible !== false;
const pick = (...values) => values.map(v => String(v || '').trim()).find(Boolean) || '';

export function remoteTimerEventEligible(event, config, scope, since, now) {
  const at = Date.parse(event?.ts);
  return event?.type === remoteTimerParentEvent && event.ownerUserId === config.ownerUserId && scope.threads.has(event.target)
    && event.targetType === 'thread' && pick(event.messageId) && pick(event.remoteThreadId) && pick(event.remoteMessageId)
    && Number.isFinite(at) && at >= since && at <= now;
}

// The WhatsApp input a burst Quick reply quotes, or ''. V2 marks such a reply
// (`quoteSource`, imported as remoteQuoteSource) and names the adapter id of the
// input it answers (`sourceInputId` -> remoteOriginalInputId). That id is the
// remoteMessageId V1 recorded when it forwarded exactly one local relay input;
// `routedInput` maps that local message to the relay-routed WhatsApp message.
// Any missing link yields '' and the reply goes out unquoted.
export function quotedSourceInput({threadId, parent, answer, messages, remoteThreadId, routedInput}) {
  if (answer?.remoteQuoteSource !== true || answer.remoteLayer !== 'fast' || parent?.timerId !== FAST_TIMER_SOURCE_ID
      || typeof routedInput !== 'function') return '';
  const source = pick(answer.remoteOriginalInputId);
  if (!source) return '';
  const inputs = messages.filter(m => m.role === 'user' && m.remoteMessageId === source && m.remoteThreadId === remoteThreadId);
  if (inputs.length !== 1) return '';
  let id = '';
  try { id = pick(routedInput(threadId, inputs[0].id)); } catch { return ''; }
  return validQuotedMessageId(id) ? id : '';
}

// The thread is still delegated to the same remote thread the parent came from.
export function delegatedTo(thread, remoteThreadId) {
  const b = thread?.binding || {};
  if (String(b.connector || 'whatsapp').trim().toLowerCase() !== 'whatsapp') return false;
  if (b.remoteRuntimeEnabled === false || b.remoteRouterEnabled === false) return false;
  return Boolean(remoteThreadId) && pick(b.remoteThreadId, b.remoteRuntimeThreadId, b.delegatedThreadId) === remoteThreadId;
}

export function createRemoteTimerReplies({config, api, send, formatter, env, now, proofs, fence, scope, thread, runTtlMs, routedInput}) {
  const at = () => new Date(now()).toISOString();
  const report = (threadId, answer, body) => api(
    `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(answer.id)}/scoped-relay-delivery`,
    {method: 'POST', body});
  // A definite non-send: tell V1 so the remote input settles, then close the run.
  async function close(threadId, event, answer, outcome, reason, state) {
    await report(threadId, answer, {outcome, reason});
    proofs.finish(event.messageId, state, at());
  }

  async function deliver(threadId, t, event, messages, since) {
    const chatId = scope.threads.get(threadId);
    if (!delegatedTo(t, event.remoteThreadId)) { proofs.finish(event.messageId, 'ineligible', at()); return 0; }
    const parent = messages.find(m => m.id === event.messageId);
    const parentAt = Date.parse(parent?.createdAt);
    if (!parent || parent.role !== 'user' || parent.source !== remoteTimerParentSource || parent.remoteThreadId !== event.remoteThreadId
        || parent.remoteMessageId !== event.remoteMessageId || !Number.isFinite(parentAt) || parentAt < since || parentAt > now()) {
      proofs.finish(event.messageId, 'unverified', at()); return 0;
    }
    const answer = messages.filter(m => m.parentMessageId === parent.id && m.role === 'assistant' && m.state === 'completed'
        && finalPhases.has(m.phase) && pick(m.remoteMessageId) && m.remoteThreadId === event.remoteThreadId && (!m.chatId || m.chatId === chatId))
      .sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0)).at(-1);
    if (!answer) {
      if (now() - Date.parse(event.ts) > runTtlMs) proofs.finish(event.messageId, 'expired', at());
      return 0;
    }
    // V1's acknowledgement loop reports an exact NO_REPLY itself.
    if (String(answer.text || '').trim() === 'NO_REPLY') { proofs.finish(event.messageId, 'no_reply', at()); return 0; }
    if (answer.deliveryState === 'delivered') { proofs.finish(event.messageId, 'delivered', at()); return 0; }
    const baseId = 'timer:' + notificationKey([threadId, event.messageId]);
    const prior = proofs.get(baseId + ':0');
    let chunks;
    if (prior) {
      if (prior.state === 'uncertain') throw new Error('timer_notification_delivery_unresolved');
      chunks = [];
      for (let i = 0; ; i++) { const row = proofs.get(baseId + ':' + i); if (!row) break; chunks.push(row.text); }
    } else {
      const answerAt = Date.parse(answer.createdAt);
      if (t.binding.mirrorReplies === false) { await close(threadId, event, answer, 'suppressed', 'mirror_replies_disabled', 'suppressed'); return 0; }
      if (!visible(answer) || !String(answer.text || '').trim()) { await close(threadId, event, answer, 'suppressed', 'not_visible', 'suppressed'); return 0; }
      if (!Number.isFinite(answerAt) || answerAt > now() || now() - answerAt > scope.maxAgeMs)
        { await close(threadId, event, answer, 'suppressed', 'expired', 'expired'); return 0; }
      let current = t;
      try { const {quota} = await api(`/api/quota/providers?ownerUserId=${encodeURIComponent(config.ownerUserId)}`, {timeoutMs: 1000}); if (quota) current = {...current, whatsAppDebugProviderQuota: quota}; } catch {}
      const label = {label: String(parent.text || '').replace(/^Scheduled timer:\s*/, ''), timerId: parent.timerId, postAuthor: parent.postAuthor};
      const header = scopedReplyHeader(label);
      // Quick, coordinator and timer answers keep the owner footer; a system notice does not.
      chunks = scopedGroupReplyChunks({text: `${header}\n${answer.text}`, message: {...answer, chatId}, thread: current, messages, config, formatter, env, deliveryType: scopedReplyDeliveryType(label)});
      proofs.prepareBatch(chunks.map((entry, i) => ({id: baseId + ':' + i, threadId, chatId, timerId: pick(parent.timerId, event.timerSourceId, 'v2-timer'),
        parentId: parent.id, answerId: answer.id, text: encodeReplyEntry(entry), createdAt: answer.createdAt, runAt: event.ts,
        expiresAt: new Date(answerAt + scope.maxAgeMs).toISOString()})));
    }
    // Presentation only: the proof and journal authorize text and parent, never
    // the quote, and the transport drops a quote outside this chat.
    const quotedMessageId = quotedSourceInput({threadId, parent, answer, messages, remoteThreadId: event.remoteThreadId, routedInput});
    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      const id = baseId + ':' + i, row = proofs.get(id);
      if (row.state === 'sent' || row.state === 'revoked') continue;
      if (Date.parse(row.expires_at) < now()) { proofs.mark(id, 'revoked'); continue; }
      if (!delegatedTo(await thread(threadId), event.remoteThreadId)) { proofs.mark(id, 'revoked'); continue; }
      fence.assertActive(config.routeControl.routeId);
      try {
        const fields = replyEntrySendFields(row.text);
        const r = await send({chatId, requestId: id, notificationId: id, parentId: parent.id, ...fields,
          ...(i === 0 && quotedMessageId && fields.text !== undefined ? {quotedMessageId} : {})});
        if (r.ok !== true || !r.ids?.length) throw new Error('unconfirmed');
        proofs.mark(id, 'sent'); proofs.receipt(id, r.ids); sent++;
      } catch (error) {
        if (error?.definitive === true) {
          // Rejected before dispatch: nothing reached the provider.
          proofs.mark(id, 'revoked');
          await close(threadId, event, answer, 'failed', 'send_rejected', 'rejected');
          throw new Error('timer_notification_send_rejected');
        }
        const recovered = fence.unknown({id, hash: notificationKey([chatId, row.text, parent.id]), route: config.routeControl.routeId});
        if (recovered.providerId) { proofs.mark(id, 'sent'); proofs.receipt(id, [recovered.providerId]); sent++; }
        else { proofs.mark(id, 'uncertain'); throw new Error('timer_notification_delivery_unresolved'); }
      }
    }
    // Report the confirmed send; a failed report retries next tick without resending.
    const requestIds = chunks.map((_, i) => baseId + ':' + i).filter(id => proofs.get(id)?.state === 'sent');
    if (!requestIds.length) { await close(threadId, event, answer, 'suppressed', 'expired', 'expired'); return sent; }
    await report(threadId, answer, {requestIds, connectorMessageIds: proofs.receipts(requestIds), deliveredAt: at()});
    proofs.finish(event.messageId, 'delivered', at());
    return sent;
  }
  return {deliver};
}
