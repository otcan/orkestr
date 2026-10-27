import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {quotedGroupInput, sendQuotedOnce} from '../packages/connectors/src/whatsapp-scoped-deep-quote.js';
import {remoteLayerMetadata} from '../packages/connectors/src/whatsapp-remote-footer.js';

// V2 #377: one Deep final answers a burst of owner messages; it is parented to
// the burst's first input and names the burst's LAST input (sourceInputId).
function fixture(t, {lastChat = 'group-1', failQuoted = false} = {}) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT,media_path TEXT,media_filename TEXT,media_mimetype TEXT,media_size INTEGER);
    CREATE TABLE group_send(state TEXT);
    INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-1','group-1','first question','2026-01-01');`);
  // The burst's last WhatsApp input, already routed (and answered by the group).
  inboxDb.prepare('INSERT INTO group_input(id,chat_id,body,created_at) VALUES(?,?,?,?)').run('wa-3', lastChat, 'third question', '2025-12-31');
  const config = {ownerUserId: 'admin', groups: [{chatId: 'group-1', threadId: 'thread-1', name: 'First'}, {chatId: 'group-2', threadId: 'thread-2', name: 'Second'}]};
  const state = {sent: [], logs: [], pages: {}};
  const api = async (url, options) => {
    const threadId = url.split('/')[3];
    if (url.endsWith('/scoped-relay-delivery')) return {ok: true};
    if (url.endsWith('/input')) return {message: {id: `input-${threadId}`}};
    if (url.includes('/messages')) return state.pages[url.replace('&includeNoReply=1', '')] || {messages: []};
    if (url.startsWith('/api/quota/')) return {quota: {}};
    return {thread: {ownerUserId: 'admin', binding: {chatId: threadId.replace('thread', 'group'), enabled: true}}};
  };
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, env: {}, log: e => state.logs.push(e), send: async payload => {
    state.sent.push(payload);
    if (failQuoted && payload.quotedMessageId) throw new Error('quote_refused_by_old_worker');
    return {ok: true, ids: ['sent-' + state.sent.length]};
  }});
  // The relay routed wa-3 earlier to the local message the adapter answered.
  relayDb.prepare('INSERT OR IGNORE INTO routed(id,thread_id,message_id,completed) VALUES(?,?,?,1)').run('wa-3', 'thread-1', 'local-3');
  t.after(() => {inboxDb.close(); relayDb.close();});
  const final = {id: 'deep-final', role: 'assistant', source: 'remote-runtime', state: 'completed', phase: 'final_answer',
    parentMessageId: 'input-thread-1', text: 'agent: 1. yes 2. no 3. done', remoteMessageId: 'remote-final', remoteThreadId: 'remote-thread',
    remoteLayer: 'deep', remoteQuoteSource: true, remoteOriginalInputId: 'adapter-3'};
  const last = {id: 'local-3', role: 'user', source: 'whatsapp_group_relay', remoteMessageId: 'adapter-3', remoteThreadId: 'remote-thread'};
  state.page = messages => { state.pages['/api/threads/thread-1/messages?limit=200'] = {messages}; };
  state.page([{id: 'input-thread-1', role: 'user'}, last, final]);
  return {relay, state, final, last};
}

test('a grouped Deep final quotes the last WhatsApp input of its burst', async t => {
  const {relay, state} = fixture(t);
  await relay.tick();
  const replies = state.sent.filter(p => p.parentId === 'wa-1');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].quotedMessageId, 'wa-3');
  assert.equal(replies[0].text, 'agent: 1. yes 2. no 3. done');
  await relay.tick();
  assert.equal(state.sent.filter(p => p.parentId === 'wa-1').length, 1, 'never sent twice');
});

test('a quoted send that fails is retried once unquoted under the same requestId', async t => {
  const {relay, state} = fixture(t, {failQuoted: true});
  await relay.tick();
  const replies = state.sent.filter(p => p.parentId === 'wa-1');
  assert.equal(replies.length, 2);
  assert.equal(replies[0].quotedMessageId, 'wa-3');
  assert.equal('quotedMessageId' in replies[1], false);
  assert.equal(replies[1].requestId, replies[0].requestId);
  assert.ok(state.logs.some(e => e.event === 'reply_quote_fallback'));
  await relay.tick();
  assert.equal(state.sent.filter(p => p.parentId === 'wa-1').length, 2, 'the confirmed unquoted reply is final');
});

test('an unknown, cross-chat, lone or non-Deep source sends the final unquoted', async t => {
  const cases = {
    crossChat: {lastChat: 'group-2'},
    unknownSource: {}, ambiguous: {}, otherRemoteThread: {}, notMarked: {}, fastLayer: {},
  };
  for (const [mode, options] of Object.entries(cases)) {
    const {relay, state, final, last} = fixture(t, options);
    if (mode === 'unknownSource') final.remoteOriginalInputId = 'adapter-unknown';
    if (mode === 'ambiguous') state.page([{id: 'input-thread-1', role: 'user'}, last, {...last, id: 'local-4'}, final]);
    if (mode === 'otherRemoteThread') last.remoteThreadId = 'another-remote-thread';
    if (mode === 'notMarked') delete final.remoteQuoteSource;
    if (mode === 'fastLayer') final.remoteLayer = 'fast';
    await relay.tick();
    const replies = state.sent.filter(p => p.parentId === 'wa-1');
    assert.equal(replies.length, 1, mode);
    assert.equal('quotedMessageId' in replies[0], false, mode);
  }
});

test('the quote is resolved through exactly one route and never names the parent', () => {
  const answer = {remoteQuoteSource: true, remoteLayer: 'deep', phase: 'final_answer', remoteOriginalInputId: 'a3', remoteThreadId: 'r'};
  const messages = [{id: 'l3', role: 'user', remoteMessageId: 'a3', remoteThreadId: 'r'}];
  const base = {answer, messages, input: {id: 'wa-1', chat_id: 'g'}, group: {threadId: 't'}, inChat: () => true};
  assert.equal(quotedGroupInput({...base, routedFor: () => ['wa-3']}), 'wa-3');
  assert.equal(quotedGroupInput({...base, routedFor: () => ['wa-3', 'wa-4']}), '');
  assert.equal(quotedGroupInput({...base, routedFor: () => []}), '');
  assert.equal(quotedGroupInput({...base, routedFor: () => ['wa-1']}), '', 'a lone input is never quoted');
  assert.equal(quotedGroupInput({...base, routedFor: () => ['bad id']}), '');
  assert.equal(quotedGroupInput({...base, routedFor: () => { throw new Error('journal'); }}), '');
  assert.equal(quotedGroupInput({...base, routedFor: () => ['wa-3'], inChat: () => false}), '');
});

test('sendQuotedOnce retries an unconfirmed quoted attempt once and passes unquoted sends through', async () => {
  const calls = [];
  const send = async p => { calls.push(p); return p.quotedMessageId ? {ok: false} : {ok: true, ids: ['x']}; };
  assert.deepEqual(await sendQuotedOnce(send, {requestId: 'r', text: 'hi'}, 'wa-3'), {ok: true, ids: ['x']});
  assert.deepEqual(calls.map(c => c.quotedMessageId), ['wa-3', undefined]);
  calls.length = 0;
  await sendQuotedOnce(send, {requestId: 'r', text: 'hi'}, '');
  assert.equal(calls.length, 1);
});

test('V2 quote metadata is imported for a Deep final as for a burst Quick reply', () => {
  assert.equal(remoteLayerMetadata({phase: 'final_answer', layer: 'deep', quoteSource: true, sourceInputId: 'adapter-3'}).remoteQuoteSource, true);
  assert.equal(remoteLayerMetadata({phase: 'final_answer', layer: 'deep', sourceInputId: 'adapter-3'}).remoteQuoteSource, undefined);
  assert.equal(remoteLayerMetadata({phase: 'final_answer', layer: 'deep', quoteSource: true}).remoteQuoteSource, undefined);
  assert.equal(remoteLayerMetadata({kind: 'notice', quoteSource: true, sourceInputId: 'adapter-3'}).remoteQuoteSource, undefined);
});
