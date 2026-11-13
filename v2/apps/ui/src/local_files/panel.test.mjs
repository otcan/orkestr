// The Connect folder control states what it can do in words (ORK-786):
// unsupported, no folder, permission needed, worker offline, ready. Synthetic
// DOM, folder handle, storage and server only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {DENIED, folderState} from './folder_state.mjs';
import {mountLocalFiles} from './panel.mjs';
import {setTitleMark} from '../title_marks.mjs';
import {fakeDirectory} from '../../../../ci/local-files-fake-directory.mjs';

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
  assert.equal(folderState({view: {state: 'connected', folder: 'F'}}).text, 'Folder connected: “F” · this chat can read and change files in it');
  assert.equal(folderState({view: {state: 'connected', folder: 'F'}, writable: false}).text, 'Folder connected read-only: “F” · writes are refused until you allow changes');
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
  assert.match(root.state().textContent, /Folder connected: “Synthetic folder” · this chat can read and change files in it/);
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

// ORK-810: Connect asks for view-and-change once; writes then apply on their own.
test('Connect asks once for read and write; a write applies with no card, notification or title mark', async t => {
  const document = fakeDocument(), root = new Node('div'), chipRoot = new Node('span'), queue = writeQueue();
  const folder = fakeDirectory({'notes.txt': 'old'}, {name: 'Synthetic folder'}), pickerCalls = [];
  // Like Chrome: the picker's readwrite mode grants view and change in that click.
  const picker = async options => { pickerCalls.push(options); if (options.mode === 'readwrite') folder.fake.permissions.readwrite = 'granted'; return folder; };
  document.visibilityState = 'hidden';
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, chipRoot}, {
    picker, indexedDB: null, document, uploader: {}, fetcher: queue.fetcher, relayOptions: {pollMs: 5}});
  t.after(() => panel.close());
  await chipRoot.find(n => n.attrs.class === 'local-folder-chip').onclick();
  await until(() => root.dataset.folderState === 'ready', 'ready');
  assert.deepEqual(pickerCalls, [{id: 'orkestr-local-folder', mode: 'readwrite'}]);
  assert.equal(document.title, '● Orkestr');
  const written = queue.add('notes.txt', 'synthetic text');
  await until(() => queue.results.has(written), 'written without an answer from the owner');
  assert.equal(queue.results.get(written).outcome, 'done');
  assert.equal(folder.fake.text('notes.txt'), 'synthetic text');
  assert.equal(root.find(n => n.attrs.class === 'local-folder-confirm') ?? chipRoot.find(n => n.attrs.class === 'local-folder-confirm'), undefined, 'no card');
  assert.equal(document.title, '● Orkestr', 'no "Approve write" mark');
  await until(() => root.text().includes('write notes.txt (14 bytes): written'), 'logged with its size');
  assert.ok(root.find(n => n.tag === 'time' && /^ · \d{2}:\d{2}/.test(n.textContent)), 'with its time');
  panel.close();
  assert.equal(document.title, 'Orkestr');
});

test('a browser that grants viewing only: read-only, writes refused, Allow changes asks in a click', async t => {
  const document = fakeDocument(), root = new Node('div'), queue = writeQueue();
  const folder = fakeDirectory({'a.txt': 'alpha'}, {name: 'Synthetic folder', grantOnRequest: false});
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root}, {
    picker: async () => folder, indexedDB: null, document, uploader: {}, fetcher: queue.fetcher, relayOptions: {pollMs: 5}});
  t.after(() => panel.close());
  await root.button('Connect folder…').onclick();
  await until(() => root.dataset.folderState === 'ready', 'ready');
  assert.match(root.state().textContent, /read-only: “Synthetic folder” · writes are refused until you allow changes/);
  const refused = queue.add('a.txt', 'changed');
  await until(() => queue.results.has(refused), 'answered');
  assert.equal(queue.results.get(refused).error, 'permission_denied');
  assert.equal(folder.fake.text('a.txt'), 'alpha');
  await until(() => root.text().includes('write a.txt (7 bytes): not written: permission_denied'), 'logged as not written');
  // The owner allows changes: the click asks the browser, and writes apply.
  folder.fake.permissions.readwrite = 'granted';
  await root.button('Allow changes').onclick();
  await until(() => !root.button('Allow changes'), 'writable');
  assert.match(root.state().textContent, /^● Folder connected: “Synthetic folder”/);
});

test('the folder title mark keeps the page title; write marks are gone (ORK-810)', () => {
  const document = fakeDocument();
  setTitleMark(document, 'folder', true);
  assert.equal(document.title, '● Orkestr');
  // The page renames itself: the mark stays in front of the new title.
  document.title = 'Synthetic chat';
  setTitleMark(document, 'folder', true);
  assert.equal(document.title, '● Synthetic chat');
  for (const gone of ['write', 'waiting']) assert.throws(() => setTitleMark(document, gone, true), /Unknown title mark/);
  setTitleMark(document, 'folder', false);
  assert.equal(document.title, 'Synthetic chat');
  setTitleMark(document, 'folder', false);
  assert.equal(document.title, 'Synthetic chat', 'turning off an absent mark changes nothing');
  assert.throws(() => setTitleMark(document, 'other', true), /Unknown title mark/);
});

// ORK-809: the composer has one folder chip; the full controls and the
// activity log live in the Files panel.
test('the composer chip states the folder and connects in one click; connected, it links to Files', async () => {
  const document = fakeDocument(), root = new Node('div'), chipRoot = new Node('span'), api = server();
  const chip = () => chipRoot.find(n => n.attrs.class === 'local-folder-chip');
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, chipRoot, filesHref: '#conversation/synthetic/files'}, {
    picker: async () => handle(), indexedDB: null, document, uploader: {}, fetcher: api.fetcher, relayOptions: {pollMs: 5}});
  assert.equal(chipRoot.children.length, 1, 'one item in the composer');
  assert.deepEqual([chip().tag, chip().textContent, chip().attrs['data-state']], ['button', 'Connect folder…', 'none']);
  assert.equal(chipRoot.dataset.folderState, 'none');
  assert.ok(root.button('Connect folder…'), 'the Files panel offers it too');
  await chip().onclick();
  await until(() => chipRoot.dataset.folderState === 'ready', 'ready');
  assert.deepEqual([chip().tag, chip().textContent, chip().attrs.href], ['a', '● Synthetic folder', '#conversation/synthetic/files']);
  assert.match(chip().attrs['aria-label'], /Synthetic folder.*Open Files\./);
  assert.ok(root.button('Disconnect folder'), 'disconnect lives in the Files panel');
  assert.equal(chipRoot.find(n => n.tag === 'button'), undefined, 'no second control in the composer');
  await root.button('Disconnect folder').onclick();
  await until(() => chipRoot.dataset.folderState === 'none', 'none');
  assert.equal(chip().textContent, 'Connect folder…');
  panel.close();
  assert.equal(chipRoot.children.length, 0, 'closing clears the chip');
});

test('a remembered folder: the chip reconnects it in one click', async () => {
  const saved = {handle: handle('Remembered'), name: 'Remembered'};
  const document = fakeDocument(), root = new Node('div'), chipRoot = new Node('span'), api = server();
  const panel = mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, chipRoot}, {
    picker: async () => handle(), indexedDB: memoryIndexedDB({[`conversation:${CONVERSATION}`]: saved}), document, uploader: {}, fetcher: api.fetcher, relayOptions: {pollMs: 5}});
  await until(() => chipRoot.dataset.folderState === 'permission', 'permission');
  const chip = chipRoot.find(n => n.attrs.class === 'local-folder-chip');
  assert.equal(chip.textContent, 'Reconnect “Remembered”');
  await chip.onclick();
  await until(() => chipRoot.dataset.folderState === 'ready', 'ready');
  assert.equal(chipRoot.find(n => n.attrs.class === 'local-folder-chip').tag, 'span', 'without a Files link the state is plain text');
  panel.close();
});

test('where folders are unavailable the composer shows no chip at all', () => {
  const root = new Node('div'), chipRoot = new Node('span');
  mountLocalFiles({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, chipRoot}, {picker: null, document: fakeDocument(), uploader: {}});
  assert.deepEqual([chipRoot.children.length, chipRoot.hidden], [0, true]);
  assert.match(root.text(), /need Chrome or Edge/, 'the Files panel says why');
});
