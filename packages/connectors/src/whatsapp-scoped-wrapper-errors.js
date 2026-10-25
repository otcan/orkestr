// The scoped group wrapper validates arguments before contacting the worker.
// That rejection is definitive (nothing was dispatched) and must not be treated
// as an uncertain provider delivery, which would block every scoped send.
export function wrapperRejection(error) {
  let code = '';
  try { code = JSON.parse(String(error?.stderr || '').trim().split('\n').pop() || '{}').error || ''; } catch { code = ''; }
  return Object.assign(new Error(/^[a-z_]+$/.test(code) ? code : 'scoped_reply_failed'), {definitive: code === 'scoped_reply_invalid'});
}
