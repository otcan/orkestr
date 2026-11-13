import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {fakeDirectory} from '../../../../ci/local-files-fake-directory.mjs';
import {createRelay} from './relay.mjs';

const CONVERSATION = '00000000-0000-4000-8000-00000000000a';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tree = () => ({'a.txt': 'alpha', 'empty.txt': '', docs: {'plan.md': '# Plan\n'}});

// The server's queue, enough for the tab: poll hands out queued requests to
// the connected tab, results and disconnects are recorded.
function queue({elsewhere = false, notReadyOnce = false} = {}) {
  const requests = [], results = new Map(), calls = [];
  let tab = null, lostPreparation = notReadyOnce;
  const json = (status, value) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
  const fetcher = async (path, options) => {
    const url = new URL(path, 'http://synthetic.invalid'), body = options.body ? JSON.parse(options.body) : null;
    calls.push([options.method, url.pathname]);
    if (options.method !== 'GET') assert.equal(options.headers['x-orkestr-csrf'], 'synthetic-csrf');
    const base = `/api/v2/conversations/${CONVERSATION}/local-files`;
    if (url.pathname === `${base}/poll`) {
      if (elsewhere && !body.takeover) return json(409, {code: 'local_files_connected_elsewhere'});
      tab = body.connection_id;
      for (const r of requests) if (r.state === 'queued') r.state = 'working';
      return json(200, {requests: requests.filter(r => r.state === 'working').map(({bytes, ...view}) => view), ttl_ms: 75000});
    }
    if (url.pathname === `${base}/disconnect`) { tab = null; return json(200, {connected: false}); }
    const content = new RegExp(`^${base}/requests/([0-9a-f-]{36})/content$`).exec(url.pathname);
    if (content) {
      assert.equal(url.searchParams.get('connection_id'), tab);
      const r = requests.find(x => x.request_id === content[1]);
      return new Response(r.served ?? r.bytes, {status: 200});
    }
    const result = new RegExp(`^${base}/requests/([0-9a-f-]{36})/result$`).exec(url.pathname);
    if (result) {
      assert.equal(body.connection_id, tab);
      if (body.upload_id && lostPreparation) { lostPreparation = false; return json(409, {code: 'local_file_upload_not_ready'}); }
      const r = requests.find(x => x.request_id === result[1]);
      r.state = body.outcome; results.set(r.request_id, body);
      return json(200, {request_id: r.request_id, state: body.outcome});
    }
    return json(404, {code: 'not_found'});
  };
  const add = (operation, {path = null, paths = [], content = null, served = null} = {}) => {
    const bytes = content === null ? null : new TextEncoder().encode(content);
    const request = {request_id: randomUUID(), operation, path, paths, state: 'queued', bytes,
      content_bytes: bytes?.length ?? null, content_sha256: bytes ? sha(bytes) : null, served: served && new TextEncoder().encode(served)};
    requests.push(request);
    return request.request_id;
  };
  return {fetcher, add, results, calls, requests, drop(id) { requests.find(r => r.request_id === id).state = 'expired'; }};
}
function uploader() {
  const uploads = [], attached = [];
  return {uploads, attached,
    async upload(file, id, options) {
      assert.equal(options.requireIngest, true, 'only the assistant-readable encrypted path');
      uploads.push({id, name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer())});
      return {file: {upload_id: id}};
    },
    async attach(status) { attached.push(status.file.upload_id); return {}; }};
}
async function until(check, label) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`timed out: ${label}`);
}
function relay(server, files, root, options = {}) {
  return createRelay({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, folderName: root.name, uploader: files,
    fetcher: server.fetcher, pollMs: 5, ...options});
}
// The owner allowed viewing and changing the folder when he connected it.
const writableTree = () => fakeDirectory(tree(), {readwrite: 'granted'});
// A fetcher that holds the content of the write to `path` until released.
function holdContent(server, path) {
  let release, seen = false;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async (url, options) => {
    const held = /\/content\?/.test(url) && server.requests.find(r => url.includes(r.request_id))?.path === path;
    if (held) { seen = true; await gate; }
    return server.fetcher(url, options);
  };
  return {fetcher, release: () => release(), seen: () => seen};
}

test('list, read, hash and package results come back; bytes only through the encrypted uploader', async () => {
  const server = queue(), files = uploader(), root = fakeDirectory(tree());
  const r = relay(server, files, root);
  const list = server.add('list', {path: ''});
  const read = server.add('read', {path: 'docs/plan.md'});
  const empty = server.add('read', {path: 'empty.txt'});
  const hash = server.add('hash', {paths: ['a.txt', 'docs/plan.md']});
  const pack = server.add('package', {paths: ['a.txt', 'docs/plan.md']});
  const missing = server.add('read', {path: 'nope.txt'});
  // A server can never make the tab leave the folder.
  const outside = server.add('read', {path: '../outside.txt'});
  void r.start();
  await until(() => server.results.size === 7, 'all results');
  await r.stop();
  assert.deepEqual(server.results.get(list).listing.entries.map(e => e.name), ['a.txt', 'docs', 'empty.txt']);
  const upload = server.results.get(read);
  assert.equal(upload.outcome, 'done');
  const sent = files.uploads.find(u => u.id === upload.upload_id);
  assert.equal(sent.name, 'plan.md');
  assert.equal(sent.bytes.toString(), '# Plan\n');
  assert.ok(files.attached.includes(upload.upload_id), 'prepared for the assistant before the result');
  assert.equal(JSON.stringify(upload).includes('Plan'), false, 'no file bytes in the result JSON');
  assert.deepEqual(server.results.get(empty), {connection_id: r.snapshot().connection, outcome: 'done', empty: true, last_modified_ms: 1767225600000});
  assert.deepEqual(server.results.get(hash).hashes.files.map(f => f.sha256), [sha('alpha'), sha('# Plan\n')]);
  const archive = files.uploads.find(u => u.id === server.results.get(pack).upload_id);
  assert.match(archive.name, /^selection-[0-9a-f]{12}\.tar$/);
  assert.equal(archive.type, 'application/x-tar');
  assert.deepEqual(server.results.get(pack).files, [{path: 'a.txt', size: 5}, {path: 'docs/plan.md', size: 7}]);
  assert.deepEqual([server.results.get(missing).error, server.results.get(outside).error], ['not_found', 'invalid_path']);
  assert.ok(!root.fake.calls.some(([, name]) => name === '..'), 'no handle was asked for ".."');
  assert.equal(files.uploads.length, 2);
});

test('a write applies on its own: no card, no prompt; only the queued bytes (ORK-810)', async () => {
  const server = queue(), files = uploader(), root = writableTree();
  const r = relay(server, files, root);
  const replaced = server.add('write', {path: 'a.txt', content: 'overwritten'});
  const tampered = server.add('write', {path: 'docs/plan.md', content: 'agreed', served: 'something else'});
  const created = server.add('write', {path: 'docs/new.md', content: 'hello'});
  void r.start();
  await until(() => server.results.size === 3, 'write results');
  await r.stop();
  assert.deepEqual(server.results.get(replaced).written, {bytes_written: 11, sha256: sha('overwritten'), created: false});
  assert.equal(root.fake.text('a.txt'), 'overwritten');
  assert.equal(server.results.get(tampered).error, 'changed', 'only the bytes the agent queued are ever written');
  assert.equal(root.fake.text('docs/plan.md'), '# Plan\n');
  assert.deepEqual(server.results.get(created).written, {bytes_written: 5, sha256: sha('hello'), created: true});
  assert.equal(root.fake.text('docs/new.md'), 'hello');
  assert.equal(root.fake.calls.some(c => c[0] === 'requestPermission'), false, 'never a browser prompt outside a click');
  // Every write is in the activity with its size.
  const logged = Object.fromEntries(r.snapshot().activity.map(a => [a.id, [a.operation, a.path, a.bytes, a.outcome]]));
  assert.deepEqual(logged[replaced], ['write', 'a.txt', 11, 'done']);
  assert.deepEqual(logged[tampered], ['write', 'docs/plan.md', 6, 'changed']);
  assert.deepEqual(logged[created], ['write', 'docs/new.md', 5, 'done']);
});

test('a folder the browser allowed for reading only refuses writes without asking', async () => {
  const server = queue(), root = fakeDirectory(tree(), {grantOnRequest: false});
  const r = relay(server, uploader(), root);
  const write = server.add('write', {path: 'a.txt', content: 'x'});
  void r.start();
  await until(() => server.results.has(write), 'result');
  await r.stop();
  assert.equal(server.results.get(write).error, 'permission_denied');
  assert.equal(root.fake.text('a.txt'), 'alpha');
  assert.equal(root.fake.calls.some(c => c[0] === 'requestPermission'), false);
});

test('a batch of ten writes applies one at a time, in queue order', async () => {
  const server = queue(), root = writableTree();
  const r = relay(server, uploader(), root);
  const ids = [];
  for (let i = 1; i <= 10; i++) ids.push(server.add('write', {path: `batch/${String(i).padStart(2, '0')}.txt`, content: `file ${i}`}));
  // The same file twice: the later write wins because it runs later.
  const first = server.add('write', {path: 'a.txt', content: 'first'});
  const second = server.add('write', {path: 'a.txt', content: 'second'});
  root.fake.permissions.readwrite = 'granted';
  await root.getDirectoryHandle('batch', {create: true});
  void r.start();
  await until(() => server.results.size === 12, 'all written');
  await r.stop();
  assert.ok([...ids, first, second].every(id => server.results.get(id).outcome === 'done'));
  const opened = root.fake.calls.filter(c => c[0] === 'createWritable').map(c => c[1]);
  assert.deepEqual(opened, [...ids.map((_, i) => `${String(i + 1).padStart(2, '0')}.txt`), 'a.txt', 'a.txt'], 'in order, never two at once');
  const written = root.fake.calls.filter(c => c[0] === 'createWritable' || c[0] === 'written').map(c => c[0]);
  assert.deepEqual(written, Array(12).fill(['createWritable', 'written']).flat(), 'each write ends before the next opens');
  assert.equal(root.fake.text('a.txt'), 'second');
  assert.equal(r.snapshot().activity.length, 12);
});

test('a write waiting its turn that leaves the queue is never written; another tab and disconnect', async t => {
  const server = queue(), files = uploader(), root = writableTree();
  const hold = holdContent(server, 'docs/plan.md');
  const r = relay({...server, fetcher: hold.fetcher}, files, root);
  t.after(() => r.stop());
  const slow = server.add('write', {path: 'docs/plan.md', content: 'v2'});
  const id = server.add('write', {path: 'a.txt', content: 'x'});
  void r.start();
  await until(() => hold.seen() && r.snapshot().pending.length === 2, 'second write waits its turn');
  server.drop(id);
  await until(() => r.snapshot().pending.length === 1, 'dropped');
  hold.release();
  await until(() => server.results.has(slow), 'first written');
  await until(() => r.snapshot().activity.length === 2, 'both recorded');
  assert.equal(server.results.has(id), false, 'nothing is reported for a request the tab no longer holds');
  assert.equal(root.fake.text('a.txt'), 'alpha', 'a dropped write is never started');
  // The owner sees that it expired, once.
  assert.deepEqual(r.snapshot().activity.map(a => [a.id, a.operation, a.path, a.outcome]),
    [[slow, 'write', 'docs/plan.md', 'done'], [id, 'write', 'a.txt', 'expired, nothing written']]);
  await r.disconnect();
  assert.equal(r.snapshot().activity.length, 2, 'disconnecting adds nothing');
  assert.equal(r.snapshot().state, 'disconnected');
  assert.ok(server.calls.some(([method, path]) => method === 'POST' && path.endsWith('/local-files/disconnect')));

  const busy = queue({elsewhere: true});
  const second = relay(busy, uploader(), fakeDirectory(tree()));
  await second.start();
  assert.equal(second.snapshot().state, 'elsewhere', 'never takes over without the owner choosing this tab');
  const chosen = relay(busy, uploader(), fakeDirectory(tree()));
  void chosen.start({takeover: true});
  await until(() => chosen.snapshot().state === 'connected', 'takeover');
  await chosen.stop();
});

test('an upload the server lost is prepared again once before the result', async () => {
  const server = queue({notReadyOnce: true}), files = uploader(), root = fakeDirectory(tree());
  const r = relay(server, files, root);
  const read = server.add('read', {path: 'a.txt'});
  void r.start();
  await until(() => server.results.has(read), 'result');
  await r.stop();
  assert.equal(server.results.get(read).outcome, 'done');
  assert.equal(files.uploads.length, 1, 'the file is uploaded once');
  assert.equal(files.attached.length, 2, 'and prepared again');
});

// ORK-804: a request the server stops giving this tab is recorded in the
// activity exactly once, and only when this tab produced no outcome for it.
test('a dropped read is recorded as expired; stopping the relay records nothing', async t => {
  const server = queue(), root = fakeDirectory(tree());
  let uploading = false;
  // An upload that only ends when the relay gives up on it.
  const files = {async upload(file, id, {signal}) {
    uploading = true;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
  }, async attach() { return {}; }};
  const r = relay(server, files, root);
  t.after(() => r.stop());
  const read = server.add('read', {path: 'a.txt'});
  void r.start();
  await until(() => uploading, 'upload started');
  server.drop(read);
  await until(() => r.snapshot().activity.length === 1, 'expired entry');
  assert.deepEqual(r.snapshot().activity.map(a => [a.id, a.operation, a.outcome]), [[read, 'read', 'expired']]);
  assert.equal(server.results.has(read), false);
  // A write still in progress when the relay stops is not "expired".
  await r.stop();
  const hold = holdContent(server, 'a.txt');
  const waiting = relay({...server, fetcher: hold.fetcher}, uploader(), writableTree());
  t.after(() => { hold.release(); return waiting.stop(); });
  server.add('write', {path: 'a.txt', content: 'x'});
  void waiting.start();
  await until(() => hold.seen(), 'write in progress');
  const stopping = waiting.stop();
  hold.release();
  await stopping;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(waiting.snapshot().activity, [], 'nothing is recorded when the relay itself stops');
});

test('a result posted while the poll drops the request is recorded once, as its outcome', async t => {
  const server = queue(), root = fakeDirectory(tree());
  let posted = false, pollsAfter = 0;
  // The result reaches the server, but its answer arrives only after two
  // more polls (which no longer list the request) have dropped it.
  const fetcher = async (path, options) => {
    const reply = await server.fetcher(path, options);
    if (path.endsWith('/poll') && posted) pollsAfter++;
    if (path.endsWith('/result')) { posted = true; await until(() => pollsAfter >= 2, 'polls after the result'); }
    return reply;
  };
  const r = relay({...server, fetcher}, uploader(), root);
  t.after(() => r.stop());
  const list = server.add('list', {path: ''});
  void r.start();
  await until(() => r.snapshot().activity.length > 0, 'outcome');
  await new Promise(resolve => setTimeout(resolve, 20));
  await r.stop();
  assert.ok(pollsAfter >= 2, 'the poll ran while the result was answered');
  assert.deepEqual(r.snapshot().activity.map(a => [a.id, a.outcome]), [[list, 'done']], 'never "expired" for a request that completed');
  assert.equal(server.results.get(list).outcome, 'done');
});

test('a write that was written but dropped before its result says so', async t => {
  const server = queue(), root = fakeDirectory(tree());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // Hashing the written bytes waits until the server has dropped the request.
  const subtle = {digest: async (algorithm, data) => {
    if (root.fake.calls.some(c => c[0] === 'written')) await gate;
    return crypto.subtle.digest(algorithm, data);
  }};
  root.fake.permissions.readwrite = 'granted';
  const r = relay(server, uploader(), root, {subtle});
  t.after(() => { release(); return r.stop(); });
  const write = server.add('write', {path: 'docs/new.md', content: 'hello'});
  void r.start();
  await until(() => root.fake.calls.some(c => c[0] === 'written'), 'written');
  server.drop(write);
  const polls = server.calls.filter(([, path]) => path.endsWith('/poll')).length;
  await until(() => server.calls.filter(([, path]) => path.endsWith('/poll')).length >= polls + 2, 'dropped');
  release();
  await until(() => r.snapshot().activity.length === 1, 'entry');
  await r.stop();
  assert.equal(root.fake.text('docs/new.md'), 'hello');
  assert.deepEqual(r.snapshot().activity.map(a => [a.id, a.outcome]), [[write, 'written, but expired before it was reported']]);
  assert.equal(server.results.has(write), false);
});
