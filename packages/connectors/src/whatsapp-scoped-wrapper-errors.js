// The scoped group wrapper validates arguments before contacting the worker.
// That rejection is definitive (nothing was dispatched) and must not be treated
// as an uncertain provider delivery, which would block every scoped send.
// The worker's request-policy and scope denials are raised before the transport
// reserves or journals a send, and depend only on the request and the worker's
// configuration, so they are equally definitive. `timer_notification_proof_denied`
// is left out: the proof check also refuses a proof that an earlier, dispatched
// attempt left `uncertain`. Timeouts, delivery_uncertain and conflicts stay uncertain.
const PRE_DISPATCH = new Set([
  'scoped_reply_invalid',
  'scoped_worker_operation_denied',
  'scoped_worker_text_only',
  'group_transport_scope_denied',
  'group_transport_notification_denied',
]);
export function wrapperRejection(error) {
  let code = '';
  try { code = JSON.parse(String(error?.stderr || '').trim().split('\n').pop() || '{}').error || ''; } catch { code = ''; }
  return Object.assign(new Error(/^[a-z_]+$/.test(code) ? code : 'scoped_reply_failed'), {definitive: PRE_DISPATCH.has(code)});
}

// A quote (reply-to) is presentation only. When a quoted send fails for any
// reason (an older wrapper without `group-send`, an older worker policy that
// refuses the field, a definitive rejection), retry the same request once
// without it, so the reply degrades to unquoted instead of being revoked or
// left uncertain. The retry keeps the requestId, and the quote is not part of
// the transport's hashed material, so a first attempt that did reach WhatsApp
// answers the retry as a duplicate (or stays uncertain) and is never sent twice.
export async function sendWithQuoteFallback(send, quotedMessageId) {
  if (!quotedMessageId) {
    try { return await send(undefined); } catch (error) { throw wrapperRejection(error); }
  }
  try { return await send(quotedMessageId); } catch { /* degrade below */ }
  try { return await send(undefined); } catch (error) { throw wrapperRejection(error); }
}
