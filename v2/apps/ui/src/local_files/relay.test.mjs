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
function relay(server, files, root, confirm = async () => 'refuse', options = {}) {
  return createRelay({conversation: CONVERSATION, csrf: 'synthetic-csrf', root, folderName: root.name, uploader: files,
    confirm, fetcher: server.fetcher, pollMs: 5, ...options});
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

test('a write needs the owner: refused, tampered and allowed writes', async () => {
  const server = queue(), files = uploader(), root = fakeDirectory(tree());
  const answers = [];
  const confirm = async (request, {bytes}) => {
    answers.push(request.path);
    if (request.path === 'a.txt') return 'refuse';
    // The owner's Allow click asks the browser for write access.
    return (await root.requestPermission({mode: 'readwrite'})) === 'granted' ? 'allow' : 'denied';
  };
  const r = relay(server, files, root, confirm);
  const refused = server.add('write', {path: 'a.txt', content: 'overwritten'});
  const tampered = server.add('write', {path: 'docs/plan.md', content: 'agreed', served: 'something else'});
  const allowed = server.add('write', {path: 'docs/new.md', content: 'hello'});
  void r.start();
  await until(() => server.results.size === 3, 'write results');
  await r.stop();
  assert.deepEqual(server.results.get(refused), {connection_id: r.snapshot().connection, outcome: 'failed', error: 'refused_by_owner'});
  assert.equal(root.fake.text('a.txt'), 'alpha', 'a refused write changes nothing');
  assert.equal(server.results.get(tampered).error, 'changed', 'only the bytes the agent queued are ever written');
  assert.equal(root.fake.text('docs/plan.md'), '# Plan\n');
  assert.deepEqual(server.results.get(allowed).written, {bytes_written: 5, sha256: sha('hello'), created: true});
  assert.equal(root.fake.text('docs/new.md'), 'hello');
  assert.deepEqual(answers.sort(), ['a.txt', 'docs/new.md'], 'the tampered write was never offered');
  assert.ok(root.fake.calls.some(c => c[0] === 'requestPermission' && c[1] === 'readwrite'));
});

test('a request that leaves the queue closes its confirmation; another tab and disconnect', async () => {
  const server = queue(), files = uploader(), root = fakeDirectory(tree());
  let aborted = false;
  const confirm = (request, {signal}) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve('refuse'); }));
  const r = relay(server, files, root, confirm);
  const id = server.add('write', {path: 'a.txt', content: 'x'});
  void r.start();
  await until(() => r.snapshot().pending.length === 1, 'confirmation shown');
  server.drop(id);
  await until(() => aborted, 'confirmation closed');
  assert.equal(server.results.has(id), false, 'nothing is reported for a request the tab no longer holds');
  await r.disconnect();
  assert.equal(r.snapshot().state, 'disconnected');
  assert.ok(server.calls.some(([method, path]) => method === 'POST' && path.endsWith('/local-files/disconnect')));
  assert.equal(root.fake.text('a.txt'), 'alpha');

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
