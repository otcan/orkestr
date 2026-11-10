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
  'group_transport_configuration_changed',
  // No reservation for THIS id exists: same-id ambiguity has its own code.
  'delivery_route_blocked_before_reservation',
]);
const WRAPPER_CODES = new Set([...PRE_DISPATCH,
  'scoped_reply_failed', 'scoped_reply_unconfirmed', 'delivery_uncertain', 'whatsapp_worker_timeout', 'whatsapp_worker_request_failed',
  'group_transport_delivery_uncertain', 'group_transport_request_conflict', 'timer_notification_proof_denied',
  'delivery_route_delivery_unresolved', 'delivery_route_attempt_unresolved', 'delivery_route_inactive',
]);
// The wrapper emits one closed JSON error on its last line. Never expose the
// execFile message (which embeds argv/text), arbitrary stdout, or raw stderr.
export function wrapperErrorCode(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
  if (!stderr || Buffer.byteLength(stderr) > 65536) return null;
  const line = stderr.trimEnd().split('\n').at(-1);
  if (!line || Buffer.byteLength(line) > 4096) return null;
  try {
    const value = JSON.parse(line);
    return value && value.ok === false && Object.keys(value).length === 2
      && Object.hasOwn(value, 'error') && WRAPPER_CODES.has(value.error) ? value.error : null;
  } catch { return null; }
}
export function wrapperRejection(error) {
  const code = wrapperErrorCode(error) || 'scoped_reply_failed';
  return Object.assign(new Error(code), {definitive: PRE_DISPATCH.has(code)});
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
  let first;
  try { return await send(quotedMessageId); } catch (error) { first = wrapperRejection(error); }
  try { return await send(undefined); } catch (error) {
    const second = wrapperRejection(error);
    // A later pre-dispatch refusal cannot erase an earlier ambiguous send.
    throw first.definitive ? second : first;
  }
}
