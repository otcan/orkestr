import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {runProbe, recordOutcome, providerRateLimited, PROBE_LABEL, RATE_LIMIT_CODE} from '../scripts/whatsapp-group-probe.mjs';

const own = '15550000001@c.us', second = '15550000002@c.us', chat = '120000000009@g.us';
function fixture(t, {members = [own, second], deliver = true, record = true, route = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-probe-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const primaryPath = path.join(dir, 'primary.sqlite'), senderPath = path.join(dir, 'sender.sqlite');
  const p = new DatabaseSync(primaryPath);
  p.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT,body TEXT,created_at TEXT);
    CREATE TABLE group_send(id TEXT PRIMARY KEY,hash TEXT,chat_id TEXT,parent_id TEXT,state TEXT,provider_id TEXT,created_at TEXT);`);
  const s = new DatabaseSync(senderPath);
  s.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT,body TEXT,created_at TEXT);
    INSERT INTO group_input VALUES('parent-1','${chat}','earlier','2026-01-01');`);
  s.close();
  t.after(() => p.close());
  const relayPath = path.join(dir, 'relay.sqlite');
  const r = new DatabaseSync(relayPath);
  r.exec('CREATE TABLE routed(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)');
  t.after(() => r.close());
  const primary = {ownChatId: own, journalPath: primaryPath, relayJournalPath: relayPath, groups: [{chatId: chat, threadId: 'probe-thread'}, {chatId: '120000000001@g.us', threadId: 'work'}]};
  const sender = {ownChatId: second, journalPath: senderPath, groups: [{chatId: chat, threadId: 'x'}]};
  const probe = {chatId: chat, threadId: 'probe-thread', senderUrl: 'http://sender.invalid', timeoutMs: 1000, pollMs: 1};
  const calls = [];
  let clock = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, options});
    if (url.endsWith('/meta')) return {ok: true, json: async () => ({groupMetadata: {participants: members.map(id => ({id: {_serialized: id}}))}})};
    const body = JSON.parse(options.body);
    if (record) p.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('in-1', body.to, body.text, '2026-01-02');
    if (record && route) r.prepare("INSERT INTO routed VALUES('in-1','probe-thread','m1',0)").run();
    if (deliver) p.prepare("INSERT INTO group_send VALUES('r1','h',?,'in-1','sent','prov-1','2026-01-02')").run(body.to);
    return {ok: true, json: async () => ({ok: true, ids: ['x']})};
  };
  return {probe, primary, sender, calls, fetchImpl, now: () => clock, wait: async ms => { clock += ms * 100; }};
}

test('probe sends only the fixed label to the dedicated group and confirms record + delivery', async t => {
  const f = fixture(t);
  const r = await runProbe({...f, token: 't', nonce: 'abcd1234'});
  assert.equal(r.ok, true);
  const send = f.calls.find(c => c.url.endsWith('/send-text'));
  const body = JSON.parse(send.options.body);
  assert.deepEqual(Object.keys(body).sort(), ['accountId', 'parentId', 'requestId', 'text', 'to']);
  assert.equal(body.to, '120000000009@g.us');
  assert.equal(body.text, `${PROBE_LABEL} #abcd1234`);
  assert.equal(body.parentId, 'parent-1');
});

test('probe refuses groups with other participants, shared or unbound threads', async t => {
  const extra = fixture(t, {members: [own, second, '15550000003@c.us']});
  await assert.rejects(runProbe({...extra, token: 't'}), /other_participants/);
  assert.equal(extra.calls.some(c => c.url.endsWith('/send-text')), false);
  const shared = fixture(t);
  shared.primary.groups[1].threadId = 'probe-thread';
  await assert.rejects(runProbe({...shared, token: 't'}), /probe_thread_shared/);
  const unbound = fixture(t);
  unbound.probe.threadId = 'work';
  await assert.rejects(runProbe({...unbound, token: 't'}), /not_bound_to_probe_thread/);
});

test('probe distinguishes unrecorded input from undelivered reply', async t => {
  await assert.rejects(runProbe({...fixture(t, {record: false, deliver: false}), token: 't'}), /input_not_recorded/);
  await assert.rejects(runProbe({...fixture(t, {deliver: false}), token: 't'}), /reply_not_delivered/);
});

test('alerts once after two consecutive failures and resets on success', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-probe-state-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'state.json'), alerts = [];
  const alert = s => alerts.push(s.consecutiveFailures);
  recordOutcome(file, {ok: false, code: 'probe_input_not_recorded'}, {alert});
  assert.equal(alerts.length, 0);
  recordOutcome(file, {ok: false, code: 'probe_input_not_recorded'}, {alert});
  recordOutcome(file, {ok: false, code: 'probe_input_not_recorded'}, {alert});
  assert.deepEqual(alerts, [2]);
  assert.equal(recordOutcome(file, {ok: true}, {alert}).consecutiveFailures, 0);
  recordOutcome(file, {ok: false, code: 'x'}, {alert}); recordOutcome(file, {ok: false, code: 'x'}, {alert});
  assert.deepEqual(alerts, [2, 2]);
});

test('intake-only mode passes on record + route even while the reply is held (deploy drain)', async t => {
  const r = await runProbe({...fixture(t, {deliver: false}), token: 't', intakeOnly: true});
  assert.equal(r.ok, true);
  assert.equal(r.intakeOnly, true);
  await assert.rejects(runProbe({...fixture(t, {deliver: false, route: false}), token: 't', intakeOnly: true}), /probe_input_not_routed/);
});

function codexLog(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-probe-log-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'logs_2.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,level TEXT,target TEXT NOT NULL,feedback_log_body TEXT)');
  for (const [ts, target, body] of rows) db.prepare('INSERT INTO logs(ts,level,target,feedback_log_body) VALUES(?,?,?,?)').run(ts, 'WARN', target, body);
  db.close();
  return file;
}
const retry429 = 'turn_id=x retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests';

test('provider 429 evidence is read only from the configured window and target', t => {
  const file = codexLog(t, [[100, 'codex_core::responses_retry', retry429], [500, 'other::target', retry429]]);
  assert.equal(providerRateLimited([file], 90_000, 110_000), true);
  assert.equal(providerRateLimited([file], 200_000, 600_000), false);
  assert.equal(providerRateLimited([path.join(path.dirname(file), 'missing.sqlite')], 0, 1e12), false);
  assert.equal(providerRateLimited(undefined, 0, 1e12), false);
});

test('an undelivered reply during provider rate limiting is degraded, not failed', async t => {
  const f = fixture(t, {deliver: false});
  f.probe.providerRateLimitLogs = [codexLog(t, [[0, 'codex_core::responses_retry', retry429]])];
  await assert.rejects(runProbe({...f, token: 't'}), e => e.probeCode === RATE_LIMIT_CODE && e.degraded === true);
  // Without 429 evidence it is still a real delivery failure.
  const g = fixture(t, {deliver: false});
  g.probe.providerRateLimitLogs = [codexLog(t, [[0, 'codex_core::responses_retry', 'ok']])];
  await assert.rejects(runProbe({...g, token: 't'}), e => /reply_not_delivered/.test(e.message) && !e.degraded);
  // Unrecorded input is never excused by provider rate limits.
  const h = fixture(t, {record: false, deliver: false});
  h.probe.providerRateLimitLogs = f.probe.providerRateLimitLogs;
  await assert.rejects(runProbe({...h, token: 't'}), /input_not_recorded/);
});

test('degraded runs do not alert as failures or break the failure streak, and alert once when long', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-probe-state-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'state.json'), alerts = [];
  const alert = s => alerts.push(s.degraded ? `degraded:${s.consecutiveDegraded}` : `failed:${s.consecutiveFailures}`);
  const degraded = {ok: false, degraded: true, code: RATE_LIMIT_CODE};
  for (let i = 0; i < 3; i += 1) assert.equal(recordOutcome(file, degraded, {alert, degradedAlertAfter: 3}).consecutiveFailures, 0);
  assert.deepEqual(alerts, ['degraded:3']);
  recordOutcome(file, degraded, {alert, degradedAlertAfter: 3});
  assert.deepEqual(alerts, ['degraded:3']);
  recordOutcome(file, {ok: false, code: 'probe_input_not_recorded'}, {alert});
  recordOutcome(file, degraded, {alert, degradedAlertAfter: 3});
  assert.deepEqual(alerts, ['degraded:3']);
  recordOutcome(file, {ok: false, code: 'probe_input_not_recorded'}, {alert});
  assert.deepEqual(alerts, ['degraded:3', 'failed:2']);
  const ok = recordOutcome(file, {ok: true}, {alert});
  assert.equal(ok.consecutiveFailures, 0);
  assert.equal(ok.consecutiveDegraded, undefined);
});
