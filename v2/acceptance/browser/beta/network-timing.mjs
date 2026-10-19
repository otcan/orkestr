import {failure} from './diagnostics.mjs';

const KINDS = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'xhr',
  'fetch', 'websocket', 'other']);

// Passive observation only: no request interception competes with an explicitly
// reviewed response-fault case. No URL, header, body or query enters the receipt.
export function networkTiming(page, origin) {
  const expected = new URL(origin);
  if (expected.origin !== origin || expected.username || expected.password) throw failure('invalid_action');
  const pending = new Map(), groups = {};
  let count = 0, refused = false, disposed = false;
  const request = item => {
    if (disposed) return;
    if (++count > 2048) { refused = true; return; }
    try {
      const url = new URL(item.url());
      if (url.origin !== origin && !['blob:', 'data:', 'about:'].includes(url.protocol)) {
        refused = true; return;
      }
      const raw = item.resourceType(), kind = KINDS.has(raw) ? raw : 'other';
      pending.set(item, {started: performance.now(), kind});
    } catch { refused = true; }
  };
  const finish = (item, failed) => {
    const start = pending.get(item);
    if (!start) return;
    pending.delete(item);
    const elapsed = Math.max(0, Math.round(performance.now() - start.started));
    const group = groups[start.kind] ??= {completed: 0, failed: 0, total_ms: 0, maximum_ms: 0};
    group.completed++; group.failed += Number(failed);
    group.total_ms += Math.min(elapsed, 1_200_000);
    group.maximum_ms = Math.max(group.maximum_ms, Math.min(elapsed, 1_200_000));
  };
  const finished = item => finish(item, false), failed = item => finish(item, true);
  page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed);
  return {
    snapshot() {
      if (refused) throw failure('unexpected_origin');
      return {requests: count, pending: pending.size, by_kind: structuredClone(groups)};
    },
    close() {
      page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed);
      disposed = true;
      // Persistent browser requests are not caller-owned tasks to cancel here.
      // The owned context is separately closed/joined by the qualification.
      pending.clear(); return true;
    },
  };
}
