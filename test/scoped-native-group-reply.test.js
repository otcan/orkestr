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
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      bodies.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok: true, ids: ['sent-1']}));
    });
  });
  await new Promise(r => server.listen(socket, r));
  t.after(() => { server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const env = {PATH: process.env.PATH, ORKESTR_WA_SCOPED_GROUP_CONFIG: configPath, ORKESTR_WA_WORKER_SOCKET: socket, ORKESTR_WA_WORKER_TOKEN: 'test-token'};
  return {bodies, env};
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

test('worker policy denials raised before the send is journaled are definitive; delivery doubts are not', () => {
  const rejection = code => wrapperRejection({stderr: `${JSON.stringify({ok: false, error: code})}\n`});
  for (const code of ['timer_notification_proof_denied', 'group_transport_scope_denied', 'group_transport_notification_denied',
    'scoped_worker_operation_denied', 'scoped_worker_text_only']) {
    assert.equal(rejection(code).message, code);
    assert.equal(rejection(code).definitive, true, code);
  }
  for (const code of ['group_transport_delivery_uncertain', 'group_transport_request_conflict', 'delivery_route_delivery_unresolved',
    'whatsapp_worker_timeout', 'scoped_reply_failed'])
    assert.equal(rejection(code).definitive, false, code);
});
