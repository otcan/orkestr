// Synthetic server side of the local folder relay for the real browser UI:
// the queue a thread's requests wait in, the tab's poll/result/disconnect
// routes, and `enqueue` for the test acting as the thread. Not production
// acceptance; the Rust server's own rules are tested in its crates.
import {createHash, randomUUID} from 'node:crypto';

const json = (res, status, value) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
const read = async req => { const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packageName = id => `selection-${id.replaceAll('-', '').slice(0, 12)}.tar`;

export function localFilesMock(state) {
  // failPolls: answer polls 503, as when the tab cannot reach the server.
  // conversation: the one the connected tab polls for (ORK-804 waiting list).
  const lf = state.localFiles = {requests: [], results: new Map(), tab: null, folder: null, conversation: null, conversationName: 'Assistant',
    polls: 0, disconnects: 0, failPolls: false, waitingReads: 0,
    // The server's deadline passed before the tab answered (ORK-804).
    expire(id) { const r = lf.requests.find(x => x.request_id === id); r.state = 'failed'; r.error = 'expired'; r.finished_ms = Date.now(); },
    enqueue(operation, {path = null, paths = [], content = null} = {}) {
      const bytes = content === null ? null : Buffer.from(content);
      const request = {request_id: randomUUID(), operation, path, paths, state: 'queued', error: null, bytes,
        content_bytes: bytes?.length ?? null, content_sha256: bytes ? sha(bytes) : null,
        created_ms: Date.now(), deadline_ms: Date.now() + 120000, finished_ms: null, result: null, status_text: 'Queued'};
      lf.requests.push(request);
      return request.request_id;
    }};
  const view = ({bytes, ...request}) => request;
  return async (req, res, path) => {
    // ORK-804: every tab of the owner reads which chat has a write waiting.
    if (path === '/api/v2/local-files/waiting' && req.method === 'GET') {
      lf.waitingReads++;
      const open = lf.requests.filter(r => r.operation === 'write' && ['queued', 'working'].includes(r.state));
      json(res, 200, {conversations: lf.tab && lf.conversation && open.length ? [{conversation_id: lf.conversation, conversation_name: lf.conversationName,
        folder_name: lf.folder, writes: open.length, deadline_ms: Math.min(...open.map(r => r.deadline_ms))}] : []});
      return true;
    }
    const route = /^\/api\/v2\/conversations\/([0-9a-f-]{36})\/local-files(?:\/(poll|disconnect)|\/requests\/([0-9a-f-]{36})\/(content|result))?$/.exec(path);
    if (!route) return false;
    if (req.method !== 'GET' && req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') { json(res, 403, {code: 'csrf_rejected'}); return true; }
    const [, , action, id, sub] = route;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!action && !sub) { json(res, 200, {grant: {issued: true}, connection: lf.tab ? {folder_name: lf.folder, live: true} : null, requests: lf.requests.map(view)}); return true; }
    if (action === 'poll') {
      const body = JSON.parse(await read(req));
      lf.polls++;
      if (lf.failPolls) { json(res, 503, {code: 'synthetic_unavailable'}); return true; }
      if (lf.tab && lf.tab !== body.connection_id && !body.takeover) { json(res, 409, {code: 'local_files_connected_elsewhere'}); return true; }
      if (lf.tab !== body.connection_id) for (const r of lf.requests) if (r.state === 'working') r.state = 'queued';
      lf.tab = body.connection_id; lf.folder = body.folder_name; lf.conversation = route[1];
      for (const r of lf.requests) if (r.state === 'queued') { r.state = 'working'; r.holder = lf.tab; }
      json(res, 200, {requests: lf.requests.filter(r => r.state === 'working' && r.holder === lf.tab).map(({holder, ...r}) => view(r)), ttl_ms: 75000});
      return true;
    }
    if (action === 'disconnect') {
      const body = JSON.parse(await read(req));
      if (body.connection_id === lf.tab) {
        lf.tab = null; lf.disconnects++;
        for (const r of lf.requests) if (['queued', 'working'].includes(r.state)) { r.state = 'failed'; r.error = 'local_files_disconnected'; }
      }
      json(res, 200, {connected: false}); return true;
    }
    const request = lf.requests.find(r => r.request_id === id);
    const held = request && request.state === 'working' && request.holder === lf.tab;
    if (sub === 'content') {
      if (!held || request.operation !== 'write' || url.searchParams.get('connection_id') !== lf.tab) { json(res, 404, {code: 'not_found'}); return true; }
      res.writeHead(200, {'content-type': 'application/octet-stream'}); res.end(request.bytes); return true;
    }
    const body = JSON.parse(await read(req));
    if (!held || body.connection_id !== lf.tab) { json(res, 409, {code: 'local_file_request_not_held'}); return true; }
    if (body.upload_id) {
      // Like the server: only an upload it prepared, with the expected name.
      const upload = state.uploads.find(u => u.upload_id === body.upload_id);
      const expected = request.operation === 'package' ? packageName(request.request_id) : request.path.split('/').at(-1);
      if (!upload || upload.files[0].filename !== expected) { json(res, 409, {code: 'local_file_upload_not_ready'}); return true; }
    }
    if (request.operation === 'write' && body.outcome === 'done' && (body.written?.sha256 !== request.content_sha256 || body.written?.bytes_written !== request.content_bytes)) {
      json(res, 400, {code: 'invalid_local_file_request'}); return true;
    }
    request.state = body.outcome; request.error = body.error ?? null; request.finished_ms = Date.now();
    lf.results.set(request.request_id, body);
    json(res, 200, view(request)); return true;
  };
}
