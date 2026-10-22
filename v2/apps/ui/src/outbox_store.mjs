// Outbox persistence in localStorage: one entry per unsent item under
// `orkestr.v2.outbox.<owner global conversation>.<idempotency key>`, so tabs
// never overwrite each other's items. Every access is guarded; a browser
// without storage degrades to page memory.
const PREFIX = /^orkestr\.v2\.outbox\.[0-9a-f-]{36}\.$/;

export function loadOutbox(prefix, storage = globalThis.localStorage) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) return [];
  const items = [];
  try {
    for (let i = 0; i < storage.length && items.length < 400; i++) {
      const key = storage.key(i);
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const value = storage.getItem(key);
      if (typeof value === 'string' && value.length <= 262144) items.push(value);
    }
  } catch { return items; }
  return items;
}

// `changes`: [[idempotency key, JSON text or null to remove], ...]
export function storeOutbox(prefix, changes, storage = globalThis.localStorage) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix) || !Array.isArray(changes)) return false;
  let ok = true;
  for (const [key, value] of changes) {
    // Request keys as Core accepts them, e.g. `web:<uuid>` for composer messages.
    if (typeof key !== 'string' || !/^[A-Za-z0-9:_.-]{1,128}$/.test(key)) { ok = false; continue; }
    try {
      if (value === null) storage.removeItem(prefix + key);
      else if (typeof value === 'string' && value.length <= 262144) storage.setItem(prefix + key, value);
      else ok = false;
    } catch { ok = false; }
  }
  return ok;
}

// Resolves with why the outbox should look again: a timeout, the network
// coming back, the tab becoming visible, or a new Send ('kick').
export function waitOutbox(ms, target = globalThis) {
  return new Promise(resolve => {
    let done = false;
    const finish = reason => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener('online', online);
      target.removeEventListener('orkestr-outbox', kick);
      target.document?.removeEventListener('visibilitychange', visible);
      resolve(reason);
    };
    const online = () => finish('online');
    const kick = () => finish('kick');
    const visible = () => { if (target.document?.visibilityState === 'visible') finish('visible'); };
    const timer = setTimeout(() => finish('timeout'), Math.max(50, Math.min(60000, Number(ms) || 0)));
    target.addEventListener('online', online);
    target.addEventListener('orkestr-outbox', kick);
    target.document?.addEventListener('visibilitychange', visible);
  });
}
