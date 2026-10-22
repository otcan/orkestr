import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {requestOutreach} from '../packages/connectors/src/whatsapp-outreach-client.js';
import {outreachPolicy, assertOutreachOpen} from '../packages/connectors/src/whatsapp-outreach-policy.js';
import {openOutreachJournal} from '../packages/connectors/src/whatsapp-outreach-journal.js';
import {createOutreachSender, outreachBackendRequestId} from '../packages/connectors/src/whatsapp-outreach-sender.js';
import {createOutreachHttpServer} from '../packages/connectors/src/whatsapp-outreach-http.js';
import {acquireOutreachLease} from '../packages/connectors/src/whatsapp-outreach-lease.js';
import {coordinatorCliBackend, nativeOutreachBackend} from '../packages/connectors/src/whatsapp-outreach-backends.js';

const at = Date.parse('2026-01-01T08:00:00Z');
const recipients = Array.from({length: 100}, (_, n) => `${15550000000 + n}@c.us`);
const base = {campaignId: 'campaign-fixture', threadId: 'thread-fixture', recipients,
  accounts: ['primary', 'secondary'], timeZone: 'Europe/Istanbul', startHour: 10, endHour: 13, maxNewPer24h: 20, minSpacingMs: 60_000};
const active = () => ({enabled: true, officialCloudApiApproved: false, baselineImported: true, legacySendsFenced: true});
const request = (n = 0, accountId = 'secondary') => ({threadId: base.threadId, accountId,
  to: recipients[n], text: `fixture ${n}`, requestId: `request-${n}`});

function fixture(t, options = {}) {
  const policy = outreachPolicy({...base, ...options.policy});
  const journal = openOutreachJournal(options.path || ':memory:', policy);
  t.after(() => journal.close());
  let timestamp = at, state = active(); const calls = [];
  const backend = {health: options.health || (async () => ({ready: true, identityMatches: true})),
    send: options.send || (async body => {calls.push(body); return {ok: true, ids: [`provider-${body.requestId}`]};})};
  const sender = createOutreachSender({policy, journal, backends: {primary: backend, secondary: backend},
    state: () => state, now: () => timestamp});
  return {policy, journal, sender, calls, clock: value => {timestamp = value;}, state: value => {state = value;}};
}
const temp = t => {const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-fixture-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;};

test('policy rejects widening limits, duplicate recipients, groups and malformed account scopes', () => {
  for (const delta of [{maxNewPer24h: 21}, {maxNewPer24h: 0}, {minSpacingMs: 59_999},
    {recipients: [recipients[0], recipients[0]]}, {recipients: ['1200000000@g.us']},
    {accounts: ['primary', 'primary']}, {threadId: ''}])
    assert.throws(() => outreachPolicy({...base, ...delta}), /configuration_invalid/);
  const policy = outreachPolicy(base);
  assert.throws(() => policy.accounts.push('third'));
  assert.throws(() => policy.recipients.push('15550009999@c.us'));
});

test('exact Istanbul window includes 10:00 and excludes 13:00', () => {
  for (const time of ['07:00:00', '09:59:59']) assert.doesNotThrow(() => assertOutreachOpen(active(), Date.parse(`2026-01-01T${time}Z`), outreachPolicy(base)));
  for (const time of ['06:59:59', '10:00:00', '20:00:00']) assert.throws(() => assertOutreachOpen(active(), Date.parse(`2026-01-01T${time}Z`), outreachPolicy(base)), /outside_window/);
});

test('scoped send returns provider acceptance once and namespaces its upstream request', async t => {
  const f = fixture(t), input = request();
  const accepted = await f.sender.send(input);
  assert.equal(accepted.state, 'sent'); assert.equal(accepted.duplicate, false);
  assert.equal(f.calls[0].requestId, outreachBackendRequestId(f.policy, input.requestId));
  f.state({...active(), enabled: false}); f.clock(at + 86_400_000);
  const again = await f.sender.send(input);
  assert.equal(again.duplicate, true); assert.deepEqual(again.ids, accepted.ids); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sender.receipt(input.accountId, input.requestId).ids, accepted.ids);
  assert.throws(() => f.sender.receipt('primary', input.requestId), /receipt_unknown/);
});

test('wrong thread/account/recipient, extra operation fields and request collisions never reach a backend', async t => {
  const f = fixture(t);
  for (const delta of [{threadId: 'other'}, {accountId: 'other'}, {to: '15550009999@c.us'}, {to: '1200000000@g.us'},
    {attachment: 'file'}, {replyTo: 'x'}, {text: ''}, {text: 'x'.repeat(3001)}, {requestId: '../x'}])
    await assert.rejects(f.sender.send({...request(), ...delta}), /scope_denied/);
  assert.equal(f.calls.length, 0);
  await f.sender.send(request());
  await assert.rejects(f.sender.send({...request(), text: 'changed'}), /request_conflict/);
  await assert.rejects(f.sender.send({...request(), accountId: 'primary'}), /request_conflict/);
  assert.equal(f.calls.length, 1);
});

test('two sources cannot claim the same recipient, even using different request IDs', async t => {
  const f = fixture(t); await f.sender.send(request(0, 'primary')); f.clock(at + 60_000);
  await assert.rejects(f.sender.send({...request(0), requestId: 'different'}), /recipient_already_claimed/);
  assert.equal(f.calls.length, 1);
});

test('rolling quota is per source; attempts are spaced across BOTH sources; no daily reset catchup', async t => {
  const f = fixture(t);
  for (let n = 0; n < 20; n++) {f.clock(at + n * 60_000); await f.sender.send(request(n, 'primary'));}
  f.clock(at + 20 * 60_000);
  await assert.rejects(f.sender.send(request(20, 'primary')), /rolling_quota/);
  await f.sender.send(request(20));
  await assert.rejects(f.sender.send(request(21)), /spacing/);
  f.clock(at + 86_400_000 - 1);
  await assert.rejects(f.sender.send(request(21, 'primary')), /rolling_quota/);
  f.clock(at + 86_400_000); await f.sender.send(request(21, 'primary'));
  const quota = (await f.sender.status()).quota;
  assert.equal(quota.find(row => row.accountId === 'primary').newLast24h, 20);
});

test('uncertainty holds request AND recipient across sources and consumes quota', async t => {
  let sends = 0;
  const f = fixture(t, {policy: {maxNewPer24h: 1}, send: async () => {sends++; throw new Error('token-secret-backend-error');}});
  await assert.rejects(f.sender.send(request()), /delivery_uncertain/);
  await assert.rejects(f.sender.send(request()), /delivery_held/);
  f.clock(at + 60_000);
  await assert.rejects(f.sender.send({...request(0, 'primary'), requestId: 'another'}), /uncertainty_hold/);
  await assert.rejects(f.sender.send(request(1)), /uncertainty_hold/);
  assert.equal(f.sender.receipt('secondary', request().requestId).state, 'uncertain'); assert.equal(sends, 1);
  assert.equal((await f.sender.status()).blockedReason, 'outreach_uncertainty_hold');
  assert.equal((await f.sender.status()).quota.find(row => row.accountId === 'secondary').newLast24h, 1);
});

test('offline reconciliation requires evidence, preserves the recipient and never replays the held send', async t => {
  const f = fixture(t, {send: async () => {throw new Error('timeout');}});
  await assert.rejects(f.sender.send(request()), /delivery_uncertain/);
  assert.throws(() => f.journal.reconcile({requestId: request().requestId, outcome: 'blocked'}, at), /resolution_invalid/);
  f.journal.reconcile({requestId: request().requestId, outcome: 'blocked', evidenceRef: 'operator-fixture-check'}, at);
  assert.equal((await f.sender.status()).readyToAttempt, true);
  await assert.rejects(f.sender.send(request()), /delivery_held/);
  await assert.rejects(f.sender.send({...request(0, 'primary'), requestId: 'reroute'}), /recipient_already_claimed/);
  assert.throws(() => f.journal.reconcile({requestId: request().requestId, outcome: 'sent', providerId: 'x', evidenceRef: 'x'}, at), /resolution_not_uncertain/);
});

test('a slow backend cannot compress spacing after its eventual acceptance', async t => {
  let f;
  f = fixture(t, {send: async () => {f.clock(at + 120_000); return {ok: true, ids: ['slow-provider']};}});
  await f.sender.send(request());
  await assert.rejects(f.sender.send(request(1)), /spacing/);
});

test('rolling quota cannot expire before 24 hours after a slow acceptance', async t => {
  let f, sent = 0;
  f = fixture(t, {policy: {maxNewPer24h: 1}, send: async () => {
    if (!sent) f.clock(at + 120_000);
    return {ok: true, ids: [`slow-${++sent}`]};
  }});
  await f.sender.send(request()); f.clock(at + 86_400_000);
  await assert.rejects(f.sender.send(request(1)), /rolling_quota/);
  f.clock(at + 86_520_000); await f.sender.send(request(1)); assert.equal(sent, 2);
});

test('provider-confirmed resolution exposes the original acceptance without another send', async t => {
  let attempts = 0;
  const f = fixture(t, {send: async () => {attempts++; throw new Error('timeout');}});
  await assert.rejects(f.sender.send(request()), /delivery_uncertain/);
  f.journal.reconcile({requestId: request().requestId, outcome: 'sent', providerId: 'confirmed-original', evidenceRef: 'verified-provider-history'}, at);
  const receipt = await f.sender.send(request());
  assert.equal(receipt.duplicate, true); assert.deepEqual(receipt.ids, ['confirmed-original']); assert.equal(attempts, 1);
});

test('one-way stop survives restart and cannot erase accepted receipts', async t => {
  const file = path.join(temp(t), 'stopped.sqlite');
  const policy = outreachPolicy(base), journal = openOutreachJournal(file, policy);
  const body = request(); journal.reserve(body, 'hash', at); journal.settle(body.requestId, 'original-receipt', at);
  journal.stop('official_cloud_api_approved'); journal.close();
  const next = openOutreachJournal(file, policy); t.after(() => next.close());
  assert.equal(next.stopped(), true); assert.equal(next.receipt('secondary', body.requestId).ids[0], 'original-receipt');
  const sender = createOutreachSender({policy, journal: next, state: active, backends: {}, now: () => at});
  await assert.rejects(sender.send(request(1)), /stopped/);
  assert.equal((await sender.status()).blockedReason, 'outreach_stopped');
});

test('missing, partial and synthetic receipts remain uncertain instead of being reported sent', async t => {
  for (const result of [{ok: true}, {ok: false, ids: ['receipt']}, {ok: true, ids: []},
    {ok: true, ids: ['a', 'b']}, {ok: true, ids: ['summary:fake']}, {ok: true, ids: ['not an ID']}]) {
    const f = fixture(t, {send: async () => result});
    await assert.rejects(f.sender.send(request()), /delivery_uncertain/);
    assert.equal(f.sender.receipt('secondary', request().requestId).state, 'uncertain');
  }
});

test('official approval, manual stop, missing controls and unfenced legacy path fail closed', async t => {
  let health = 0;
  for (const state of [null, {}, {...active(), enabled: false}, {...active(), officialCloudApiApproved: true},
    {...active(), officialCloudApiApproved: undefined}, {...active(), baselineImported: false}, {...active(), legacySendsFenced: false}]) {
    const f = fixture(t, {health: async () => {health++; return {ready: true, identityMatches: true};}});
    f.state(state); await assert.rejects(f.sender.send(request()), /inactive/);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(health, 0);
});

test('observed Cloud API approval permanently latches stop on both send and status paths', async t => {
  for (const viaStatus of [false, true]) {
    const f = fixture(t); f.state({...active(), officialCloudApiApproved: true});
    if (viaStatus) assert.equal((await f.sender.status()).readyToAttempt, false);
    else await assert.rejects(f.sender.send(request()), /inactive/);
    assert.equal(f.journal.stopped(), true);
    f.state(active()); await assert.rejects(f.sender.send(request()), /stopped/);
    assert.equal(f.calls.length, 0);
  }
});

test('health must prove readiness and account identity', async t => {
  for (const value of [{ready: true}, {ready: true, identityMatches: false}, {ready: false, identityMatches: true}]) {
    const f = fixture(t, {health: async () => value});
    await assert.rejects(f.sender.send(request()), /account_not_ready/); assert.equal(f.calls.length, 0);
  }
});

test('late health completion cannot cross the window or a fresh stop', async t => {
  let f;
  f = fixture(t, {health: async () => {f.clock(Date.parse('2026-01-01T10:00:00Z')); return {ready: true, identityMatches: true};}});
  await assert.rejects(f.sender.send(request()), /outside_window/); assert.equal(f.calls.length, 0);
  const g = fixture(t, {health: async () => {g.state({...active(), officialCloudApiApproved: true}); return {ready: true, identityMatches: true};}});
  await assert.rejects(g.sender.send(request()), /inactive/); assert.equal(g.calls.length, 0);
  const h = fixture(t, {health: async () => {h.sender.stop('owner_stop'); return {ready: true, identityMatches: true};}});
  await assert.rejects(h.sender.send(request()), /stopped/); assert.equal(h.calls.length, 0);
});

test('stop during a reserved send preserves its eventual receipt and blocks the next attempt', async t => {
  let f;
  f = fixture(t, {send: async () => {f.sender.stop('official_cloud_api_approved'); return {ok: true, ids: ['accepted-before-stop']};}});
  const receipt = await f.sender.send(request());
  assert.deepEqual(receipt.ids, ['accepted-before-stop']);
  assert.equal((await f.sender.send(request())).duplicate, true);
  await assert.rejects(f.sender.send(request(1)), /stopped/);
});

test('request snapshot prevents mutation while health waits and concurrent sends serialize admission', async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(t, {health: async () => {await gate; return {ready: true, identityMatches: true};}});
  const input = request(); const first = f.sender.send(input);
  input.to = recipients[99]; input.accountId = 'primary';
  const second = f.sender.send(request(1)); release(); await first;
  await assert.rejects(second, /spacing/);
  assert.equal(f.calls[0].to, recipients[0]); assert.equal(f.calls[0].accountId, 'secondary');
});

test('baseline is atomic, idempotent and includes non-campaign first contacts in the cap', async t => {
  const f = fixture(t, {policy: {maxNewPer24h: 1}});
  const baseline = {to: '15550009999@c.us', accountId: 'secondary', state: 'sent', at: at - 120_000, requestId: 'historical', providerId: 'original'};
  f.journal.importBaseline([baseline]); f.journal.importBaseline([baseline]);
  await assert.rejects(f.sender.send(request()), /rolling_quota/);
  assert.throws(() => f.journal.importBaseline([{...baseline, to: recipients[1]}]), /baseline_conflict/);
  assert.throws(() => f.journal.importBaseline([{...baseline, requestId: 'new', to: recipients[2], providerId: 'other'},
    {...baseline, requestId: 'bad', to: 'group@g.us'}]), /baseline_invalid/);
  assert.throws(() => f.sender.receipt('secondary', 'new'), /receipt_unknown/);
  assert.deepEqual((await f.sender.status()).counts.map(row => ({...row})), [{state: 'sent', count: 1}]);
});

test('restart preserves receipts and turns interrupted sends uncertain; changed scope cannot reuse a journal', t => {
  const file = path.join(temp(t), 'journal.sqlite'), policy = outreachPolicy(base);
  const first = openOutreachJournal(file, policy);
  const input = request();
  first.reserve(input, 'hash', at); first.close();
  const second = openOutreachJournal(file, policy);
  assert.equal(second.receipt(input.accountId, input.requestId).state, 'uncertain'); second.close();
  assert.throws(() => openOutreachJournal(file, outreachPolicy({...base, maxNewPer24h: 19})), /journal_contract_changed/);
});

test('kernel lease rejects a second broker BEFORE it can recover another live sending row', async t => {
  const file = path.join(temp(t), 'journal.sqlite'), policy = outreachPolicy(base);
  const lease = await acquireOutreachLease(file);
  const journal = openOutreachJournal(file, policy);
  journal.reserve(request(), 'hash', at);
  await assert.rejects(acquireOutreachLease(file), /journal_busy/);
  assert.equal(journal.receipt('secondary', request().requestId).state, 'sending');
  journal.close(); await lease.close();
  const next = await acquireOutreachLease(file); await next.close();
});

test('stale lease fails closed without unlinking unknown sockets', async t => {
  const file = path.join(temp(t), 'journal.sqlite');
  fs.writeFileSync(`${file}.lease`, 'fixture stale path');
  await assert.rejects(acquireOutreachLease(file), /journal_busy/);
  assert.equal(fs.readFileSync(`${file}.lease`, 'utf8'), 'fixture stale path');
});

async function listening(t, server) {
  const socketPath = path.join(temp(t), 'broker.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return socketPath;
}
function call(socketPath, {token, url = '/send-text', method = 'POST', body = request(), raw} = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (method === 'GET' ? '' : JSON.stringify(body));
    const req = http.request({socketPath, path: url, method, headers: {'content-type': 'application/json',
      ...(token ? {authorization: `Bearer ${token}`} : {})}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => {text += chunk;});
      res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(text)}));
    }); req.on('error', reject); req.end(payload);
  });
}

test('scoped Unix API rejects unauthorized accounts/routes and reveals only its own receipts', async t => {
  const f = fixture(t), token = 'fixture-secondary-bearer-token-0000000000';
  const server = createOutreachHttpServer({policy: f.policy, sender: f.sender,
    grants: [{accountId: 'secondary', tokenSha256: crypto.createHash('sha256').update(token).digest('hex')}]});
  const socket = await listening(t, server);
  assert.equal((await call(socket)).status, 401);
  assert.equal((await call(socket, {token: token + 'x'})).status, 401);
  assert.equal((await call(socket, {token, body: request(0, 'primary')})).status, 403);
  for (const url of ['/coordinator/send', '/resolve', '/import', '/auth', '/send-media'])
    assert.equal((await call(socket, {token, url})).status, 403);
  assert.equal((await call(socket, {token, body: {...request(), threadId: 'other'}})).status, 403);
  assert.equal((await call(socket, {token, raw: '{'})).status, 400);
  const accepted = await call(socket, {token}); assert.equal(accepted.status, 200);
  const receipt = await call(socket, {token, method: 'GET', url: `/receipts/${request().requestId}`});
  assert.deepEqual(receipt.body.ids, accepted.body.ids); assert.equal(f.calls.length, 1);
  const status = await call(socket, {token, method: 'GET', url: '/health'});
  assert.deepEqual(status.body.quota, [{accountId: 'secondary', newLast24h: 1}]);
  assert.equal(JSON.stringify(status.body).includes(recipients[0]), false);
});

test('coordinator backend uses existing wrapper, stdin and request ID without shell expansion', async t => {
  const dir = temp(t), command = path.join(dir, 'fake-wrapper'), observed = path.join(dir, 'observed');
  fs.writeFileSync(command, `#!/usr/bin/node\nlet text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify({args:process.argv.slice(2),text,env:Object.keys(process.env)}));process.stdout.write(JSON.stringify({ok:true,ids:['fixture-provider']}));});\n`, {mode: 0o700});
  const backend = coordinatorCliBackend(command);
  const input = {...request(), text: 'literal $(not-a-command) `not-a-command` $TOKEN'};
  const result = await backend.send(input); assert.deepEqual(result.ids, ['fixture-provider']);
  const data = JSON.parse(fs.readFileSync(observed));
  assert.deepEqual(data.args, ['send', input.to, '-', '--request-id', input.requestId]);
  assert.equal(data.text, input.text); assert.deepEqual(data.env, ['PATH']);
});

test('native backend cannot switch worker accounts or send media and requires matching account health', async t => {
  const calls = []; let match = true;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ok: true, accounts: [{id: match ? 'primary' : 'other', ready: true, authenticated: true}]}));
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({url: req.url, body: JSON.parse(text)}); res.end(JSON.stringify({ok: true, ids: ['fixture-native']}));
  });
  const socket = await listening(t, server), backend = nativeOutreachBackend({socketPath: socket, accountId: 'primary'});
  assert.deepEqual(await backend.health(), {ready: true, identityMatches: true});
  await backend.send(request(0, 'secondary'));
  assert.equal(calls[0].url, '/send-text'); assert.equal(calls[0].body.accountId, 'primary');
  assert.equal(calls[0].body.threadId, base.threadId); assert.equal('paths' in calls[0].body, false);
  match = false; assert.deepEqual(await backend.health(), {ready: false, identityMatches: false});
});

test('stdio MCP uses only the dedicated account grant, rejects overrides and preserves uncertain outcomes', async t => {
  const f = fixture(t), token = 'fixture-secondary-bearer-token-0000000000';
  const server = createOutreachHttpServer({policy: f.policy, sender: f.sender,
    grants: [{accountId: 'secondary', tokenSha256: crypto.createHash('sha256').update(token).digest('hex')}]});
  const socket = await listening(t, server);
  const client = new Client({name: 'fixture-client', version: '1.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.resolve('scripts/whatsapp-outreach-mcp.mjs')], stderr: 'pipe', env: {
      ORKESTR_OUTREACH_SOCKET: socket, ORKESTR_OUTREACH_TOKEN: token,
      ORKESTR_OUTREACH_ACCOUNT_ID: 'secondary', ORKESTR_OUTREACH_THREAD_ID: base.threadId}});
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ['outreach_status', 'outreach_send_text', 'outreach_receipt', 'outreach_stop']);
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({name, arguments: args});
    return {...result, body: JSON.parse(result.content[0].text)};
  };
  const args = {conversation_id: recipients[0], text: 'synthetic message', idempotency_key: 'mcp-original'};
  assert.equal((await invoke('outreach_send_text', {...args, accountId: 'primary'})).isError, true);
  assert.equal((await invoke('outreach_send_text', {...args, conversation_id: '15550009999@c.us'})).isError, true);
  assert.equal(f.calls.length, 0);
  const receipt = await invoke('outreach_send_text', args);
  assert.equal(receipt.isError, false); assert.equal(receipt.body.state, 'sent');
  assert.equal((await invoke('outreach_send_text', args)).body.duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].accountId, 'secondary'); assert.equal(f.calls[0].threadId, base.threadId);
  assert.deepEqual((await invoke('outreach_receipt', {idempotency_key: 'mcp-original'})).body.ids, receipt.body.ids);
  assert.equal((await invoke('outreach_stop', {reason: 'official_cloud_api_approved'})).body.stopped, true);
  assert.equal((await invoke('outreach_send_text', {...args, conversation_id: recipients[1], idempotency_key: 'after-stop'})).isError, true);
  assert.equal(f.calls.length, 1);
});

test('client disconnect/timeout is uncertain and never retries the request', async t => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (req.url === '/truncated') {res.writeHead(200, {'content-type': 'application/json'}); res.write('{'); res.destroy();}
    // /timeout deliberately remains unanswered.
  });
  const socket = await listening(t, server), env = {ORKESTR_OUTREACH_SOCKET: socket, ORKESTR_OUTREACH_TOKEN: 'fixture-bearer'};
  await assert.rejects(requestOutreach('/truncated', {env}), /result_unknown/);
  await assert.rejects(requestOutreach('/timeout', {env, timeoutMs: 30}), /result_unknown/);
  assert.equal(calls, 2);
});
