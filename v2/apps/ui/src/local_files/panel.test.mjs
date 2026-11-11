// The Connect folder control states what it can do in words (ORK-786):
// unsupported, no folder, permission needed, worker offline, ready. Synthetic
// DOM, folder handle, storage and server only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DENIED, folderState} from './folder_state.mjs';
import {mountLocalFiles} from './panel.mjs';

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
