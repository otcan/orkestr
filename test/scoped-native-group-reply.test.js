import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {wrapperRejection} from '../packages/connectors/src/whatsapp-scoped-wrapper-errors.js';

const run = promisify(execFile);
const script = path.resolve('scripts/scoped-native-group-reply.mjs');
const group = '120000000001@g.us';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wrapper-'));
  const socket = path.join(dir, 'worker.sock'), configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({workerAccountId: 'acct', groups: [{chatId: group, threadId: 't1'}]}));
  const bodies = [], paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      bodies.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok: true, ids: ['sent-1']}));
    });
  });
  await new Promise(r => server.listen(socket, r));
  t.after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const env = {PATH: process.env.PATH, ORKESTR_WA_SCOPED_GROUP_CONFIG: configPath, ORKESTR_WA_WORKER_SOCKET: socket, ORKESTR_WA_WORKER_TOKEN: 'test-token'};
  return {bodies, env, paths};
}

test('group-notify forwards the request id as the notification id; group-reply does not', async t => {
  const {bodies, env} = await fixture(t);
  await run('node', [script, 'group-notify', group, 'timer:abc:0', 'parent-1', 'hello'], {env});
  await run('node', [script, 'group-reply', group, 'reply:1', 'parent-1', 'hello'], {env});
  assert.equal(bodies[0].notificationId, 'timer:abc:0');
  assert.equal(bodies[0].requestId, 'timer:abc:0');
  assert.equal('notificationId' in bodies[1], false);
});

test('invalid commands and recipients are rejected before any worker request, as a definitive error', async t => {
  const {bodies, env} = await fixture(t);
  for (const args of [['group-broadcast', group, 'r', 'p', 'x'], ['group-notify', '120000000009@g.us', 'r', 'p', 'x']]) {
    const error = await run('node', [script, ...args], {env}).then(() => null, e => e);
    assert.ok(error);
    const rejection = wrapperRejection(error);
    assert.equal(rejection.message, 'scoped_reply_invalid');
    assert.equal(rejection.definitive, true);
  }
  assert.equal(bodies.length, 0);
  assert.equal(wrapperRejection({stderr: '{"ok":false,"error":"scoped_reply_unconfirmed"}\n'}).definitive, false);
  assert.equal(wrapperRejection({stderr: 'garbage'}).message, 'scoped_reply_failed');
});

test('replies up to the scoped send bound pass through the wrapper; longer ones are rejected', async t => {
  const {bodies, env} = await fixture(t);
  await run('node', [script, 'group-reply', group, 'reply:long', 'parent-1', 'x'.repeat(65000)], {env});
  assert.equal(bodies[0].text.length, 65000);
  const error = await run('node', [script, 'group-reply', group, 'reply:over', 'parent-1', 'x'.repeat(65001)], {env}).then(() => null, e => e);
  assert.equal(wrapperRejection(error).message, 'scoped_reply_invalid');
  assert.equal(bodies.length, 1);
});

test('group-send reads a text or a reply document from stdin and calls the matching worker route', async t => {
  const {bodies, env, paths} = await fixture(t);
  const send = payload => new Promise((resolve, reject) => {
    const child = execFile('node', [script, 'group-send'], {env}, (error, stdout, stderr) => error ? reject(Object.assign(error, {stderr})) : resolve(stdout));
    child.stdin.end(JSON.stringify(payload));
  });
  const document = {filename: 'reply-0123456789.md', mimetype: 'text/markdown', text: 'y'.repeat(200000)};
  await send({kind: 'notify', to: group, requestId: 'timer:abc:1', parentId: 'parent-1', document});
  await send({kind: 'reply', to: group, requestId: 'reply:2', parentId: 'parent-1', text: 'z'.repeat(65000)});
  assert.deepEqual(paths, ['/send-document', '/send-text']);
  assert.equal(bodies[0].text, document.text);
  assert.equal(bodies[0].filename, document.filename);
  assert.equal(bodies[0].notificationId, 'timer:abc:1');
  assert.equal(bodies[1].text.length, 65000);
  for (const bad of [{kind: 'reply', to: group, requestId: 'r', parentId: 'p', document: {...document, filename: 'x.sh'}},
    {kind: 'broadcast', to: group, requestId: 'r', parentId: 'p', text: 'x'},
    {kind: 'reply', to: group, requestId: 'r', parentId: 'p', text: 'x', document}]) {
    const error = await send(bad).then(() => null, e => e);
    assert.equal(wrapperRejection(error).message, 'scoped_reply_invalid');
  }
  assert.equal(bodies.length, 2);
});
