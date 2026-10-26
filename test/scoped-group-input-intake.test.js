import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {createInputJournalWake} from '../packages/connectors/src/scoped-group-input-intake.js';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const idle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, extra = {}) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT,media_path TEXT,media_filename TEXT,media_mimetype TEXT,media_size INTEGER);
    CREATE TABLE group_send(state TEXT);`);
  const config = {ownerUserId: 'example-owner', groups: [
    {chatId: 'example-group-1', threadId: 'example-thread-1', name: 'First'},
    {chatId: 'example-group-2', threadId: 'example-thread-2', name: 'Second'},
  ], ...extra};
  const state = {posts: [], sent: [], reads: 0, invalidBinding: false, serverInputs: new Map()};
  const peers = new Set();
  const api = async (url, options) => {
    const id = url.split('/')[3];
    if (url.endsWith('/input')) {
      state.posts.push({url, body: options.body});
      const key = options.body.idempotencyKey;
      if (state.serverInputs.has(key)) assert.deepEqual(options.body, state.serverInputs.get(key));
      else state.serverInputs.set(key, structuredClone(options.body));
      if (state.loseResponseOnce) {state.loseResponseOnce = false; throw new Error('synthetic_response_lost');}
      return {message: {id: options.body.idempotencyKey}};
    }
    if (url.includes('/messages')) {
      state.reads++;
      if (state.waitMessages) await state.waitMessages(url);
      return {messages: []};
    }
    return {thread: {ownerUserId: config.ownerUserId,
      binding: {chatId: state.invalidBinding ? 'foreign-group' : id.replace('thread', 'group'), enabled: true}}};
  };
  const make = () => {
    const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, env: {},
      send: async body => {state.sent.push(body); return {ok: true, ids: ['example-receipt']};}});
    peers.add(relay);
    return relay;
  };
  t.after(() => {for (const peer of peers) peer.close(); inboxDb.close(); relayDb.close();});
  const add = (id, group = 1, media = null) => inboxDb.prepare('INSERT INTO group_input(id,chat_id,body,created_at,media_path) VALUES(?,?,?,?,?)')
    .run(id, `example-group-${group}`, id, `2026-01-01T00:00:${String(inboxDb.prepare('SELECT count(*) n FROM group_input').get().n).padStart(2, '0')}Z`, media);
  return {relay: make(), make, add, state, inboxDb, relayDb};
}

test('a new text admits while an unrelated existing reply scan is unresolved', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.add('older');
  await f.relay.admitNewInputs();
  assert.equal(f.state.reads, 0, 'admission does not scan replies');
  f.state.waitMessages = async () => {entered.resolve(); await release.promise;};
  const slow = f.relay.tick();
  await entered.promise;
  f.add('newer', 2);
  await f.relay.admitNewInputs();
  assert.equal(f.state.posts.length, 2);
  assert.match(f.state.posts[1].body.text, /newer/);
  assert.equal(f.state.sent.length, 0);
  release.resolve();
  await slow;
});

test('same-chat texts keep order, other chats get a turn, and restart/parallel polls do not duplicate', async t => {
  const f = fixture(t);
  f.add('first'); f.add('second'); f.add('other-chat', 2);
  const first = await f.relay.admitNewInputs();
  assert.equal(first.admitted, 2);
  assert.equal(first.more, true);
  assert.equal(f.state.posts.some(post => post.body.text.endsWith('second')), false);
  f.relay.close();
  const restarted = f.make();
  await Promise.all([restarted.admitNewInputs(), restarted.tick()]);
  assert.equal(f.state.posts.length, 3);
  assert.equal(new Set(f.state.posts.map(post => post.body.idempotencyKey)).size, 3);
  const chat = f.state.posts.filter(post => post.url.includes('example-thread-1'));
  assert.ok(chat[0].body.text.endsWith('first') && chat[1].body.text.endsWith('second'));
  await restarted.admitNewInputs();
  assert.equal(f.state.posts.length, 3);
});

test('media cannot be overtaken in its chat and does not block another chat', async t => {
  const f = fixture(t);
  f.add('media-first', 1, '/synthetic/media.png'); f.add('text-after-media'); f.add('other-text', 2);
  await f.relay.admitNewInputs();
  assert.equal(f.state.posts.length, 1);
  assert.ok(f.state.posts[0].body.text.endsWith('other-text'));
});

test('each admission pass is bounded and an unknown response retains the exact source key', async t => {
  const f = fixture(t, {groups: Array.from({length: 10}, (_, i) => ({
    chatId: `example-group-${i + 1}`, threadId: `example-thread-${i + 1}`, name: `Group ${i + 1}`,
  }))});
  for (let i = 1; i <= 10; i++) f.add(`text-${i}`, i);
  f.state.loseResponseOnce = true;
  const first = await f.relay.admitNewInputs();
  assert.equal(first.admitted, 7);
  assert.equal(f.state.posts.length, 8);
  assert.equal(first.more, true);
  const frozen = structuredClone(f.state.posts[0]);
  await f.relay.admitNewInputs();
  assert.deepEqual(f.state.posts[8], frozen);
  assert.equal(f.state.serverInputs.size, 10, 'the supported idempotency key creates one canonical input');
  assert.equal(f.state.posts.length, 11);
});

test('holds, live binding checks and uncertain-send barrier still gate the admission lane', async t => {
  const f = fixture(t, {heldInputIds: ['held']});
  f.add('held'); f.add('allowed', 2);
  f.inboxDb.prepare('INSERT INTO group_send VALUES(?)').run('uncertain');
  await f.relay.admitNewInputs();
  assert.equal(f.state.posts.length, 0);
  assert.equal(f.inboxDb.prepare('SELECT state FROM group_send').get().state, 'uncertain');
  f.inboxDb.prepare('DELETE FROM group_send').run();
  f.state.invalidBinding = true;
  await f.relay.admitNewInputs();
  assert.equal(f.state.posts.length, 0);
  f.state.invalidBinding = false;
  await f.relay.admitNewInputs();
  assert.equal(f.state.posts.length, 1);
  assert.ok(f.state.posts[0].body.text.endsWith('allowed'));
});

test('journal wakes coalesce and retain a new wake during in-flight owner HTTP work', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const gate = deferred();
  let calls = 0;
  const wake = createInputJournalWake({admit: async () => {calls++; return calls === 1 ? gate.promise : {more: false};}});
  wake.signal(); wake.signal();
  t.mock.timers.tick(25);
  assert.equal(calls, 1);
  wake.signal();
  gate.resolve({more: false}); await idle();
  t.mock.timers.tick(25); await idle();
  assert.equal(calls, 2);
  await wake.close();
});

test('shutdown awaits the original admission and does not start queued work', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const gate = deferred();
  let calls = 0, stopping;
  const wake = createInputJournalWake({admit: async options => {calls++; stopping = options.stopping; await gate.promise; return {more: true};}});
  wake.signal(); t.mock.timers.tick(25);
  let closed = false;
  const closing = wake.close().then(() => {closed = true;});
  assert.equal(stopping(), true);
  assert.equal(closed, false);
  wake.signal(); gate.resolve(); await closing;
  t.mock.timers.tick(100); await idle();
  assert.equal(calls, 1);
});
