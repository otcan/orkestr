// The tab's side of the local folder relay. While the owner keeps this tab
// open with a granted folder, it polls the conversation's request queue,
// performs each request inside the folder only and posts the result. File
// bytes leave the browser only through the encrypted upload client; the
// result JSON carries listings, hashes and upload references, never bytes.
// A write applies on its own (ORK-810): the owner allowed reading and
// changing the folder when he connected it, so no card and no later browser
// prompt follow. Writes run one at a time, in the order the server queued
// them, and every one is recorded in the activity with its size.
import {FolderError, LIMITS, hashFiles, listFolder, packageFiles, packageName, readFile, sha256, writeFile} from './folder.mjs';

export const POLL_MS = 2000;
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const code = error => (error instanceof FolderError ? error.code : 'browser_error');
const later = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
});

/** Activity entries kept (newest first), enough for a batch of writes. */
export const ACTIVITY_MAX = 20;

/** onChange(snapshot) is called whenever the visible state changes. */
export function createRelay({conversation, csrf, root, folderName, uploader,
  fetcher = (...args) => fetch(...args), subtle = crypto.subtle, onChange = () => {},
  connectionId = crypto.randomUUID(), wait = later, pollMs = POLL_MS}) {
  if (!uuid(conversation) || !csrf || !root || !folderName || !uploader) throw Error('Local folder relay needs a conversation, browser authorization, a folder and an uploader.');
  const base = `/api/v2/conversations/${conversation}/local-files`;
  const active = new Map(), activity = [];
  const stopper = new AbortController();
  let state = 'connecting', takeover = false, running = null, wake = null;
  // The write queue: each write starts after the previous one ended.
  let writes = Promise.resolve();
  const inOrder = task => { const run = writes.then(task, task); writes = run.catch(() => {}); return run; };

  const snapshot = () => ({state, folder: folderName, connection: connectionId, pending: [...active.values()].map(a => a.view), activity: [...activity]});
  const changed = () => { try { onChange(snapshot()); } catch { /* The view may be gone. */ } };
  const note = (request, outcome) => {
    activity.unshift({id: request.request_id, operation: request.operation, path: request.path ?? request.paths?.join(', ') ?? '', outcome,
      bytes: request.operation === 'write' && Number.isSafeInteger(request.content_bytes) ? request.content_bytes : null, at: Date.now()});
    activity.length = Math.min(activity.length, ACTIVITY_MAX);
  };
  // Read-write access was granted at Connect. If the browser took it back
  // (site settings), the write fails here: no prompt outside a click.
  async function writable() {
    if (typeof root.queryPermission !== 'function') return true;
    try { return (await root.queryPermission({mode: 'readwrite'})) === 'granted'; } catch { return false; }
  }
  async function call(method, path, body) {
    const response = await fetcher(path, {method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: {...(method === 'GET' ? {} : {'x-orkestr-csrf': csrf}), ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: stopper.signal});
    const text = await response.text();
    if (text.length > 2 * LIMITS.writeMax) throw Error('Response exceeds the local folder client limit.');
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* Non-JSON error page. */ }
    return {status: response.status, value};
  }
  async function content(request) {
    const response = await fetcher(`${base}/requests/${request.request_id}/content?connection_id=${connectionId}`, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: stopper.signal});
    if (!response.ok) throw new FolderError('browser_error');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Write exactly what the agent queued, as the server recorded it.
    if (bytes.length > LIMITS.writeMax || bytes.length !== request.content_bytes || await sha256(bytes, subtle) !== request.content_sha256) throw new FolderError('changed');
    return bytes;
  }
  async function upload(file, signal) {
    const status = await uploader.upload(file, crypto.randomUUID(), {requireIngest: true, signal});
    await uploader.attach(status, {signal});
    return status;
  }
  async function finish(request, body, status) {
    let reply = await call('POST', `${base}/requests/${request.request_id}/result`, {connection_id: connectionId, ...body});
    // The server could not find the prepared file (restart): prepare again once.
    if (reply.status === 409 && reply.value?.code === 'local_file_upload_not_ready' && status) {
      await uploader.attach(status, {signal: stopper.signal});
      reply = await call('POST', `${base}/requests/${request.request_id}/result`, {connection_id: connectionId, ...body});
    }
    return reply.status === 200;
  }
  async function perform(request, signal) {
    switch (request.operation) {
      case 'list': return {body: {outcome: 'done', listing: await listFolder(root, request.path)}};
      case 'hash': return {body: {outcome: 'done', hashes: await hashFiles(root, request.paths, subtle)}};
      case 'read': {
        const file = await readFile(root, request.path, LIMITS.readMax);
        if (!file.size) return {body: {outcome: 'done', empty: true, last_modified_ms: file.lastModified}};
        const status = await upload(file, signal);
        return {status, body: {outcome: 'done', upload_id: status.file.upload_id, last_modified_ms: file.lastModified}};
      }
      case 'package': {
        const {file, files} = await packageFiles(root, request.paths, packageName(request.request_id));
        const status = await upload(file, signal);
        return {status, body: {outcome: 'done', upload_id: status.file.upload_id, files}};
      }
      case 'write': return inOrder(async () => {
        // Dropped while an earlier write ran: it is never started.
        if (signal.aborted) throw new FolderError('browser_error');
        const bytes = await content(request);
        if (signal.aborted) throw new FolderError('browser_error');
        if (!await writable()) return {body: {outcome: 'failed', error: 'permission_denied'}};
        return {body: {outcome: 'done', written: await writeFile(root, request.path, bytes, subtle)}};
      });
      default: throw new FolderError('browser_error');
    }
  }
  // A request the server no longer gave this tab (expired, failed by a
  // revoke, finished elsewhere) before this tab produced an outcome for it.
  // A write that was already written says so: the agent was not told.
  const dropped = (request, done) => request.operation !== 'write' ? 'expired'
    : done?.body?.outcome === 'done' ? 'written, but expired before it was reported' : 'expired, nothing written';
  async function handle(request, entry) {
    let outcome, done = null;
    try {
      done = await perform(request, entry.controller.signal);
      if (entry.controller.signal.aborted) return;
      outcome = (await finish(request, done.body, done.status)) ? done.body.outcome === 'done' ? 'done' : done.body.error : 'not accepted';
    } catch (error) {
      if (entry.controller.signal.aborted || stopper.signal.aborted) return;
      const failure = code(error);
      outcome = failure;
      try { await finish(request, {outcome: 'failed', error: failure}); } catch { /* The next poll shows it again. */ }
    } finally {
      // The same request may have been offered again meanwhile: only this entry goes.
      if (active.get(request.request_id) === entry) active.delete(request.request_id);
      // Exactly one entry per request: an outcome this tab produced wins, and
      // nothing is recorded when the relay itself stopped.
      if (!outcome && entry.dropped && !stopper.signal.aborted) outcome = dropped(request, done);
      if (outcome) note(request, outcome);
      changed();
      // Take what the server queued behind this one now, not on the next tick.
      wake?.();
    }
  }
  async function pollOnce() {
    const reply = await call('POST', `${base}/poll`, {connection_id: connectionId, folder_name: folderName, ...(takeover ? {takeover: true} : {})});
    if (reply.status === 409 && reply.value?.code === 'local_files_connected_elsewhere') { state = 'elsewhere'; return false; }
    if (reply.status === 401 || reply.status === 403) { state = 'signed_out'; return false; }
    if (reply.status !== 200 || !Array.isArray(reply.value?.requests)) { state = 'retrying'; return true; }
    takeover = false; state = 'connected';
    const held = new Set(reply.value.requests.map(r => r.request_id));
    // A request that is no longer this tab's (expired, finished, taken by a
    // newer tab) is dropped here, and a write still waiting its turn is never
    // started. Its handler records the drop in the activity unless it already
    // has an outcome.
    for (const [id, entry] of active) if (!held.has(id)) { entry.dropped = true; entry.controller.abort(); active.delete(id); }
    for (const request of reply.value.requests) {
      if (active.has(request.request_id) || !uuid(request.request_id)) continue;
      const entry = {view: request, controller: new AbortController()};
      active.set(request.request_id, entry);
      void handle(request, entry);
    }
    return true;
  }
  async function loop() {
    while (!stopper.signal.aborted) {
      let more = true;
      try { more = await pollOnce(); }
      catch { if (stopper.signal.aborted) break; state = 'retrying'; }
      changed();
      if (!more) break;
      const pause = new AbortController(), abort = () => pause.abort();
      wake = abort;
      stopper.signal.addEventListener('abort', abort, {once: true});
      await wait(pollMs, pause.signal);
      stopper.signal.removeEventListener('abort', abort);
      wake = null;
    }
    for (const entry of active.values()) entry.controller.abort();
    active.clear();
  }
  return {
    snapshot,
    /** Start (or, with takeover, replace another tab's connection). */
    start({takeover: replace = false} = {}) {
      if (running) return running;
      takeover = replace; state = 'connecting'; changed();
      running = loop().finally(() => { running = null; changed(); });
      return running;
    },
    /** Poll now (the tab became visible again). */
    poke() { wake?.(); },
    async stop() { stopper.abort(); await running; },
    async disconnect() {
      stopper.abort();
      await running;
      state = 'disconnected';
      try {
        await fetcher(`${base}/disconnect`, {method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: {'x-orkestr-csrf': csrf, 'Content-Type': 'application/json'}, body: JSON.stringify({connection_id: connectionId})});
      } catch { /* The server also disconnects a tab that stops polling. */ }
      changed();
    },
  };
}
