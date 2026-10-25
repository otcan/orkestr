import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {runProbe, recordOutcome, PROBE_LABEL} from '../scripts/whatsapp-group-probe.mjs';

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
