// The scoped group wrapper validates arguments before contacting the worker.
// That rejection is definitive (nothing was dispatched) and must not be treated
// as an uncertain provider delivery, which would block every scoped send.
export function wrapperRejection(error) {
  let code = '';
  try { code = JSON.parse(String(error?.stderr || '').trim().split('\n').pop() || '{}').error || ''; } catch { code = ''; }
  return Object.assign(new Error(/^[a-z_]+$/.test(code) ? code : 'scoped_reply_failed'), {definitive: code === 'scoped_reply_invalid'});
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
