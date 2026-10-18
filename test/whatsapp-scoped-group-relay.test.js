import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

function fixture(t, footer = false, progress = false, extraConfig = {}) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT);
    CREATE TABLE group_send(state TEXT);
    INSERT INTO group_input VALUES('wa-1','group-1','hello','2026-01-01');`);
  const config = {forwardProgressUpdates: progress, forwardProgressSince: '2026-01-01T00:00:00Z', ownerUserId: 'admin', appendDebugFooter: footer, replyPrefix: 'agent:', groups: [
    {chatId: 'group-1', threadId: 'thread-1', name: 'First'},
    {chatId: 'group-2', threadId: 'thread-2', name: 'Second'},
  ]};
  Object.assign(config, extraConfig);
  const state = {posts: [], sent: [], pages: {}, retired: new Set(), failReply: false,
    suppressFooter: false, quotaFails: false, quotaCalls: 0,
    quota: {codex: {fiveHourRemainingPct: 73}, claude: {weeklyRemainingPct: 64}}};
  const api = async (url, options) => {
    if (url.startsWith('/api/quota/providers')) {
      state.quotaCalls++;
      if (state.quotaFails) throw new Error('quota_unavailable');
      return {quota: state.quota};
    }
    const threadId = url.split('/')[3], groupId = threadId.replace('thread', 'group');
    if (url.endsWith('/input')) {
      state.posts.push({url, ...options});
      return {message: {id: `input-${threadId}`}};
    }
    if (url.includes('/messages')) return state.pages[url] || {messages: []};
    return {thread: {ownerUserId: config.ownerUserId, codexModel: 'example-model', retired: state.retired.has(threadId),
      binding: {chatId: groupId, enabled: true, suppressWhatsAppDebugFooter: state.suppressFooter}}};
  };
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, formatter, env: {}, send: async payload => {
    state.sent.push(payload);
    if (state.failReply) throw new Error('transport_disconnected');
    return {ok: true, ids: ['sent-1']};
  }});
  t.after(() => {inboxDb.close(); relayDb.close();});
  return {relay, state, inboxDb, relayDb, config};
}
const answer = (id, parent = 'input-thread-1', phase = 'final_answer') => ({id, role: 'assistant', source: 'codex-app-server', state: 'completed', phase, parentMessageId: parent, text: 'agent: answer'});
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

test('shared footer includes model, both provider quotas and queue context once', async t => {
  const {relay, state} = fixture(t, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('final')]};
  assert.equal((await relay.tick()).completed, 1);
  const text = state.sent[0].text;
  assert.match(text, /dbg: codex\/example-model/);
  assert.match(text, /codex 5h: 73%/); assert.match(text, /claude wk: 64%/);
  assert.match(text, /q:0.*load:.*help:\/help/);
  assert.equal(text.match(/dbg:/g).length, 1);
});

test('long replies keep a single whole footer within the transport chunk bound', async t => {
  const {relay, state} = fixture(t, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text: 'a'.repeat(2790)}]};
  await relay.tick();
  assert.ok(state.sent.every(x => [...x.text].length <= 1400));
  assert.equal(state.sent.map(x => x.text).join('').match(/dbg:/g).length, 1);
  assert.match(state.sent.at(-1).text, /dbg:.*\ncodex.*\nclaude.*\nq:/);
});

test('saved payload stays byte-identical when quota changes before a safe retry', async t => {
  const {relay, state, relayDb} = fixture(t, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('final')]};
  state.failReply = true; await relay.tick();
  const original = state.sent[0]; state.failReply = false;
  state.quota.codex.fiveHourRemainingPct = 12;
  await relay.tick();
  assert.deepEqual(state.sent[1], original);
  assert.equal(state.quotaCalls, 1);
  assert.equal(relayDb.prepare('SELECT count(*) n FROM reply_payloads').get().n, 1);
});

test('thread suppression, tenant isolation and NO_REPLY remain effective with footers enabled', async t => {
  for (const mode of ['suppressed', 'tenant', 'silent']) {
    const {relay, state, config} = fixture(t, true);
    state.suppressFooter = mode === 'suppressed';
    if (mode === 'tenant') config.ownerUserId = 'another-user';
    state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text: mode === 'silent' ? 'NO_REPLY' : 'answer'}]};
    await relay.tick();
    if (mode === 'silent') assert.equal(state.sent.length, 0);
    else { assert.equal(state.sent.length, 1); assert.doesNotMatch(state.sent[0].text, /dbg:/); }
  }
});

test('quota lookup failure still delivers the answer with honest unavailable telemetry', async t => {
  const {relay, state} = fixture(t, true); state.quotaFails = true;
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('final')]};
  assert.equal((await relay.tick()).completed, 1);
  assert.match(state.sent[0].text, /codex: no data/);
});

const update = (id, options = {}) => ({...answer(id, 'input-thread-1', 'commentary'), createdAt: '2026-01-02T00:00:00Z', ...options});

test('opted-in progress arrives once, keeps turn open and labels footer as update', async t => {
  const {relay, state, relayDb} = fixture(t, true, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [update('progress')]};
  assert.equal((await relay.tick()).completed, 0);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /msg:\*update\*/);
  await relay.tick(); assert.equal(state.sent.length, 1);
  state.pages['/api/threads/thread-1/messages?limit=200'].messages.push(answer('final'));
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 2);
  assert.match(state.sent[1].text, /msg:\*final\*/);
  assert.equal(relayDb.prepare('SELECT count(*) n FROM reply_payloads').get().n, 2);
});

test('progress rejects stale, untrusted, streaming, other-parent and internal messages', async t => {
  const {relay, state} = fixture(t, false, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [
    update('old', {createdAt: '2025-12-31T00:00:00Z'}), update('undated', {createdAt: null}),
    update('untrusted', {source: 'watcher-alert'}), update('stream', {state: 'streaming'}),
    update('other', {parentMessageId: 'another-parent'}), update('analysis', {phase: 'analysis'}),
    update('compact', {phase: 'context_compaction'}), update('tool', {role: 'tool'}),
    update('silent', {text: 'NO_REPLY'}),
  ]};
  assert.equal((await relay.tick()).completed, 0); assert.equal(state.sent.length, 0);
});

test('final already available suppresses unsent progress instead of replaying a backlog', async t => {
  const {relay, state} = fixture(t, false, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [update('progress'), answer('final')]};
  assert.equal((await relay.tick()).completed, 1); assert.equal(state.sent.length, 1);
  await relay.tick(); assert.equal(state.sent.length, 1);
});

test('uncertain progress stops later output without closing the turn', async t => {
  const {relay, state, inboxDb} = fixture(t, false, true);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [update('progress')]};
  state.failReply = true; assert.equal((await relay.tick()).ok, false);
  inboxDb.exec("INSERT INTO group_send VALUES('uncertain')");
  state.pages['/api/threads/thread-1/messages?limit=200'].messages.push(answer('final'));
  assert.equal((await relay.tick()).error, 'group_delivery_requires_review');
  assert.equal(state.sent.length, 1);
});

test('enabling progress without a valid activation cutoff fails closed', () => {
  for (const forwardProgressSince of [undefined, 'not-a-date']) {
    assert.throws(() => createScopedGroupRelay({config: {forwardProgressUpdates: true, forwardProgressSince}}), /group_progress_cutoff_required/);
  }
});


test('cutover cutoff leaves old scoped input unqueued while another group still runs', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const {createDeliveryRouteFence} = await import('../packages/connectors/src/whatsapp-delivery-route-fence.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fence-'));
  const dbPath = path.join(dir, 'route.sqlite'); const now = Date.parse('2026-01-02T00:00:00Z');
  const fence = createDeliveryRouteFence({dbPath, now: () => now});
  fence.activate({to:'temporary',evidence:{routeId:'temporary',checkedAt:new Date(now).toISOString(),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
  const {relay,state,inboxDb} = fixture(t,false,false,{routeControl:{threadId:'thread-1',routeId:'temporary',dbPath}});
  t.after(()=>{relay.close();fence.close();fs.rmSync(dir,{recursive:true,force:true});});
  inboxDb.exec("INSERT INTO group_input VALUES('wa-2','group-2','new','2026-01-02')");
  await relay.tick();
  assert.equal(state.posts.length,1); assert.match(state.posts[0].url,/thread-2/);
});

for (const activeRoute of ['temporary', 'successor']) {
  test(`explicit multi-thread relay fences persisted input with ${activeRoute} active`, async t => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const {createDeliveryRouteFence} = await import('../packages/connectors/src/whatsapp-delivery-route-fence.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-fence-'));
    const dbPath = path.join(dir, 'route.sqlite'); const now = Date.parse('2026-01-02T00:00:00Z');
    const fence = createDeliveryRouteFence({dbPath, now: () => now});
    fence.activate({to:activeRoute,evidence:{routeId:activeRoute,checkedAt:new Date(now).toISOString(),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
    const {relay,state,inboxDb} = fixture(t,false,false,{routeControl:{threadIds:['thread-1','thread-2'],routeId:'temporary',dbPath}});
    t.after(()=>{relay.close();fence.close();fs.rmSync(dir,{recursive:true,force:true});});
    inboxDb.exec("INSERT INTO group_input VALUES('wa-old-2','group-2','old','2026-01-01'); INSERT INTO group_input VALUES('wa-new-2','group-2','new','2026-01-02')");
    await relay.tick();
    assert.equal(state.posts.length,activeRoute==='temporary'?1:0);
    if (activeRoute==='temporary') {
      assert.match(state.posts[0].url,/thread-2/);
      assert.match(state.posts[0].body.text,/\n\nnew$/);
    }
    await relay.tick();
    assert.equal(state.posts.length,activeRoute==='temporary'?1:0);
    assert.equal(state.sent.length,0);
  });
}
