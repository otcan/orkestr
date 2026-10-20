// The scoped group wrapper validates arguments before contacting the worker.
// That rejection is definitive (nothing was dispatched) and must not be treated
// as an uncertain provider delivery, which would block every scoped send.
// The worker's own policy denials are raised before the transport journals or
// reserves a send, so they are equally definitive. Anything else (timeouts,
// delivery_uncertain, request conflicts, unresolved fences) stays uncertain.
const PRE_DISPATCH = new Set([
  'scoped_reply_invalid',
  'scoped_worker_operation_denied',
  'scoped_worker_text_only',
  'group_transport_scope_denied',
  'group_transport_notification_denied',
  'timer_notification_proof_denied',
]);
export function wrapperRejection(error) {
  let code = '';
  try { code = JSON.parse(String(error?.stderr || '').trim().split('\n').pop() || '{}').error || ''; } catch { code = ''; }
  return Object.assign(new Error(/^[a-z_]+$/.test(code) ? code : 'scoped_reply_failed'), {definitive: PRE_DISPATCH.has(code)});
}
