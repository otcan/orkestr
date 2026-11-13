// The Connect folder control states what it can do in words (ORK-786):
// unsupported, no folder, permission needed, worker offline, ready. Synthetic
// DOM, folder handle, storage and server only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {DENIED, folderState} from './folder_state.mjs';
import {mountLocalFiles} from './panel.mjs';
import {setTitleMark} from '../title_marks.mjs';

const CONVERSATION = '00000000-0000-4000-8000-00000000000a';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.parent = null; this.textContent = ''; const classes = new Set(); this.classList = {add: c => classes.add(c), contains: c => classes.has(c)}; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  append(...nodes) { for (const node of nodes) { node.remove?.(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; } }
  all() { return this.children.flatMap(n => [n, ...n.all()]); }
  text() { return [this.textContent, ...this.children.map(n => n.text())].join(' ').trim(); }
  find(predicate) { return this.all().find(predicate); }
  button(label) { return this.find(n => n.tag === 'button' && n.textContent === label); }
  state() { return this.find(n => n.attrs.class?.startsWith('local-folder-state')); }
}
const fakeDocument = () => ({title: 'Orkestr', visibilityState: 'visible', createElement: tag => new Node(tag), addEventListener() {}, removeEventListener() {}});
const handle = (name = 'Synthetic folder', permission = 'granted') => ({kind: 'directory', name, requestPermission: async () => permission});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (check, what) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail(`timed out: ${what}`); };
// A synthetic server: `status` decides every poll's answer.
function server(status = 200) {
  const server = {status, polls: 0};
  server.fetcher = async (path) => {
    if (path.endsWith('/poll')) server.polls++;
    const code = typeof server.status === 'function' ? server.status() : server.status;
    return new Response(code === 200 ? JSON.stringify({requests: []}) : '{}', {status: code});
  };
  return server;
}
// The least of IndexedDB the panel uses: one store, get/put/delete.
function memoryIndexedDB(initial = {}) {
  const data = new Map(Object.entries(initial));
  const request = run => { const r = {}; setTimeout(() => { r.result = run(); r.onsuccess?.(); }, 0); return r; };
  const db = {close() {}, transaction: () => ({objectStore: () => ({
    get: key => request(() => data.get(key)), put: (value, key) => request(() => data.set(key, value)), delete: key => request(() => data.delete(key)),
  })})};
  return {data, open: () => { const r = {result: db}; setTimeout(() => r.onsuccess?.(), 0); return r; }};
}
function mount({picker = async () => handle(), status = 200, indexedDB = null} = {}) {
  const document = fakeDocument(), root = new Node('div'), logRoot = new Node('div'), api = server(status);
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, logRoot}, {
    picker, indexedDB, document, uploader: {}, fetcher: api.fetcher, relayOptions: {pollMs: 5, wait: (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, {once: true}); })},
  });
  return {document, root, logRoot, api, panel};
}

test('folderState names every state in words', () => {
  assert.equal(folderState({supported: false}).state, 'unsupported');
  assert.deepEqual(folderState(), {state: 'none', text: 'No folder connected'});
  assert.match(folderState({view: {state: 'connected', folder: 'F'}}).text, /^Folder ready: “F” · read-only, writes ask you first$/);
  assert.equal(folderState({view: {state: 'connecting', folder: 'F'}}).state, 'connecting');
  for (const state of ['retrying', 'elsewhere', 'signed_out']) {
    const value = folderState({view: {state, folder: 'F'}});
    assert.equal(value.state, 'offline', state);
    assert.match(value.text, /^Folder worker offline/, state);
  }
  assert.deepEqual(folderState({saved: {name: 'F'}}), {state: 'permission', text: 'Permission needed: allow “F” again'});
  assert.equal(folderState({message: DENIED}).state, 'permission');
  // A disconnected relay with nothing remembered is simply no folder.
  assert.equal(folderState({view: {state: 'disconnected', folder: 'F'}}).state, 'none');
});

test('a browser without folder access says so and offers no Connect folder', () => {
  const {root, logRoot} = mount({picker: null});
  assert.equal(root.dataset.folderState, 'unsupported');
  assert.equal(root.state().attrs['data-state'], 'unsupported');
  assert.match(root.text(), /Folder access unavailable in this browser/);
  assert.match(root.text(), /need Chrome or Edge/);
  assert.equal(root.find(n => n.tag === 'button'), undefined, 'no control implies local access');
  assert.equal(logRoot.children.length, 0);
});

test('no folder, then ready after the owner connects, then no folder after disconnect; the log lives in the drawer', async () => {
  const {document, root, logRoot, api, panel} = mount();
  assert.equal(root.dataset.folderState, 'none');
  assert.equal(root.state().textContent, 'No folder connected');
  assert.equal(root.state().attrs.role, 'status');
  assert.equal(api.polls, 0, 'nothing is served before a click');
  assert.ok(logRoot.find(n => n.attrs.class === 'local-folder-log'), 'activity log is in the drawer');
  assert.equal(root.find(n => n.attrs.class === 'local-folder-log'), undefined, 'and not in the composer');
  await root.button('Connect folder…').onclick();
  await until(() => root.dataset.folderState === 'ready', 'ready');
  assert.match(root.state().textContent, /Folder ready: “Synthetic folder”/);
  assert.ok(root.state().attrs.class.includes('local-folder-live'));
  assert.ok(document.title.startsWith('● '));
  assert.ok(root.button('Disconnect folder'));
  await root.button('Disconnect folder').onclick();
  await until(() => root.dataset.folderState === 'none', 'none after disconnect');
  assert.match(root.text(), /Folder disconnected/);
  panel.close();
  assert.equal(logRoot.children.length, 0, 'closing removes the log');
});

test('the worker going offline is stated, and recovers to ready', async () => {
  let code = 200;
  const {root, api, panel} = mount({status: () => code});
  await root.button('Connect folder…').onclick();
  await until(() => root.dataset.folderState === 'ready', 'ready');
  code = 503;
  await until(() => root.dataset.folderState === 'offline', 'offline');
  assert.match(root.state().textContent, /^Folder worker offline: reconnecting “Synthetic folder”/);
  assert.ok(root.button('Disconnect folder'), 'the owner can still revoke');
  code = 200;
  await until(() => root.dataset.folderState === 'ready', 'ready again');
  assert.ok(api.polls > 2);
  panel.close();
});

test('another tab serving the folder is offline here, with Use this tab', async () => {
  const document = fakeDocument(), other = new Node('div');
  const fetcher = async () => new Response(JSON.stringify({code: 'local_files_connected_elsewhere'}), {status: 409});
  const view = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root: other}, {picker: async () => handle(), document, uploader: {}, fetcher, indexedDB: null});
  await other.button('Connect folder…').onclick();
  await until(() => other.dataset.folderState === 'offline', 'offline elsewhere');
  assert.match(other.state().textContent, /served by another tab/);
  assert.ok(other.button('Use this tab'));
  assert.ok(other.find(n => n.attrs.class === 'local-folder-log'), 'without a drawer the log stays in the control');
  view.close();
});

test('a remembered folder needs permission; a refusal keeps saying so', async () => {
  const saved = {handle: handle('Remembered', 'denied'), name: 'Remembered'};
  const indexedDB = memoryIndexedDB({[`conversation:${CONVERSATION}`]: saved});
  const {root, api, panel} = mount({indexedDB});
  await until(() => root.dataset.folderState === 'permission', 'permission');
  assert.equal(root.state().textContent, 'Permission needed: allow “Remembered” again');
  assert.ok(root.button('Reconnect “Remembered”'));
  assert.ok(root.button('Choose another folder…'));
  await root.button('Reconnect “Remembered”').onclick();
  await settle();
  assert.equal(root.dataset.folderState, 'permission');
  assert.equal(api.polls, 0, 'nothing is served without the browser permission');
  panel.close();
});

// A synthetic queue holding writes for the tab: poll lists the open ones,
// content serves their bytes, result records the tab's answer.
function writeQueue() {
  const requests = [], results = new Map();
  const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
  const fetcher = async (path, options = {}) => {
    const url = new URL(path, 'http://synthetic.invalid');
    if (url.pathname.endsWith('/poll')) return json({requests: requests.filter(r => r.state === 'working').map(({bytes, ...view}) => view), ttl_ms: 75000});
    const content = /\/requests\/([0-9a-f-]{36})\/content$/.exec(url.pathname);
    if (content) return new Response(requests.find(r => r.request_id === content[1]).bytes);
    const result = /\/requests\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
    if (result) {
      const request = requests.find(r => r.request_id === result[1]), body = JSON.parse(options.body);
      request.state = body.outcome; results.set(request.request_id, body);
      return json({request_id: request.request_id, state: body.outcome});
    }
    return json({connected: false});
  };
  return {fetcher, results,
    add(path, text) {
      const bytes = new TextEncoder().encode(text);
      const request = {request_id: randomUUID(), operation: 'write', path, paths: [], state: 'working', bytes,
        content_bytes: bytes.length, content_sha256: createHash('sha256').update(bytes).digest('hex')};
      requests.push(request);
      return request.request_id;
    },
    expire(id) { requests.find(r => r.request_id === id).state = 'failed'; }};
}
// Records the system notifications the panel raises.
function notificationsWith(permission) {
  const shown = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission() { throw Error('never asked for outside a click'); }
    constructor(title, options) { this.title = title; this.options = options; this.closed = false; shown.push(this); }
    close() { this.closed = true; }
  }
  return {FakeNotification, shown};
}

test('a waiting write marks the tab title and raises one notification; the title is restored exactly (ORK-804)', async t => {
  const document = fakeDocument(), root = new Node('div'), logRoot = new Node('div'), queue = writeQueue();
  const {FakeNotification, shown} = notificationsWith('granted');
  document.visibilityState = 'hidden';
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, logRoot}, {
    picker: async () => handle(), indexedDB: null, document, uploader: {}, fetcher: queue.fetcher, notifications: FakeNotification,
    relayOptions: {pollMs: 5}});
  t.after(() => panel.close());
  await root.button('Connect folder…').onclick();
  await until(() => root.dataset.folderState === 'ready', 'ready');
  assert.equal(document.title, '● Orkestr');
  const refused = queue.add('notes.txt', 'synthetic text');
  await until(() => root.button('Refuse'), 'confirmation');
  assert.equal(document.title, 'Approve write · ● Orkestr', 'a hidden tab says a write waits');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Approve write');
  assert.match(shown[0].options.body, /“notes\.txt” in “Synthetic folder”/);
  assert.equal(shown[0].options.tag, `orkestr-local-write-${refused}`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(shown.length, 1, 'one notification per waiting write, not per poll');
  root.button('Refuse').onclick();
  await until(() => queue.results.has(refused), 'refused');
  assert.equal(queue.results.get(refused).error, 'refused_by_owner');
  await until(() => document.title === '● Orkestr', 'mark cleared');
  assert.equal(shown[0].closed, true, 'the notification closes with the confirmation');
  // A write that expires before the owner answers closes its card and is
  // recorded once in the drawer's activity log.
  const expired = queue.add('later.txt', 'x');
  await until(() => root.button('Allow write'), 'second confirmation');
  assert.ok(document.title.startsWith('Approve write · '));
  queue.expire(expired);
  await until(() => !root.button('Allow write'), 'card closed');
  await until(() => logRoot.text().includes('write later.txt: expired, nothing written'), 'expired in the log');
  assert.equal(logRoot.text().match(/later\.txt/g).length, 1);
  assert.equal(queue.results.has(expired), false);
  assert.equal(document.title, '● Orkestr');
  assert.equal(shown[1].closed, true);
  // A third write is open when the panel closes: the title is exactly the page's again.
  queue.add('open.txt', 'y');
  await until(() => document.title.startsWith('Approve write · '), 'third waiting');
  panel.close();
  assert.equal(document.title, 'Orkestr');
});

test('without notification permission none is raised and none is asked for', async t => {
  const document = fakeDocument(), root = new Node('div'), queue = writeQueue();
  for (const permission of ['default', 'denied']) {
    const {FakeNotification, shown} = notificationsWith(permission);
    const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root}, {
      picker: async () => handle(), indexedDB: null, document, uploader: {}, fetcher: queue.fetcher, notifications: FakeNotification,
      relayOptions: {pollMs: 5}});
    t.after(() => panel.close());
    await root.button('Connect folder…').onclick();
    const id = queue.add(`${permission}.txt`, 'z');
    await until(() => root.button('Refuse'), 'confirmation');
    assert.equal(shown.length, 0, permission);
    root.button('Refuse').onclick();
    await until(() => queue.results.has(id), 'answered');
    panel.close();
    assert.equal(document.title, 'Orkestr');
  }
});

test('title marks from the panel and the app shell share one prefix and keep the page title', () => {
  const document = fakeDocument();
  setTitleMark(document, 'folder', true);
  setTitleMark(document, 'waiting', true);
  assert.equal(document.title, 'Approve write · ● Orkestr');
  // This tab's own waiting write and the server-wide signal say it once.
  setTitleMark(document, 'write', true);
  assert.equal(document.title, 'Approve write · ● Orkestr');
  setTitleMark(document, 'waiting', false);
  assert.equal(document.title, 'Approve write · ● Orkestr');
  // The page renames itself: the marks stay in front of the new title.
  document.title = 'Synthetic chat';
  setTitleMark(document, 'write', false);
  assert.equal(document.title, '● Synthetic chat');
  setTitleMark(document, 'folder', false);
  assert.equal(document.title, 'Synthetic chat');
  setTitleMark(document, 'folder', false);
  assert.equal(document.title, 'Synthetic chat', 'turning off an absent mark changes nothing');
  assert.throws(() => setTitleMark(document, 'other', true), /Unknown title mark/);
});
