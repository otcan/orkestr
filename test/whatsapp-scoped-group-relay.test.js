import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

function fixture(t, footer = false, progress = false, extraConfig = {}) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT,media_path TEXT,media_filename TEXT,media_mimetype TEXT,media_size INTEGER);
    CREATE TABLE group_send(state TEXT);
    INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-1','group-1','hello','2026-01-01');`);
  const config = {forwardProgressUpdates: progress, forwardProgressSince: '2026-01-01T00:00:00Z', ownerUserId: 'admin', appendDebugFooter: footer, replyPrefix: 'agent:', groups: [
    {chatId: 'group-1', threadId: 'thread-1', name: 'First'},
    {chatId: 'group-2', threadId: 'thread-2', name: 'Second'},
  ]};
  const {readMediaFile = fs.readFile, uploadFailures = 0, ...relayConfig} = extraConfig;
  Object.assign(config, relayConfig);
  const state = {posts: [], uploads: [], sent: [], pages: {}, retired: new Set(), failReply: false,
    suppressFooter: false, quotaFails: false, quotaCalls: 0, uploadFailures,
    quota: {codex: {fiveHourRemainingPct: 73}, claude: {weeklyRemainingPct: 64}}};
  const api = async (url, options) => {
    if (url.startsWith('/api/quota/providers')) {
      state.quotaCalls++;
      if (state.quotaFails) throw new Error('quota_unavailable');
      return {quota: state.quota};
    }
    if (url.endsWith('/inbound-media')) {
      state.uploads.push({url, ...options});
      if (state.uploadFailures > 0) { state.uploadFailures--; throw new Error('synthetic_upload_failure'); }
      return {attachments: [{id: 'attachment-safe-1', name: 'sample.png', mimetype: 'image/png', path: '/server-owned/inbound/media.png'}]};
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
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, formatter, env: {}, readMediaFile, send: async payload => {
    state.sent.push(payload);
    if (state.failReply) throw new Error('transport_disconnected');
    return {ok: true, ids: ['sent-1']};
  }});
  t.after(() => {inboxDb.close(); relayDb.close();});
  return {relay, state, inboxDb, relayDb, config};
}

test('staged media read failure is visible and still routes caption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, inboxDb} = fixture(t, false, false, {mediaDir: dir,
    readMediaFile: async () => { throw new Error('synthetic_staged_read_failure'); }});
  const mediaPath = path.join(dir, 'media.png');
  await fs.writeFile(mediaPath, Buffer.from('synthetic-image'));
  inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`).run('wa-read-error', 'group-1', 'caption survives', '2026-01-02', mediaPath, 'sample.png', 'image/png', 15);
  await relay.tick();
  const posts = state.posts.filter(post => post.url.endsWith('/input') && /caption survives/.test(post.body.text));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.text, /attachment skipped.*could not be read/i);
  assert.equal(state.uploads.length, 0);
  assert.equal(await fs.stat(mediaPath).then(() => true, () => false), false);
});

test('upload failures retry at most three polls, then visibly skip media and route caption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, inboxDb} = fixture(t, false, false, {mediaDir: dir, uploadFailures: 3});
  const mediaPath = path.join(dir, 'media.png');
  await fs.writeFile(mediaPath, Buffer.from('synthetic-image'));
  inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`).run('wa-upload-error', 'group-1', 'caption survives', '2026-01-02', mediaPath, 'sample.png', 'image/png', 15);
  await relay.tick();
  assert.equal(state.posts.filter(post => post.url.endsWith('/input') && /caption survives/.test(post.body.text)).length, 0);
  await relay.tick();
  assert.equal(state.posts.filter(post => post.url.endsWith('/input') && /caption survives/.test(post.body.text)).length, 0);
  await relay.tick();
  const posts = state.posts.filter(post => post.url.endsWith('/input') && /caption survives/.test(post.body.text));
  assert.equal(state.uploads.length, 3);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.text, /caption survives/);
  assert.match(posts[0].body.text, /attachment skipped.*upload failed after 3 attempts/i);
  assert.equal(posts[0].body.attachments, undefined);
  assert.equal(await fs.stat(mediaPath).then(() => true, () => false), false);
  await relay.tick();
  assert.equal(state.uploads.length, 3);
  assert.equal(state.posts.filter(post => post.url.endsWith('/input') && /caption survives/.test(post.body.text)).length, 1);
});

test('cached media upload recovery removes the staged copy after a restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, inboxDb, relayDb} = fixture(t, false, false, {mediaDir: dir});
  const mediaPath = path.join(dir, 'media.png');
  await fs.writeFile(mediaPath, Buffer.from('synthetic-image'));
  inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`).run('wa-cached-upload', 'group-1', 'cached caption', '2026-01-02', mediaPath, 'sample.png', 'image/png', 15);
  relayDb.prepare('INSERT INTO input_media_uploads(id,attachments,created_at) VALUES(?,?,?)')
    .run('wa-cached-upload', JSON.stringify([{id: 'attachment-safe-1', name: 'sample.png', mimetype: 'image/png', path: '/server-owned/inbound/media.png'}]), '2026-01-02');

  await relay.tick();
  const post = state.posts.find(item => item.url.endsWith('/input') && /cached caption/.test(item.body.text));
  assert.ok(post);
  assert.equal(state.uploads.length, 0);
  assert.equal(post.body.attachments[0].id, 'attachment-safe-1');
  assert.equal(await fs.stat(mediaPath).then(() => true, () => false), false);
});

test('scoped group media is uploaded through thread attachments and routed once with caption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, inboxDb, config} = fixture(t, false, false, {mediaDir: dir});
  const mediaPath = path.join(dir, 'media.png');
  await fs.writeFile(mediaPath, Buffer.from('synthetic-image'));
  inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`).run('wa-image', 'group-1', 'please inspect', '2026-01-02', mediaPath, 'sample.png', 'image/png', 15);

  await relay.tick();
  await relay.tick();
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].url, '/api/connectors/whatsapp/inbound-media');
  const form = state.uploads[0].body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('eventId'), 'wa-image');
  assert.equal(form.get('chatId'), 'group-1');
  assert.equal(JSON.parse(form.get('metadata'))[0].mimetype, 'image/png');
  assert.equal(Buffer.from(await form.get('files').arrayBuffer()).toString(), 'synthetic-image');
  const inputPosts = state.posts.filter(post => post.url.endsWith('/input'));
  const imagePost = inputPosts.find(post => /please inspect/.test(post.body.text));
  assert.ok(imagePost);
  assert.deepEqual(imagePost.body.attachments, [{id: 'attachment-safe-1', name: 'sample.png', mimetype: 'image/png', path: '/server-owned/inbound/media.png'}]);
  assert.equal(inputPosts.filter(post => /please inspect/.test(post.body.text)).length, 1);
  assert.equal(await fs.stat(mediaPath).then(() => true, () => false), false);
});

test('captionless supported image is visibly described and attached; unsupported media is visibly skipped', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, inboxDb} = fixture(t, false, false, {mediaDir: dir});
  const imagePath = path.join(dir, 'image.png');
  const docPath = path.join(dir, 'document.bin');
  const largePath = path.join(dir, 'large.jpg');
  await fs.writeFile(imagePath, Buffer.from('image'));
  await fs.writeFile(docPath, Buffer.from('document'));
  await fs.writeFile(largePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  const insert = inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`);
  insert.run('wa-empty-caption', 'group-1', '', '2026-01-02', imagePath, 'image.png', 'image/png', 5);
  insert.run('wa-unsupported', 'group-1', 'see attached', '2026-01-02', docPath, 'document.bin', 'application/pdf', 8);
  insert.run('wa-oversize', 'group-1', 'large image', '2026-01-02', largePath, 'large.jpg', 'image/jpeg', 10 * 1024 * 1024 + 1);
  await relay.tick();
  const posts = state.posts.filter(post => post.url.endsWith('/input'));
  assert.equal(state.uploads.length, 1);
  assert.match(posts.find(post => /Image attached: image.png/.test(post.body.text)).body.text, /Image attached: image.png/);
  const skipped = posts.find(post => /attachment skipped/.test(post.body.text));
  assert.ok(skipped);
  assert.equal(skipped.body.attachments, undefined);
  const oversize = posts.find(post => /large image/.test(post.body.text));
  assert.match(oversize.body.text, /attachment skipped/);
  assert.equal(oversize.body.attachments, undefined);
  assert.equal(await fs.stat(docPath).then(() => true, () => false), false);
  assert.equal(await fs.stat(largePath).then(() => true, () => false), false);
});
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
  inboxDb.exec("INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-2','group-2','hello','2026-01-02')");
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
  inboxDb.exec("INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-2','group-2','new','2026-01-02')");
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
    inboxDb.exec("INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-old-2','group-2','old','2026-01-01'); INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-new-2','group-2','new','2026-01-02')");
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

test('media evidence is read from the additive side table', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-media-side-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  t.after(() => {inboxDb.close(); relayDb.close();});
  inboxDb.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT,body TEXT,created_at TEXT);
    CREATE TABLE group_input_media(id TEXT PRIMARY KEY,path TEXT NOT NULL,filename TEXT,mimetype TEXT,size INTEGER);
    CREATE TABLE group_send(state TEXT);`);
  const mediaPath = path.join(dir, 'media.png');
  await fs.writeFile(mediaPath, Buffer.from('synthetic-image'));
  inboxDb.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('wa-side', 'group-1', 'with image', '2026-01-02');
  inboxDb.prepare('INSERT INTO group_input_media VALUES(?,?,?,?,?)').run('wa-side', mediaPath, 'sample.png', 'image/png', 15);
  const uploads = [], posts = [];
  const api = async (url, options) => {
    if (url.endsWith('/inbound-media')) { uploads.push(options); return {attachments: [{id: 'a1', name: 'sample.png', mimetype: 'image/png', path: '/server/inbound/a1.png'}]}; }
    if (url.endsWith('/input')) { posts.push(options); return {message: {id: 'input-1'}}; }
    if (url.includes('/messages')) return {messages: []};
    return {thread: {ownerUserId: 'admin', binding: {chatId: 'group-1', enabled: true}}};
  };
  const relay = createScopedGroupRelay({config: {ownerUserId: 'admin', replyPrefix: 'agent:', mediaDir: dir, groups: [{chatId: 'group-1', threadId: 'thread-1'}]},
    inboxDb, relayDb, api, formatter, env: {}, send: async () => ({ok: true, ids: ['s1']})});
  await relay.tick();
  assert.equal(uploads.length, 1);
  assert.equal(posts.length, 1);
});
