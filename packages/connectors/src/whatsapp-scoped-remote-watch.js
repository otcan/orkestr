// A waiting HTTP request carries an export wakeup through the V1 importer.
// Ordinary scans remain the recovery path for old/non-advertising backends.
export function startScopedRemoteWatch({api, deliver, log = () => {}}) {
  const abort = new AbortController();
  const pause = ms => new Promise(resolve => {
    if (abort.signal.aborted) return resolve();
    const finish = () => {clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve();};
    const timer = setTimeout(finish, ms);
    abort.signal.addEventListener('abort', finish, {once: true});
  });
  async function watch(backend) {
    let cursor = '', delay = 500;
    while (!abort.signal.aborted) {
      try {
        const batch = await api(`/api/connectors/whatsapp/remote-runtime/changes?backend=${encodeURIComponent(backend)}&cursor=${encodeURIComponent(cursor)}`,
          {timeoutMs: 40000, signal: abort.signal});
        if (typeof batch?.cursor !== 'string' || !Array.isArray(batch.threadIds) || batch.threadIds.some(id => typeof id !== 'string'))
          throw new Error('remote_change_response_invalid');
        if (abort.signal.aborted) break;
        if (batch.threadIds.length) await deliver(batch.threadIds);
        if (batch.retry) throw new Error('remote_change_import_pending');
        cursor = batch.cursor;
        delay = 500;
      } catch {
        if (abort.signal.aborted) break;
        log({event: 'remote_relay_watch_error', backend, retryMs: delay});
        await pause(delay);
        delay = Math.min(30000, delay * 2);
      }
    }
  }
  const tasks = new Map();
  const discovery = (async () => {
    while (!abort.signal.aborted) {
      try {
        const result = await api('/api/connectors/whatsapp/remote-runtime/watches', {timeoutMs: 15000, signal: abort.signal});
        for (const backend of result?.backends || []) if (typeof backend === 'string' && !tasks.has(backend)) tasks.set(backend, watch(backend));
      } catch { if (!abort.signal.aborted) log({event: 'remote_relay_discovery_error'}); }
      // Capability/config discovery only; exports never wait for this interval.
      await pause(60000);
    }
  })();
  return {async close() {abort.abort(); await discovery; await Promise.allSettled(tasks.values());}};
}
