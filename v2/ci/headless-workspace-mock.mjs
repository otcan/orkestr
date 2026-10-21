// Synthetic same-origin API for rendering the configured beta workspace in CI.
// Fake IDs and text only; no provider, credential or real server is involved.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';
export const C = '00000000-0000-4000-8000-00000000000c';
const LIMITS = { duration_ms: 900000, attempts: 32, bytes: 67108864, cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576 };
const names = { [A]: 'Assistant', [B]: 'Research notes', [C]: 'Queued errands' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function createState() {
  const archived = Array.from({ length: 60 }, (_, i) => ({
    archive_sequence: i + 1, source_instance: 'synthetic-v1', source_thread_id: 'thread-a', snapshot_id: 'snapshot-1',
    message: { source_message_id: `m${i + 1}`, source_position: i + 1, source_cursor: i + 1, role: i % 2 ? 'assistant' : 'user',
      phase: null, state: 'done', source_kind: null, created_at: '2026-01-01T00:00:00Z', updated_at: null,
      text: `Imported synthetic message ${i + 1}`, attachments: [] },
  }));
  const messages = { [A]: [{ message_id: uuid(101), sequence: 1, actor_kind: 'owner', text: 'Native synthetic message' }], [B]: [], [C]: [] };
  const window = {
    [A]: null,
    [B]: { window_id: uuid(201), conversation_id: B, generation: 1, state: 'active', input_message_id: uuid(202), input_event_id: uuid(203),
      predecessor_window_id: null, opened_at_ms: 1000, work_deadline_ms: 871000, expires_at_ms: 901000, limits: LIMITS },
    [C]: null,
  };
  const queued = { [C]: [{ conversation_id: C, request_key: 'synthetic-queued', input_message_id: uuid(301), input_event_id: uuid(302),
    input_request_key: 'synthetic-input', state: 'queued', position: 2, queued_at_ms: 2000, window_id: null, withdrawal: null }] };
  // windowMode: 'accept' admits; 'uncertain' answers 503 after the request is seen.
  return { archived, messages, window, queued, requests: [], intake: {}, windowPosts: [], windowMode: 'accept', windowDelayMs: 0, marks: [] };
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const missing = res => json(res, 404, { code: 'not_found', message: 'Endpoint not found', request_id: 'synthetic', retryable: false });

const body = req => new Promise(resolve => { let text = ''; req.on('data', c => { text += c; }); req.on('end', () => resolve(text)); });

async function intake(state, req, res, id) {
  if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
  const input = JSON.parse(await body(req));
  let receipt = state.intake[input.client_message_id];
  if (!receipt) {
    const sequence = state.messages[id].length + 1, n = 400 + Object.keys(state.intake).length * 2;
    receipt = { conversation: id, request: input.client_message_id, message_id: uuid(n), event_id: uuid(n + 1), sequence, status: 'accepted' };
    state.intake[input.client_message_id] = receipt;
    state.messages[id].push({ message_id: receipt.message_id, sequence, actor_kind: 'owner', text: input.text });
  }
  const { conversation, request, ...wire } = receipt;
  return json(res, 202, wire);
}

async function admit(state, req, res, id) {
  if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
  const request = JSON.parse(await body(req));
  state.windowPosts.push(request);
  if (state.windowDelayMs) await new Promise(resolve => setTimeout(resolve, state.windowDelayMs));
  if (state.windowMode === 'uncertain') return json(res, 503, { code: 'unavailable', message: 'Synthetic uncertainty' });
  const join = request.window_id !== null;
  const status = { window_id: join ? request.window_id : uuid(500 + state.windowPosts.length), conversation_id: id,
    generation: join ? request.expected_generation : request.expected_generation + 1, state: 'active',
    input_message_id: request.input_message_id, input_event_id: request.input_event_id, predecessor_window_id: null,
    opened_at_ms: 1000, work_deadline_ms: 871000, expires_at_ms: 901000, limits: LIMITS };
  state.window[id] = status;
  return json(res, 201, { status, input_message_id: request.input_message_id, input_event_id: request.input_event_id,
    input_request_key: request.input_request_key, request_key: request.request_key, duplicate: false });
}

// Synthetic live map: one live view with a running agent, one idle view, one delegated to B.
function liveMap() {
  const now = Date.now();
  const view = (name, thread, sessions, delegated = null) => ({ view: 'whatsapp-group', name, chat_id: `synthetic-${thread}`, thread_id: thread,
    fast_layer: 'V1 thread executor (Codex)', delegated_to_v2: delegated, sessions });
  return { schema_version: 1, observed_at_ms: now, conversations_truncated: false,
    host: { status: 'ready', generated_at_ms: now - 5000, modified_at_ms: now - 5000, views: [
      view('Busy synthetic group', 'thread-busy', [{ session_id: 'synthetic-session-live', kind: 'claude-code', role: 'attached', live: true, last_activity_ms: now - 3000,
        agents: [{ agent_id: 'a01', name: 'Synthetic running agent', status: 'running', started_at_ms: now - 60000, last_activity_ms: now - 2000 },
                 { agent_id: 'a02', name: 'Synthetic finished agent', status: 'finished', started_at_ms: now - 90000, last_activity_ms: now - 80000 }] }]),
      view('Quiet synthetic group', 'thread-quiet', [{ session_id: 'synthetic-session-idle', kind: 'codex', role: 'attached', live: false, last_activity_ms: null, agents: [] }]),
      view('Delegated synthetic group', 'thread-delegated', [], { remote_backend: 'v2', remote_thread_id: B, remote_runtime_enabled: true, conversation_id: B }),
    ] },
    conversations: [A, B, C].map(id => ({ conversation_id: id, name: names[id], partial: false, fast: null,
      deep: id === B ? { run_id: uuid(204), phase: 'running', observed_at_ms: now } : null,
      window: id === B ? { window_id: uuid(201), generation: 1, state: 'active', opened_at_ms: now - 10000, work_deadline_ms: now + 600000, expires_at_ms: now + 700000 } : null,
      workers: id === B ? [{ run_id: uuid(205), session_id: uuid(206), parent_run_id: uuid(204), state: 'running', recovery: 'current_incarnation' }] : [] })) };
}

// Synthetic sidebar: native conversations plus a linked V1 group (with a
// coordinator attached) and its worker sub-chat, newest activity first.
export const V1_GROUP = 'synthetic-group';
export const V1_WORKER = 'worker-synthetic-group-0001';
function sidebar(state) {
  const now = Date.now();
  const entry = (key, name, at, extra = {}) => ({ key, source: key.startsWith('v1:') ? 'v1' : 'v2', name,
    conversation_id: key.startsWith('v2:') ? key.slice(3) : null, v1_thread_id: key.startsWith('v1:') ? key.slice(3) : null,
    parent_key: null, last_activity_ms: at, preview: null, unread: 0, activity: { fast: false, deep: false, workers: 0 },
    read_only: key.startsWith('v1:'), coordinator: false, read_marker: 0, ...extra });
  const marked = key => state.marks.some(m => m.key === key);
  return { schema_version: 1, observed_at_ms: now, v1_status: 'ready', truncated: false, entries: [
    entry(`v1:${V1_WORKER}`, 'Synthetic group / Worker 1', now - 60000, { parent_key: `v1:${V1_GROUP}`, read_marker: 4,
      preview: { author: 'assistant', text: 'Synthetic worker progress' } }),
    entry(`v2:${B}`, names[B], now - 120000, { activity: { fast: false, deep: true, workers: 1 }, read_marker: 3,
      preview: { author: 'owner', text: 'Synthetic research question' } }),
    entry(`v1:${V1_GROUP}`, 'Synthetic group', now - 3 * 3600000, { coordinator: true, read_marker: 12,
      preview: { author: 'assistant', text: 'Synthetic coordinator reply' }, unread: marked(`v1:${V1_GROUP}`) ? 0 : 1 }),
    entry(`v2:${A}`, names[A], now - 26 * 3600000, { read_marker: state.messages[A].length,
      preview: { author: 'assistant', text: 'Synthetic assistant answer' }, unread: marked(`v2:${A}`) ? 0 : 2 }),
    entry(`v2:${C}`, names[C], now - 9 * 86400000, { unread: marked(`v2:${C}`) ? 0 : 3, read_marker: 0, preview: { author: 'assistant', text: 'Synthetic errand reply' } }),
  ] };
}

function v1History(thread) {
  const messages = thread === V1_GROUP ? [
    { message_id: 'v1-m10', author: 'owner', text: 'Synthetic owner question on V1', created_at_ms: Date.now() - 4 * 3600000, phase: null, cursor: 10 },
    { message_id: 'v1-m11', author: 'participant', text: 'Synthetic member note', created_at_ms: Date.now() - 3.5 * 3600000, phase: null, cursor: 11 },
    { message_id: 'v1-m12', author: 'assistant', text: 'Synthetic coordinator reply', created_at_ms: Date.now() - 3 * 3600000, phase: 'final_answer', cursor: 12 },
  ] : [];
  return { thread_id: thread, name: thread === V1_GROUP ? 'Synthetic group' : 'Synthetic group / Worker 1',
    coordinator: thread === V1_GROUP, messages, before_cursor: null, latest_cursor: messages.at(-1)?.cursor ?? 0 };
}

async function api(state, req, res, url) {
  const path = url.pathname, q = url.searchParams;
  state.requests.push(`${req.method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`);
  if (path === '/api/v2/browser/session' && req.method === 'GET') return json(res, 200, { csrf_token: 'synthetic-csrf', global_conversation_id: A });
  if (path === '/api/v2/beta') {
    const id = q.get('conversation_id') ?? A;
    if (!names[id]) return missing(res);
    return json(res, 200, { schema_version: 1, conversation_id: id, provider: 'codex', role: 'deep',
      controls: { stop: true, steer: true, accept: true }, limits: LIMITS, window: state.window[id] });
  }
  if (path === '/api/v2/live-map' && req.method === 'GET') return json(res, 200, liveMap());
  if (path === '/api/v2/sidebar' && req.method === 'GET') return json(res, 200, sidebar(state));
  if (path === '/api/v2/sidebar/read' && req.method === 'PUT') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const mark = JSON.parse(await body(req));
    state.marks.push(mark);
    return json(res, 200, mark);
  }
  const v1 = /^\/api\/v2\/v1-threads\/([A-Za-z0-9._:-]+)\/messages$/.exec(path);
  if (v1 && req.method === 'GET') {
    if (![V1_GROUP, V1_WORKER].includes(v1[1])) return missing(res);
    return json(res, 200, v1History(v1[1]));
  }
  if (path === '/api/v2/projects' && req.method === 'GET') return json(res, 200, { next_cursor: null, projects: [
    { project_id: uuid(601), conversation_id: C, name: 'Errand project', resources: { local_git: 'not_configured', local_oxrm: 'not_configured' } }] });
  if (path === '/api/v2/conversations' && req.method === 'GET') return json(res, 200, {
    conversations: [A, B, C].map((id, i) => ({ conversation_id: id, name: names[id], scope: { kind: 'global' }, last_sequence: state.messages[id].length + i })),
    next_cursor: null });
  const m = /^\/api\/v2\/conversations\/([0-9a-f-]{36})(\/.*)?$/.exec(path);
  if (!m || !names[m[1]]) return missing(res);
  const [, id, rest = ''] = m;
  if (rest === '' && req.method === 'GET') {
    const after = Number(q.get('after') ?? 0), rows = state.messages[id].filter(x => x.sequence > after);
    return json(res, 200, { conversation_id: id, scope: { kind: 'global' }, messages: rows, last_sequence: state.messages[id].length, next_cursor: null });
  }
  if (rest === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': synthetic keep-alive\n\n');
    return;
  }
  if (rest === '/archived-history' && req.method === 'GET') {
    if (id !== A) return json(res, 200, { conversation_id: id, entries: [], next_after: null });
    const after = Number(q.get('after')), limit = Number(q.get('limit'));
    const rows = state.archived.filter(x => x.archive_sequence > after).slice(0, limit);
    const more = state.archived.some(x => x.archive_sequence > (rows.at(-1)?.archive_sequence ?? after));
    return json(res, 200, { conversation_id: id, entries: rows, next_after: more ? rows.at(-1).archive_sequence : null });
  }
  if (rest === '/execution' && req.method === 'GET') {
    if (id !== B) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
    return json(res, 200, { schema_version: 1, conversation_id: B, run_id: uuid(204), revision: 3, observed_at_ms: Date.now(), phase: 'running',
      queue_age_ms: null, progress: null, resources: null, capabilities: { stop: true, steer: true } });
  }
  if (rest === '/messages' && req.method === 'POST') return intake(state, req, res, id);
  if (rest === '/window' && req.method === 'POST') return admit(state, req, res, id);
  if (rest === '/window' && req.method === 'GET') {
    if (!state.window[id]) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
    return json(res, 200, state.window[id]);
  }
  if (rest === '/window/queue') {
    const entries = state.queued[id] ?? [];
    return json(res, 200, { conversation_id: id, capacity: 2, active: 2, queued_total: 3, entries });
  }
  return missing(res);
}

export async function startMock(bundle, state = createState()) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return api(state, req, res, url);
    const file = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (file.includes('..')) return missing(res);
    try {
      const body = await readFile(join(bundle, file));
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { missing(res); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, state, origin: `http://127.0.0.1:${server.address().port}` };
}
