// Long-poll signals never wait for imports or provider delivery. Pending work
// remains per-thread until success; process restart gets an adapter snapshot.
export function startScopedRemoteWatch({api, deliver, log = () => {}}) {
  const abort = new AbortController(), jobs = new Map(), running = new Set();
  let background = 0, foreground = 0, retryTimer = null;
  const pause = ms => new Promise(resolve => {
    if (abort.signal.aborted) return resolve();
    const finish = () => {clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve();};
    const timer = setTimeout(finish, ms);
    abort.signal.addEventListener('abort', finish, {once: true});
  });
  function drain() {
    clearTimeout(retryTimer);
    if (abort.signal.aborted) return;
    const pending = [...jobs.values()].filter(job => !job.running).sort((a, b) => Number(a.background) - Number(b.background));
    for (const job of pending) {
      if (job.next > Date.now() || (job.background ? background >= 2 : foreground >= 4)) continue;
      const lane = job.background;
      if (lane) background++; else foreground++;
      job.running = true; job.dirty = false;
      const task = (async () => {
        try {
          const result = await api(`/api/connectors/whatsapp/remote-runtime/sync?backend=${encodeURIComponent(job.backend)}&thread=${encodeURIComponent(job.threadId)}`,
            {timeoutMs: 15000, signal: abort.signal});
          if (abort.signal.aborted) return;
          if (result?.ok !== true || result.threadId !== job.threadId) throw new Error('remote_sync_response_invalid');
          if (!result.skipped) await deliver([job.threadId]);
          if (result?.retry) throw new Error('remote_change_import_pending');
          if (!job.dirty) jobs.delete(job.key);
          job.next = 0; job.delay = 500;
        } catch {
          job.next = Date.now() + job.delay;
          job.delay = Math.min(30000, job.delay * 2);
          if (!abort.signal.aborted) log({event: 'remote_relay_thread_pending', threadId: job.threadId});
        } finally {
          job.running = false;
          if (lane) background--; else foreground--;
        }
      })();
      running.add(task);
      task.finally(() => {running.delete(task); drain();});
    }
    const next = Math.min(...[...jobs.values()].filter(job => !job.running && job.next > Date.now()).map(job => job.next));
    if (Number.isFinite(next)) retryTimer = setTimeout(drain, Math.max(1, next - Date.now()));
  }
  function enqueue(backend, ids, snapshot) {
    for (const threadId of ids) {
      const key = JSON.stringify([backend, threadId]);
      const job = jobs.get(key) || {key, backend, threadId, background: snapshot, running: false};
      // Fresh events have reserved capacity; unrelated snapshot reads cannot
      // consume it. Repeated changes coalesce into another read of this thread.
      job.background = job.background && snapshot;
      job.dirty = true; job.next = 0; job.delay = 500;
      jobs.set(key, job);
    }
    drain();
  }
  async function watch(backend, version) {
    let cursor = '', delay = 500;
    while (!abort.signal.aborted) {
      try {
        const batch = await api(`/api/connectors/whatsapp/remote-runtime/changes?backend=${encodeURIComponent(backend)}&cursor=${encodeURIComponent(cursor)}${version >= 2 ? '&signalOnly=1' : ''}`,
          {timeoutMs: 40000, signal: abort.signal});
        if (typeof batch?.cursor !== 'string' || !Array.isArray(batch.threadIds) || batch.threadIds.some(id => typeof id !== 'string'))
          throw new Error('remote_change_response_invalid');
        if (abort.signal.aborted) break;
        if (version >= 2) enqueue(backend, batch.threadIds, batch.reset === true);
        else {
          if (batch.threadIds.length) await deliver(batch.threadIds);
          if (batch.retry) throw new Error('remote_change_import_pending');
        }
        // Cursor is memory-only. Every queued thread retries independently;
        // an interrupted process reconnects from an initial full snapshot.
        cursor = batch.cursor; delay = 500;
      } catch {
        if (abort.signal.aborted) break;
        log({event: 'remote_relay_watch_error', backend, retryMs: delay});
        await pause(delay); delay = Math.min(30000, delay * 2);
      }
    }
  }
  const tasks = new Map();
  const discovery = (async () => {
    while (!abort.signal.aborted) {
      try {
        const result = await api('/api/connectors/whatsapp/remote-runtime/watches', {timeoutMs: 15000, signal: abort.signal});
        for (const backend of result?.backends || []) if (typeof backend === 'string' && !tasks.has(backend)) tasks.set(backend, watch(backend, result.version || 1));
      } catch { if (!abort.signal.aborted) log({event: 'remote_relay_discovery_error'}); }
      await pause(60000); // Capability discovery, never export polling.
    }
  })();
  return {async close() {
    abort.abort(); clearTimeout(retryTimer);
    await discovery; await Promise.allSettled(tasks.values());
    await Promise.allSettled(running);
  }};
}
