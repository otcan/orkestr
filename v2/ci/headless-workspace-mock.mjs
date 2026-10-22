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

// Synthetic formatted messages: agent Markdown, WhatsApp-style emphasis, the
// relay's reply context and a JSON-escaped relay text.
const LONG_URL = 'https://example.invalid/synthetic/' + 'very-long-path-segment-'.repeat(8) + 'end?query=' + 'x'.repeat(40);
export const FORMATTED = {
  markdown: ['## Synthetic status', '', 'The **build** passed and the *deploy* is `pending`. See [the runbook](https://example.invalid/runbook).', '',
    '- First item with a long link ' + LONG_URL, '  - Nested item', '1. Ordered one', '2. Ordered two', '',
    '| Check | Result | Notes |', '|---|:---:|---|', '| rust-v2 | **green** | all 512 synthetic tests passed in the hosted runner |',
    '| browser | ~~red~~ green | a long note that makes this table wider than a phone screen on purpose |', '',
    '```sh', 'cargo test --offline --locked -p orkestr-v2-ui -- --nocapture --test-threads=1 # a very long synthetic command line', '```'].join('\n'),
  whatsapp: ['*Synthetic WhatsApp summary*', '', '\u2022\u2060  \u2060*Bold item* with _italic_ and ~strike~', '\u2022\u2060  \u2060Second item, snake_case_name stays', '',
    '```synthetic code with *stars* kept```'].join('\n'),
  reply: '[WhatsApp: synthetic-group]\n\n[Replying to Orkestr message from 15:23: "Synthetic quoted answer…"]\n\nWhich check was this? <b>not html</b>',
  escaped: '{"status":{"completed":"Synthetic notification.\\n\\n| Gene | rsID |\\n|---|---|\\n| SYN1 | rs0001 |\\n\\n**Done**"}}',
};

export function createState() {
  const archived = Array.from({ length: 60 }, (_, i) => ({
    archive_sequence: i + 1, source_instance: 'synthetic-v1', source_thread_id: 'thread-a', snapshot_id: 'snapshot-1',
    message: { source_message_id: `m${i + 1}`, source_position: i + 1, source_cursor: i + 1, role: i % 2 ? 'assistant' : 'user',
      phase: null, state: 'done', source_kind: null, created_at: '2026-01-01T00:00:00Z', updated_at: null,
      text: i === 49 ? FORMATTED.escaped : `Imported synthetic message ${i + 1}`, attachments: [] },
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
  return { archived, messages, window, queued, requests: [], intake: {}, intakePosts: [], intakeLoseNext: false, windowPosts: [], windowMode: 'accept', windowDelayMs: 0, marks: [],
    // v1Posts: every POST seen; v1Inputs: admitted once per key. The first post's answer is lost (504).
    v1Posts: [], v1Inputs: [], v1LoseFirst: true, v1Polls: 0, uploads: [],
    // "New WhatsApp chat": the first attempt stops at the adapter binding.
    chatPosts: [], chatStopFirst: true,
    // Chat settings, desktops and timers of conversation A.
    settings: { schema_version: 1, conversation_id: A, revision: 2, provider: 'codex', model: 'synthetic-model', reasoning_effort: 'medium',
      honor_no_reply: true, reply_prefix: 'synthetic:', reply_footer: null, provider_generation: 0, updated_at_ms: 1 },
    settingsPuts: [], bindingPuts: [], timerCalls: [], timerPause: null, chatTimerPause: null,
    // Linked V1 chat management (synthetic V1 state behind the server).
    v1Model: { model: 'synthetic-model', effort: 'low' }, v1Calls: [],
    v1Timers: [{ id: 'timer-1', label: 'Synthetic digest', cadence: 'daily', time: '08:00', every: null, timezone: 'Europe/Berlin',
      run_at: null, prompt: 'Synthetic prompt', enabled: true, owned_by_v2: false, next_run_at: '2026-01-02T07:00:00Z', last_run_at: null, last_error: null }],
    v1WhatsApp: { reply_prefix: 'synthetic:', suppress_updates: true, suppress_debug_footer: false, additional_participants_enabled: false, additional_participant_ids: [] } };
}

// Synthetic host metrics: a fixed 12-core host with gentle waves; the 7 d
// range has history only for its last part ("collecting" shading).
const GIB = 1024 ** 3, HOST_STEPS = { '15m': 5000, '1h': 10000, '24h': 300000, '7d': 1800000 };
const HOST_SPAN = { '15m': 900000, '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const wave = (i, n) => 30 + 20 * Math.sin(i / 7 + n);
function hostSummary() {
  const spark = Array.from({ length: 60 }, (_, i) => Math.round(wave(i, 0) * 10) / 10);
  return { schema_version: 1, collecting: false, observed_at_ms: Date.now() - 2000, interval_ms: 5000, cores: 12, cpu_percent: 31.5,
    memory_used_bytes: 24 * GIB, memory_total_bytes: 64 * GIB, disk_used_bytes: 600 * GIB, disk_free_bytes: 200 * GIB, disk_total_bytes: 846 * GIB,
    spark_cpu: spark, spark_memory: spark.map(() => 37.5), spark_disk: spark.map(() => 75),
    swap_used_bytes: 2 * GIB, swap_total_bytes: 32 * GIB, load: [3.1, 2.8, 2.5],
    mounts: hostDisks().mounts, cpu_cores_percent: Array.from({ length: 12 }, (_, c) => Math.round(wave(c, c))),
    disk_read_bps: 2e5, disk_write_bps: 1.5e6, net_rx_bps: 3e4, net_tx_bps: 2e4 };
}
function hostConsumers() {
  const spark = Array.from({ length: 30 }, (_, i) => Math.round(wave(i, 1) / 5 * 10) / 10);
  const row = (key, kind, label, extra) => ({ key, kind, label, conversation_id: null, roles: [], cpu_percent: 4.2, cores: 0.5,
    rss_bytes: 2 * GIB, io_read_bps: 1000, io_write_bps: 4000, processes: 3, top_command: 'node', spark_cpu: spark, ...extra });
  return { schema_version: 1, collecting: false, observed_at_ms: Date.now() - 3000, interval_ms: 10000, cores: 12, consumers: [
    row(`conversation:${A}`, 'conversation', 'Assistant', { conversation_id: A, roles: ['deep', 'fast'], cpu_percent: 12.5, cores: 1.5 }),
    row('service:synthetic-v1.service', 'service', 'Synthetic V1 UI', {}),
    row('workspace:synthetic-pa', 'workspace', 'Workspace synthetic-pa', { io_read_bps: null, io_write_bps: null }),
  ] };
}
function hostDisks() {
  return { schema_version: 1,
    mounts: [{ mount: '/', fs_type: 'ext4', device: '/dev/synthetic', total_bytes: 846 * GIB, used_bytes: 600 * GIB, free_bytes: 200 * GIB }],
    directories: { observed_at_ms: Date.now() - 600000, running: false, readable_bytes: 400 * GIB,
      entries: [{ path: '/home', bytes: 200 * GIB }, { path: '/opt', bytes: 60 * GIB }, { path: '/var', bytes: 40 * GIB }] } };
}
function hostHistory(range) {
  const step = HOST_STEPS[range], now = Math.floor(Date.now() / step) * step;
  const count = Math.min(range === '7d' ? 200 : 360, HOST_SPAN[range] / step);
  const points = Array.from({ length: count }, (_, k) => {
    const i = k - count + 1, cpu = wave(i, 0);
    return { t_ms: now + i * step, cpu, cores: Array.from({ length: 12 }, (_, c) => Math.max(0, Math.min(100, wave(i, c)))),
      load1: cpu / 8, load5: cpu / 9, load15: cpu / 10, mem_used: 24 * GIB, mem_cache: 30 * GIB, swap_used: 2 * GIB, disk_used: 600 * GIB,
      disk_read_bps: 2e5, disk_write_bps: 1.5e6, net_rx_bps: 3e4, net_tx_bps: 2e4, req_rate: 1.5, req_p50_ms: 2, req_p95_ms: 40 + cpu, req_error_rate: 0 };
  });
  return { schema_version: 1, range, step_ms: step, collecting: false, observed_at_ms: now, history_from_ms: points[0].t_ms, cores: 12,
    memory_total_bytes: 64 * GIB, swap_total_bytes: 32 * GIB, disk_total_bytes: 846 * GIB, points,
    services: [{ label: 'Synthetic adapter', unit: 'synthetic-adapter.service', state: 'active', sub_state: 'running', result: 'success', since_ms: now - 3600000, restarts: 0, healthy: true },
      { label: 'Synthetic probe', unit: 'synthetic-probe.service', state: 'failed', sub_state: 'failed', result: 'exit-code', since_ms: now - 60000, restarts: 0, healthy: false }],
    services_observed_at_ms: now };
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
    state.messages[id].push({ message_id: receipt.message_id, sequence, actor_kind: 'owner', text: input.text, ...(input.reply_to ? { reply_to: input.reply_to } : {}) });
  }
  state.intakePosts.push({ conversation: id, ...input });
  // Admitted, but the answer is lost: the client must retry with the same key.
  if (state.intakeLoseNext) { state.intakeLoseNext = false; return json(res, 504, { code: 'unavailable', message: 'Synthetic lost answer' }); }
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
// Synthetic V1 public references of old deep links.
export const V1_INSTANCE_REF = 'ins_AAAAAAAAAAAAAAAAAAAAAA';
export const V1_LINKS = { group: 'thr_AAAAAAAAAAAAAAAAAAAAAQ', migrated: 'thr_AAAAAAAAAAAAAAAAAAAAAg', unknown: 'thr_AAAAAAAAAAAAAAAAAAAAAw' };
function sidebar(state) {
  const now = Date.now();
  const entry = (key, name, at, extra = {}) => ({ key, source: key.startsWith('v1:') ? 'v1' : 'v2', name,
    conversation_id: key.startsWith('v2:') ? key.slice(3) : null, v1_thread_id: key.startsWith('v1:') ? key.slice(3) : null,
    parent_key: null, last_activity_ms: at, preview: null, unread: 0, activity: { fast: false, deep: false, workers: 0 },
    read_only: key.startsWith('v1:'), coordinator: false, read_marker: 0, ...extra });
  const marked = key => state.marks.some(m => m.key === key);
  if (state.sidebarEntries) return { schema_version: 1, observed_at_ms: now, v1_status: 'ready', truncated: false,
    entries: state.sidebarEntries(entry, now) };
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

function v1History(state, thread) {
  const messages = thread === V1_GROUP ? [
    { message_id: 'v1-m10', author: 'owner', text: 'Synthetic owner question on V1', created_at_ms: Date.now() - 4 * 3600000, phase: null, cursor: 10 },
    { message_id: 'v1-m11', author: 'participant', text: 'Synthetic member note', created_at_ms: Date.now() - 3.5 * 3600000, phase: null, cursor: 11 },
    { message_id: 'v1-m12', author: 'assistant', text: 'Synthetic coordinator reply', created_at_ms: Date.parse('2025-07-01T14:42:05Z'), phase: 'final_answer', cursor: 12,
      receipts: [{ kind: 'sent_to_whatsapp', at_ms: Date.parse('2025-07-01T14:42:09Z') }] },
  ] : thread === V1_WORKER ? [
    { message_id: 'v1-w1', author: 'owner', text: FORMATTED.reply, created_at_ms: Date.now() - 3 * 3600000, phase: null, cursor: 1 },
    { message_id: 'v1-w2', author: 'participant', text: FORMATTED.whatsapp, created_at_ms: Date.now() - 2 * 3600000, phase: null, cursor: 2 },
    { message_id: 'v1-w3', author: 'assistant', text: FORMATTED.markdown, created_at_ms: Date.now() - 3600000, phase: 'final_answer', cursor: 3 },
  ] : [];
  // After owner input from the app: V1 works for two polls, then the
  // coordinator's reply appears.
  const inputs = state.v1Inputs.filter(x => x.thread === thread);
  inputs.forEach((x, i) => messages.push({ message_id: `v1-input-${i}`, author: 'owner', text: x.text, created_at_ms: Date.now() - 1000, phase: null, cursor: 20 + 2 * i }));
  let working = false;
  if (inputs.length) {
    state.v1Polls += 1;
    working = state.v1Polls <= 2;
    if (!working) messages.push({ message_id: 'v1-coordinator', author: 'assistant', text: 'Synthetic coordinator answer', created_at_ms: Date.now(), phase: 'final_answer', cursor: 21, coordinator: true });
  }
  messages.sort((a, b) => a.cursor - b.cursor);
  return { thread_id: thread, name: thread === V1_GROUP ? 'Synthetic group' : 'Synthetic group / Worker 1',
    coordinator: thread === V1_GROUP, messages, before_cursor: null, latest_cursor: messages.at(-1)?.cursor ?? 0,
    writable: true, working };
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
  if (path === '/api/v2/host-metrics' && req.method === 'GET') return json(res, 200, hostSummary());
  if (path === '/api/v2/host-metrics/consumers' && req.method === 'GET') return json(res, 200, hostConsumers());
  if (path === '/api/v2/host-metrics/disks' && req.method === 'GET') return json(res, 200, hostDisks());
  if (path === '/api/v2/host-metrics/history' && req.method === 'GET') {
    const range = q.get('range');
    if (!HOST_STEPS[range]) return json(res, 400, { code: 'invalid_range', message: 'Range', request_id: 'synthetic', retryable: false });
    return json(res, 200, hostHistory(range));
  }
  if (path === '/api/v2/sidebar' && req.method === 'GET') return json(res, 200, sidebar(state));
  if (path === '/api/v2/sidebar/read' && req.method === 'PUT') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const mark = JSON.parse(await body(req));
    state.marks.push(mark);
    return json(res, 200, mark);
  }
  if (path === '/api/v2/whatsapp-chats' && req.method === 'GET')
    return json(res, 200, { available: true, providers: ['codex', 'claude'], participants: 2, provisions: [] });
  if (path === '/api/v2/whatsapp-chats' && req.method === 'POST') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const request = JSON.parse(await body(req));
    state.chatPosts.push(request);
    const D = uuid(901);
    names[D] = request.name; state.messages[D] = state.messages[D] ?? []; state.window[D] = null;
    const stopped = state.chatStopFirst; state.chatStopFirst = false;
    return json(res, stopped ? 202 : 201, { client_request_id: request.client_request_id, conversation_id: D, name: request.name,
      v1_thread_id: 'synthetic-new-thread', remote_thread_id: uuid(902), workspace: request.workspace ?? null,
      chat_id: '120000000000000009@g.us', stage: stopped ? 'group' : 'relay_pending', error: stopped ? 'adapter_binding_conflict' : null,
      archived: false, created_at_ms: Date.now(), updated_at_ms: Date.now() });
  }
  const link = /^\/api\/v2\/v1-links\/(thr_[A-Za-z0-9_-]{22})$/.exec(path);
  if (link && req.method === 'GET') {
    if (q.get('instance') !== V1_INSTANCE_REF) return missing(res);
    if (link[1] === V1_LINKS.group) return json(res, 200, { kind: 'v1_thread', thread_id: V1_GROUP });
    if (link[1] === V1_LINKS.migrated) return json(res, 200, { kind: 'conversation', conversation_id: B });
    return json(res, 404, { code: 'not_found', message: 'Link not found' });
  }
  const manage = /^\/api\/v2\/v1-threads\/([A-Za-z0-9._:-]+)\/(settings|whatsapp|desktops|timers)(?:\/([A-Za-z0-9._:-]+)(?:\/(pause|resume))?)?$/.exec(path);
  if (manage) {
    const [, thread, area, timer, action] = manage;
    if (thread !== V1_GROUP) return missing(res);
    if (req.method !== 'GET' && req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const input = req.method === 'GET' || req.method === 'DELETE' ? null : JSON.parse(await body(req) || '{}');
    state.v1Calls.push({ method: req.method, area, timer: timer ?? null, action: action ?? null, input });
    if (area === 'settings') {
      if (req.method === 'PUT') state.v1Model = { model: input.model, effort: input.effort };
      return json(res, 200, { thread_id: thread, ...state.v1Model, read_only: false, read_only_reason: null,
        models: [{ id: 'synthetic-model', efforts: ['low', 'high'], default_effort: 'low' }, { id: 'synthetic-large', efforts: ['medium'], default_effort: 'medium' }] });
    }
    if (area === 'whatsapp') {
      if (req.method === 'PUT') state.v1WhatsApp = input;
      return json(res, 200, { thread_id: thread, chat_id: '000@g.us', display_name: 'Synthetic group', enabled: true, delegated: false, ...state.v1WhatsApp });
    }
    if (area === 'desktops') return json(res, 200, { thread_id: thread, grants: [{ slug: 'synthetic-desk', permissions: ['discover', 'acquire'], expires_at: null }], leases: [] });
    if (!timer && req.method === 'GET') return json(res, 200, { thread_id: thread, timers: state.v1Timers });
    if (!timer && req.method === 'POST') {
      const created = { id: `timer-${state.v1Timers.length + 1}`, label: input.label, cadence: input.cadence, time: input.time ?? null, every: input.every ?? null,
        timezone: input.timezone ?? null, run_at: input.run_at ?? null, prompt: input.prompt, enabled: true, owned_by_v2: false, next_run_at: null, last_run_at: null, last_error: null };
      state.v1Timers.push(created); return json(res, 201, created);
    }
    const index = state.v1Timers.findIndex(t => t.id === timer);
    if (index < 0) return missing(res);
    if (req.method === 'DELETE') { state.v1Timers.splice(index, 1); res.writeHead(204); return res.end(); }
    if (action) state.v1Timers[index].enabled = action === 'resume';
    return json(res, 200, state.v1Timers[index]);
  }
  // V1 chat icons: any listed V1 thread gets the V1 design (synthetic SVG here).
  const icon = /^\/api\/v2\/thread-icons\/([A-Za-z0-9._:-]+)$/.exec(path);
  if (icon && req.method === 'GET') {
    if (![V1_GROUP, V1_WORKER].includes(icon[1])) return missing(res);
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=3600' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#061006"/><text x="32" y="38" fill="#25d366" font-size="12" text-anchor="middle">ORKESTR</text></svg>');
  }
  // Attach / Paste text: native uploads return the model note; V1 uploads return ids.
  const upload = /^\/api\/v2\/(?:conversations\/([0-9a-f-]{36})\/message-attachments|v1-threads\/([A-Za-z0-9._:-]+)\/uploads)$/.exec(path);
  if (upload && req.method === 'POST') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const request = JSON.parse(await body(req));
    state.uploads.push({ target: upload[1] ?? `v1:${upload[2]}`, ...request });
    const attachments = request.files.map((f, i) => ({ attachment_id: uuid(700 + state.uploads.length * 10 + i), filename: f.filename,
      media_type: f.media_type, byte_length: Buffer.from(f.content_base64, 'base64').length }));
    const note = upload[1] ? `[Files attached in the Orkestr app, manifest ${uuid(799)}:\n` +
      attachments.map(a => `- ${a.filename} (${a.media_type}, ${a.byte_length} bytes, reference ${a.attachment_id}, local file /synthetic/attachments/${a.filename})`).join('\n') + ']' : '';
    return json(res, 200, { manifest_id: upload[1] ? uuid(799) : null, attachments, note });
  }
  const v1 = /^\/api\/v2\/v1-threads\/([A-Za-z0-9._:-]+)\/messages$/.exec(path);
  if (v1 && req.method === 'GET') {
    if (![V1_GROUP, V1_WORKER].includes(v1[1])) return missing(res);
    return json(res, 200, v1History(state, v1[1]));
  }
  if (v1 && req.method === 'POST') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    if (![V1_GROUP, V1_WORKER].includes(v1[1])) return missing(res);
    const input = JSON.parse(await body(req));
    state.v1Posts.push({ thread: v1[1], ...input });
    let index = state.v1Inputs.findIndex(x => x.thread === v1[1] && x.client_message_id === input.client_message_id);
    const duplicate = index >= 0;
    if (!duplicate) { state.v1Inputs.push({ thread: v1[1], ...input }); index = state.v1Inputs.length - 1; }
    if (state.v1LoseFirst) { state.v1LoseFirst = false; return json(res, 504, { code: 'v1_receipt_unknown', message: 'V1 did not confirm.' }); }
    return json(res, duplicate ? 200 : 202, { thread_id: v1[1], message_id: `v1-input-${index}`, duplicate, state: 'queued' });
  }
  if (path === '/api/v2/recipes' && req.method === 'GET') return json(res, 200, { recipes: [{ id: 'job-tracker', version: '1.0.0', title: 'Job tracking',
    summary: 'Synthetic recipe.', conversation_name: 'Job tracker', timers: [{ label: 'Check job mail', schedule: 'hourly at :00, Mon-Fri, 09:00-20:00', silent_unless_changed: true }], mail: 'thunderbird' }] });
  if (path === '/api/v2/projects' && req.method === 'GET') return json(res, 200, { next_cursor: null, projects: [
    { project_id: uuid(601), conversation_id: C, name: 'Errand project', resources: { local_git: 'not_configured', local_oxrm: 'not_configured' } }] });
  if (path === '/api/v2/conversations' && req.method === 'GET') return json(res, 200, {
    conversations: [A, B, C].map((id, i) => ({ conversation_id: id, name: names[id], scope: { kind: 'global' }, last_sequence: state.messages[id].length + i })),
    next_cursor: null });
  const calendar = /^\/api\/v2\/timers\/(calendar(?:\/preview)?|[0-9a-f-]{36}\/(?:pause|policy|schedule))$/.exec(path);
  if (calendar) {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const request = JSON.parse(await body(req)); state.timerCalls.push({ route: calendar[1].replace(/[0-9a-f-]{36}/, ':id'), method: req.method, ...request });
    if (calendar[1] === 'calendar/preview') return json(res, 200, { summary: 'Hourly at :00', runs_ms: [1, 2, 3],
      runs_local: ['Wed 21 Oct 14:00 CEST', 'Wed 21 Oct 15:00 CEST', 'Wed 21 Oct 16:00 CEST'] });
    if (calendar[1].endsWith('/pause')) { state.timerPause = request.until_ms; return json(res, 200, { revision: 4, pause_until_ms: request.until_ms }); }
    return json(res, 200, calendar[1] === 'calendar' ? { namespace: uuid(703), state: 'enabled' } : { revision: 4 });
  }
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
  // Message times: the first native message has a fixed past time (Berlin summer).
  if (rest === '/message-times' && req.method === 'GET') {
    const after = Number(q.get('after') ?? 0);
    const times = state.messages[id].filter(m => m.sequence > after).map(m => ({ sequence: m.sequence, kind: 'input',
      at_ms: m.sequence === 1 ? Date.parse('2025-07-01T14:42:05Z') : Date.now(), receipts: [] }));
    return json(res, 200, { conversation_id: id, times, next_after: null });
  }
  // Conversation posts: none in the synthetic workspace.
  if (rest === '/posts' && req.method === 'GET') return json(res, 200, { conversation_id: id, posts: [] });
  // Tracker: not set up in the synthetic workspace (the tab offers recipes).
  if (rest === '/tracker' && req.method === 'GET') return json(res, 409, { code: 'tracker_not_enabled', message: 'Precondition refused', request_id: 'synthetic', retryable: false });
  // V1 workers of the linked V1 thread (Research notes only): one working
  // worker, one nested idle worker and one retired worker.
  if (rest === '/v1-workers' && req.method === 'GET') {
    const now = Date.now();
    const worker = (n, parent, depth, state, extra = {}) => ({ thread_id: `worker-${V1_GROUP}-000${n}`, name: `Synthetic V1 worker ${n}`,
      parent_thread_id: parent, depth, state, last_activity_ms: now - n * 60000, preview: null, openable: state !== 'retired', conversation_id: null, ...extra });
    return json(res, 200, { schema_version: 1, observed_at_ms: now, conversation_id: id, v1_thread_id: id === B ? V1_GROUP : null,
      v1_status: 'ready', retired: id === B ? 1 : 0, truncated: false, workers: id !== B ? [] : [
        worker(1, V1_GROUP, 1, 'working', { preview: { author: 'assistant', text: 'Synthetic V1 worker progress' } }),
        worker(2, `worker-${V1_GROUP}-0001`, 2, 'idle'),
        worker(3, V1_GROUP, 1, 'retired'),
      ] });
  }
  if (rest === '/execution' && req.method === 'GET') {
    if (id !== B) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
    return json(res, 200, { schema_version: 1, conversation_id: B, run_id: uuid(204), revision: 3, observed_at_ms: Date.now(), phase: 'running',
      queue_age_ms: null, progress: null, resources: null, capabilities: { stop: true, steer: true } });
  }
  if (rest === '/settings' && req.method === 'GET') return json(res, 200, { ...state.settings, conversation_id: id });
  if (rest === '/settings' && req.method === 'PUT') {
    const update = JSON.parse(await body(req)); state.settingsPuts.push(update);
    if (update.expected_revision !== state.settings.revision) return json(res, 409, { code: 'settings_revision_conflict', message: 'Settings changed elsewhere.' });
    const { expected_revision, ...fields } = update;
    state.settings = { ...state.settings, ...fields, revision: state.settings.revision + 1 };
    return json(res, 200, state.settings);
  }
  if (rest === '/desktops' && req.method === 'GET') return json(res, 200, { schema_version: 1, conversation_id: id,
    binding: { schema_version: 1, conversation_id: id, revision: 1, v1_thread_id: 'synthetic-thread', desktop_slugs: ['synthetic-desk'], grant_issued: false, grant_generation: 0 },
    leases: [{ conversation_id: id, desktop_slug: 'synthetic-desk', v1_thread_id: 'synthetic-thread', v1_lease_id: 'lease-1', fencing_version: 1,
      state: 'active', expires_at: '2026-01-01T00:10:00Z', acquired_at_ms: 1, heartbeat_at_ms: 2, ended_at_ms: null, end_reason: null }] });
  if (rest === '/desktop-binding' && req.method === 'PUT') {
    const request = JSON.parse(await body(req)); state.bindingPuts.push(request);
    return json(res, 200, { schema_version: 1, conversation_id: id, revision: request.expected_revision + 1, v1_thread_id: request.v1_thread_id,
      desktop_slugs: request.desktop_slugs, grant_issued: false, grant_generation: 0 });
  }
  if (rest === '/timers' && req.method === 'GET') return json(res, 200, { conversation_id: id, pause_until_ms: id === A ? state.chatTimerPause : null,
    pause_until_local: state.chatTimerPause ? 'Thu 22 Oct 09:00 CEST' : null, digests: id !== A ? [] : [
      { id: uuid(711), namespace: uuid(702), slot_ms: 1000, text: 'Digest: Synthetic triage - 3 quiet runs since the last digest.\nNothing new in 3 runs.', item_count: 3, created_ms: 2000, delivered_ms: null }],
    timers: id !== A ? [] : [
    { namespace: uuid(702), source_digest: 'synthetic-calendar', schedule: { kind: 'calendar', timezone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5],
        start_minute: 480, end_minute: 1140, every_hours: 1, minutes: [0], summary: 'Hourly at :00, Mon\u2013Fri, 08:00\u201319:00 Europe/Berlin' },
      conversation_id: id, state: 'enabled', dormant_reason: null, revision: 2, generation: 1, next_due_ms: Date.now() + 1800000,
      controller_armed: true, controller_hold: null, label: 'Synthetic triage', source_thread_id: 'orkestr:calendar', source_namespace: 'orkestr:calendar',
      source_timer_id: uuid(702), source_enabled: false, native: true,
      policy: { revision: 3, silent_mode: 'unless_changed', pause_until_ms: state.timerPause, skip_dates: ['2026-12-25'], skip_timezone: null,
        digest: { timezone: 'Europe/Berlin', minutes: [540] }, digest_since_ms: 1, trigger: null, updated_ms: 1 },
      stats: { last_kind: 'silent', last_summary: 'no news', last_at_ms: Date.now() - 3600000, silent_runs: 4, total_runs: 9 },
      next_due_local: 'Wed 21 Oct 14:00 CEST', last_result_local: 'Wed 21 Oct 13:00 CEST', pause_until_local: state.timerPause ? 'Thu 22 Oct 09:00 CEST' : null },
    { namespace: uuid(701), source_digest: 'synthetic-digest', schedule: { kind: 'zoned_clock', timezone: 'Europe/Berlin', weekday: null, minute_of_day: 420 },
      conversation_id: id, state: 'enabled', dormant_reason: null, revision: 3, generation: 2, next_due_ms: Date.now() + 3600000,
      controller_armed: true, controller_hold: null, label: 'Synthetic morning brief', source_thread_id: 'synthetic-thread',
      source_namespace: 'synthetic', source_timer_id: 'timer-1', source_enabled: true }] });
  if (rest === '/timer-pause' && req.method === 'POST') {
    if (req.headers['x-orkestr-csrf'] !== 'synthetic-csrf') return json(res, 403, { code: 'csrf', message: 'CSRF required' });
    const request = JSON.parse(await body(req)); state.timerCalls.push({ scope: 'chat', ...request });
    state.chatTimerPause = request.until_ms; return json(res, 200, { pause_until_ms: request.until_ms });
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
    const deep = /^\/instance\/(ins_[A-Za-z0-9_-]{22})\/thread\/(thr_[A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (deep) { res.writeHead(303, { location: `/#v1-link/${deep[1]}/${deep[2]}`, 'cache-control': 'no-store' }); return res.end(); }
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
