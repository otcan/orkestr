import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT);
    CREATE TABLE group_send(state TEXT);`);
  const config = {ownerUserId: 'owner', heldInputIds: ['held-new', 'held-routed', 'preemptive'],
    groups: [{chatId: 'group', threadId: 'thread', name: 'Example'}]};
  const calls = [], sends = [];
  const api = async (path, options) => {
    calls.push({path, options});
    if (path.endsWith('/input')) return {messageId: `parent-${options.body.text.split('\n\n')[1]}`};
    if (path.includes('/messages')) return {messages: ['fresh', 'accepted', 'held-routed'].map(id => ({
      id: `answer-${id}`, parentMessageId: `parent-${id}`, role: 'assistant', state: 'completed', phase: 'final', text: 'result',
    }))};
    return {thread: {ownerUserId: 'owner', binding: {chatId: 'group', enabled: true}}};
  };
  const create = () => createScopedGroupRelay({config, inboxDb, relayDb, api, send: async payload => {
    sends.push(payload); return {ok: true, ids: ['provider-id']};
  }});
  const relay = create();
  const insert = (id, chat = 'group') => inboxDb.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run(id, chat, id, '2026-01-01');
  t.after(() => {inboxDb.close(); relayDb.close();});
  return {config, inboxDb, relayDb, calls, sends, relay, create, insert};
}

test('held unrouted and routed inputs remain untouched, while fresh input works across restart', async t => {
  const f = fixture(t);
  for (const id of ['held-new', 'held-routed', 'fresh', 'accepted']) f.insert(id);
  f.insert('excluded', 'excluded-group');
  f.relayDb.exec(`INSERT INTO routed VALUES('held-routed','thread','parent-held-routed',0);
    INSERT INTO routed VALUES('accepted','thread','parent-accepted',0);`);
  const acceptedId = `reply:${hash('accepted:answer-accepted:0')}`;
  f.relayDb.prepare('INSERT INTO replies VALUES(?,?)').run(acceptedId, 'sent');
  const originals = f.inboxDb.prepare('SELECT * FROM group_input').all();
  const status = await f.relay.tick();
  assert.deepEqual([status.ok, status.configuredHolds, status.held, status.excluded], [true, 3, 2, 1]);
  assert.equal(f.calls.filter(c => c.options?.method === 'POST').length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].parentId, 'fresh');
  assert.equal(f.relayDb.prepare('SELECT completed FROM routed WHERE id=?').get('held-routed').completed, 0);
  assert.equal(f.relayDb.prepare('SELECT * FROM routed WHERE id=?').get('held-new'), undefined);
  assert.equal(f.relayDb.prepare('SELECT state FROM replies WHERE id=?').get(acceptedId).state, 'sent');
  assert.deepEqual(f.inboxDb.prepare('SELECT * FROM group_input').all(), originals);
  const callsBefore = f.calls.length;
  await f.create().tick();
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.sends.length, 1);
});

test('holds alone make no API calls or journal dispositions, including preexisting payloads', async t => {
  const f = fixture(t); f.insert('held-routed');
  f.relayDb.exec(`INSERT INTO routed VALUES('held-routed','thread','parent-held-routed',0);
    INSERT INTO reply_payloads VALUES('frozen','["original"]');`);
  f.config.heldInputIds.length = 0; // caller mutation cannot silently remove a running hold
  await f.relay.tick();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.sends, []);
  assert.equal(f.relayDb.prepare('SELECT chunks FROM reply_payloads').get().chunks, '["original"]');
  assert.equal(f.relayDb.prepare('SELECT count(*) n FROM replies').get().n, 0);
});

test('malformed hold configuration fails before opening journals', () => {
  for (const heldInputIds of [null, {}, 'input', [null], [4], [''], ['   ']])
    assert.throws(() => createScopedGroupRelay({config: {heldInputIds}}), /group_held_inputs_invalid/);
});

test('uncertain delivery still blocks fresh eligible inputs when holds are configured', async t => {
  const f = fixture(t); f.insert('fresh'); f.inboxDb.exec("INSERT INTO group_send VALUES('uncertain')");
  assert.equal((await f.relay.tick()).error, 'group_delivery_requires_review');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.sends, []);
});
