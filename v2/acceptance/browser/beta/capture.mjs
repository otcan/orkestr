import {failure} from './diagnostics.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['messages', 'window', 'accept', 'stop', 'steer']);

// Passive, conversation-scoped receipt capture. Raw JSON stays in memory for
// exact-tuple assertions; callers must publish only their closed proof summary.
// Authentication/setup/session endpoints and headers are never captured.
export function captureControls(page, origin, conversation) {
  if (!UUID.test(conversation) || new URL(origin).origin !== origin) throw failure('invalid_action');
  const base = `/api/v2/conversations/${conversation}/`, records = [], pending = new Set();
  let closed = false, broken, count = 0;
  const notify = response => {
    if (closed) return;
    let url, request;
    try {
      url = new URL(response.url()); request = response.request();
      if (url.origin !== origin || !url.pathname.startsWith(base) || request.method() !== 'POST') return;
      const operation = url.pathname.slice(base.length);
      if (!OPERATIONS.has(operation) || url.search) return;
      if (++count > 32) throw failure('request_budget');
      const requestText = request.postData();
      if (typeof requestText !== 'string' || Buffer.byteLength(requestText) > 16384) throw failure('request_budget');
      const item = {operation, status: response.status(), request: requestText};
      const work = Promise.resolve().then(async () => {
        const text = await response.text();
        if (Buffer.byteLength(text) > 65536) throw failure('request_budget');
        item.response = text; records.push(item);
      });
      pending.add(work);
      work.catch(error => { broken ??= error; }).finally(() => pending.delete(work));
    } catch (error) { broken ??= error; }
  };
  page.on('response', notify);
  return {
    take(operation) {
      if (!OPERATIONS.has(operation)) throw failure('invalid_action');
      if (broken) throw broken;
      const index = records.findIndex(item => item.operation === operation);
      return index < 0 ? null : records.splice(index, 1)[0];
    },
    async close() {
      closed = true; page.off('response', notify);
      let timer;
      try {
        await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('cleanup_unknown')), 6000);
        })]);
        if (pending.size || broken) throw broken ?? failure('cleanup_unknown');
        return true;
      } finally { clearTimeout(timer); }
    },
    discard() { records.length = 0; },
  };
}
