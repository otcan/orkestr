import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

function fixture(t) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT);
    CREATE TABLE group_send(state TEXT);
    INSERT INTO group_input VALUES('wa-1','group-1','hello','2026-01-01');`);
  const config = {ownerUserId: 'owner', replyPrefix: 'agent:', groups: [
    {chatId: 'group-1', threadId: 'thread-1', name: 'First'},
    {chatId: 'group-2', threadId: 'thread-2', name: 'Second'},
  ]};
  const state = {posts: [], sent: [], pages: {}, retired: new Set(), failReply: false};
  const api = async (url, options) => {
    const threadId = url.split('/')[3], groupId = threadId.replace('thread', 'group');
    if (url.endsWith('/input')) {
      state.posts.push({url, ...options});
      return {message: {id: `input-${threadId}`}};
    }
    if (url.includes('/messages')) return state.pages[url] || {messages: []};
    return {thread: {ownerUserId: 'owner', retired: state.retired.has(threadId), binding: {chatId: groupId, enabled: true}}};
  };
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, send: async payload => {
    state.sent.push(payload);
    if (state.failReply) throw new Error('transport_disconnected');
    return {ok: true, ids: ['sent-1']};
  }});
  t.after(() => {inboxDb.close(); relayDb.close();});
  return {relay, state, inboxDb, relayDb};
}
const answer = (id, parent = 'input-thread-1', phase = 'final_answer') => ({id, role: 'assistant', state: 'completed', phase, parentMessageId: parent, text: 'agent: answer'});
test('only the matching final is sent; input and completed output do not replay', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('old', 'other'), answer('progress', 'input-thread-1', 'commentary'), answer('final')]};
  assert.equal((await relay.tick()).completed, 1);
  await relay.tick();
  assert.equal(state.posts.length, 1); assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].chatId, 'group-1'); assert.equal(state.sent[0].parentId, 'wa-1');
  assert.equal(state.sent[0].text, 'agent: answer');
  assert.ok(state.posts[0].body.idempotencyKey);
  assert.equal(state.posts[0].body.workerReplyDelivery, undefined);
});
test('a broken binding does not prevent another group from progressing', async t => {
  const {relay, state, inboxDb} = fixture(t);
  state.retired.add('thread-1');
  inboxDb.exec("INSERT INTO group_input VALUES('wa-2','group-2','hello','2026-01-02')");
  const status = await relay.tick();
  assert.equal(status.routed, 1); assert.equal(status.ok, false);
  assert.equal(state.posts[0].url, '/api/threads/thread-2/input');
});
test('a completed final supersedes an unanswered older question', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('question', 'input-thread-1', 'need_input'), answer('final')]};
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 1);
});
test('pagination retains replies to a parent beyond the newest page', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('other', 'other')], hasMoreBefore: true, oldestCursor: 100};
  state.pages['/api/threads/thread-1/messages?limit=200&before=100'] = {messages: [{id: 'input-thread-1', role: 'user'}, answer('final')]};
  assert.equal((await relay.tick()).completed, 1); assert.equal(state.sent.length, 1);
});
test('need-input reaches the owner and leaves the turn open for its final answer', async t => {
  const {relay, state} = fixture(t);
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [answer('question', 'input-thread-1', 'need_input')]};
  assert.equal((await relay.tick()).completed, 0);
  await relay.tick(); assert.equal(state.sent.length, 1);
  state.pages[page].messages.push(answer('final'));
  assert.equal((await relay.tick()).completed, 1); assert.equal(state.sent.length, 2);
});
test('uncertain transport status prevents retry and input does not duplicate after a failed send', async t => {
  const {relay, state, inboxDb} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('final')]};
  state.failReply = true;
  assert.equal((await relay.tick()).ok, false);
  inboxDb.exec("INSERT INTO group_send VALUES('uncertain')");
  assert.equal((await relay.tick()).error, 'group_delivery_requires_review');
  assert.equal(state.sent.length, 1); assert.equal(state.posts.length, 1);
});
