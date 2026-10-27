import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const {readMediaFile = fs.readFile, uploadFailures = 0, now = Date.now, ...relayConfig} = extraConfig;
  Object.assign(config, relayConfig);
  const state = {posts: [], uploads: [], sent: [], reports: [], failReport: false, suppressUpdates: false, messageReads: 0, pages: {}, retired: new Set(), failReply: false,
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
    if (url.endsWith('/scoped-relay-delivery')) {
      state.reports.push({url, ...options});
      if (state.failReport) throw new Error('synthetic_report_failure');
      return {ok: true};
    }
    if (url.endsWith('/input')) {
      state.posts.push({url, ...options});
      return {message: {id: `input-${threadId}`}};
    }
    if (url.includes('/messages')) {
      state.messageReads++;
      // Pages hold what V1 stores. A plain read hides NO_REPLY finals like V1 does;
      // includeNoReply=1 keeps them, and an old V1 rejects the unknown flag.
      const flagged = url.endsWith('&includeNoReply=1');
      if (flagged) state.flaggedReads = (state.flaggedReads || 0) + 1;
      if (flagged && state.oldServer) throw Object.assign(new Error('query.includeNoReply is not allowed'), {status: 400});
      const page = state.pages[flagged ? url.slice(0, -'&includeNoReply=1'.length) : url] || {messages: []};
      return flagged ? page : {...page, messages: (page.messages || []).filter(m => !(m.role === 'assistant' && String(m.text || '').trim() === 'NO_REPLY'))};
    }
    return {thread: {ownerUserId: config.ownerUserId, codexModel: 'example-model', retired: state.retired.has(threadId),
      binding: {chatId: groupId, enabled: true, suppressWhatsAppDebugFooter: state.suppressFooter, suppressWhatsAppUpdates: state.suppressUpdates}}};
  };
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, formatter, env: {}, readMediaFile, now, send: async payload => {
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

test('a long reply is one message with the footer plus the full text as a Markdown document', async t => {
  const {relay, state} = fixture(t, true);
  const text = Array.from({length: 4000}, (_, i) => `word${i}`).join(' ');
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text}]};
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 2);
  assert.ok(state.sent[0].text.length <= 20000 + 4000);
  assert.match(state.sent[0].text, /^agent: word0 [\s\S]*\n\n… \(full reply attached\)\n\ndbg:.*\ncodex.*\nclaude.*\nq:/);
  assert.equal(state.sent[1].text, undefined);
  assert.deepEqual(state.sent[1].document, {filename: state.sent[1].document.filename, mimetype: 'text/markdown', text});
  assert.match(state.sent[1].document.filename, /^reply-[0-9a-f]{10}\.md$/);
  assert.notEqual(state.sent[0].requestId, state.sent[1].requestId);
  await relay.tick();
  assert.equal(state.sent.length, 2, 'neither send repeats');
});

test('a 2500-character reply with its footer is delivered as one message', async t => {
  const {relay, state} = fixture(t, true);
  const text = Array.from({length: 400}, (_, i) => `word${i}`).join(' ').slice(0, 2500);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text}]};
  await relay.tick();
  assert.equal(state.sent.length, 1);
  assert.ok(state.sent[0].text.startsWith(`agent: ${text}`));
  assert.match(state.sent[0].text, /\n\ndbg:/);
});

test('relay config maxReplyChars sets the budget for new payloads', async t => {
  const {relay, state} = fixture(t, false, false, {maxReplyChars: 1000});
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text: 'b '.repeat(1500)}]};
  await relay.tick();
  assert.equal(state.sent.length, 2);
  assert.ok(state.sent[0].text.length <= 1000);
  assert.equal(state.sent[1].document.text, 'b '.repeat(1500).trim());
});

test('a document send that fails is retried from the frozen payload without resending the message', async t => {
  const {relay, state, relayDb} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text: 'd '.repeat(15000)}]};
  // The message is confirmed; the document send then fails before confirmation.
  const original = state.sent.push.bind(state.sent);
  state.sent.push = payload => { const n = original(payload); state.failReply = n === 2; return n; };
  await relay.tick();
  state.failReply = false; state.sent.push = original;
  await relay.tick();
  assert.equal(state.sent.length, 3);
  assert.ok(state.sent[0].text);
  assert.deepEqual(state.sent[2], state.sent[1], 'the retried document is byte-identical');
  assert.equal(relayDb.prepare('SELECT count(*) n FROM reply_payloads').get().n, 1);
});

test('a payload frozen before the chunking change is retried with its stored chunks', async t => {
  const {relay, state, relayDb} = fixture(t, true);
  const legacy = ['agent: ' + 'c'.repeat(1393), 'c'.repeat(1400), 'c'.repeat(207)];
  const key = value => crypto.createHash('sha256').update(value).digest('hex');
  relayDb.prepare('INSERT INTO reply_payloads(id,chunks) VALUES(?,?)').run(key('wa-1:final'), JSON.stringify(legacy));
  // The first legacy chunk was confirmed before the deploy.
  relayDb.prepare("INSERT INTO replies VALUES(?,'sent')").run(`reply:${key('wa-1:final:0')}`);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), text: 'c'.repeat(3000)}]};
  await relay.tick();
  assert.deepEqual(state.sent.map(x => x.text), legacy.slice(1));
  assert.equal(state.quotaCalls, 0, 'no new payload is built');
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

test('a mirrored remote reply is reported once after its confirmed send, retrying without resending', async t => {
  const {relay, state} = fixture(t);
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [answer('local-final', 'other'), {...answer('remote-final'), source: 'remote-runtime', remoteMessageId: 'remote-1'}]};
  state.failReport = true;
  const failed = await relay.tick();
  assert.equal(failed.ok, false); assert.equal(failed.completed, 0);
  assert.equal(state.sent.length, 1); assert.equal(state.reports.length, 1);
  state.failReport = false;
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 1, 'the confirmed chunk is never resent');
  assert.equal(state.reports.length, 2);
  const report = state.reports[1];
  assert.equal(report.url, '/api/threads/thread-1/messages/remote-final/scoped-relay-delivery');
  assert.equal(report.method, 'POST');
  assert.equal(report.body.requestIds.length, 1);
  assert.match(report.body.requestIds[0], /^reply:[0-9a-f]{64}$/);
  assert.deepEqual(report.body.connectorMessageIds, ['sent-1']);
  await relay.tick();
  assert.equal(state.reports.length, 2);
});
test('local replies are not reported as remote deliveries', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('final')]};
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 1); assert.equal(state.reports.length, 0);
});

test('commentary honours the thread suppression; approval requests still reach the owner', async t => {
  const {relay, state} = fixture(t, false, true);
  state.suppressUpdates = true;
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [
    {...answer('progress', 'input-thread-1', 'commentary'), createdAt: '2026-01-02T00:00:00Z', cursor: 1},
    {...answer('approval', 'input-thread-1', 'awaiting_approval'), createdAt: '2026-01-02T00:00:01Z', cursor: 2},
  ]};
  assert.equal((await relay.tick()).completed, 0);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].requestId, /^reply:/);
  state.pages[page].messages.push({...answer('final'), cursor: 3});
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 2);
});

test('a late api-session reply to the newest completed input is sent once, within the window', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z') + 60_000;
  const {relay, state, inboxDb} = fixture(t, false, false, {now: () => clock});
  inboxDb.exec("UPDATE group_input SET created_at='2026-01-01T00:00:00.000Z'");
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [answer('fast-final')]};
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 1);
  const late = '/api/threads/thread-1/messages?limit=50';
  const coordinator = {...answer('coordinator'), source: 'api-session', text: 'agent: coordinator answer', createdAt: '2026-01-01T00:02:00Z', cursor: 9};
  state.pages[late] = {messages: [
    answer('fast-final'), coordinator,
    {...answer('other-source'), source: 'codex-app-server', createdAt: '2026-01-01T00:02:00Z'},
    {...answer('other-parent', 'elsewhere'), source: 'api-session', createdAt: '2026-01-01T00:02:00Z'},
  ]};
  clock += 20_000;
  await relay.tick();
  assert.equal(state.sent.length, 2);
  assert.equal(state.sent[1].text, 'agent: coordinator answer');
  assert.equal(state.sent[1].parentId, 'wa-1');
  clock += 20_000;
  await relay.tick();
  assert.equal(state.sent.length, 2, 'never resent');
  const reads = state.messageReads;
  await relay.tick();
  assert.equal(state.messageReads, reads, 'polled at most every ten seconds');
  clock += 7 * 60 * 60 * 1000;
  state.pages[late].messages.push({...coordinator, id: 'too-late', createdAt: new Date(clock).toISOString()});
  await relay.tick();
  assert.equal(state.sent.length, 2, 'outside the window nothing is sent');
});

test('an open route past the late-reply window is no longer re-read on every pass', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z') + 60_000;
  const {relay, state, inboxDb, relayDb} = fixture(t, false, false, {now: () => clock});
  const page = '/api/threads/thread-1/messages?limit=200';
  // A turn that never produced a final for its own input keeps its route open.
  state.pages[page] = {messages: [answer('other', 'elsewhere')]};
  assert.equal((await relay.tick()).routed, 1);
  let reads = state.messageReads;
  clock += 5 * 60 * 60 * 1000;
  await relay.tick();
  assert.ok(state.messageReads > reads, 'inside the window the open route is still watched');
  clock += 60 * 60 * 1000 + 1;
  reads = state.messageReads;
  inboxDb.exec(`INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-new','group-1','new','${new Date(clock).toISOString()}')`);
  state.pages[page] = {messages: [{id: 'input-thread-1', role: 'user'}, answer('final')]};
  const status = await relay.tick();
  assert.equal(state.posts.length, 2, 'a new input is still routed');
  // The new route reads the history once and the late-reply poll once; the stale route is not read.
  assert.equal(state.messageReads - reads, 2);
  assert.equal(status.completed, 1);
  // The age counts from routing, not from the WhatsApp time of a late-arriving message.
  inboxDb.exec(`INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-offline','group-2','queued on a phone','2025-12-01T00:00:00.000Z')`);
  await relay.tick();
  const opened = relayDb.prepare("SELECT opened_ms FROM route_opened WHERE id='wa-offline'").get();
  assert.equal(Number(opened.opened_ms), clock);
});

test('a NO_REPLY final closes its route at once and is never sent', async t => {
  const {relay, state, relayDb} = fixture(t);
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [{id: 'input-thread-1', role: 'user'}, {...answer('silent-final'), text: 'NO_REPLY', visibility: 'silent', silentReason: 'no_reply'}]};
  const status = await relay.tick();
  assert.equal(status.completed, 1);
  assert.ok(state.flaggedReads > 0, 'the relay reads pages with includeNoReply');
  assert.equal(state.sent.length, 0);
  assert.equal(relayDb.prepare("SELECT completed FROM routed WHERE id='wa-1'").get().completed, 1);
  const reads = state.messageReads;
  await relay.tick();
  assert.equal(state.messageReads, reads, 'a closed route is not re-read');
});

test('a silent no_reply final is never sent even when its text is not the token', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('silent-final'), text: 'internal reasoning', visibility: 'silent', silentReason: 'no_reply'}]};
  assert.equal((await relay.tick()).completed, 1);
  assert.equal(state.sent.length, 0);
});

test('a V1 without includeNoReply keeps the previous behaviour and is probed again later', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z') + 60_000;
  const {relay, state} = fixture(t, false, false, {now: () => clock});
  state.oldServer = true;
  const page = '/api/threads/thread-1/messages?limit=200';
  state.pages[page] = {messages: [{id: 'input-thread-1', role: 'user'}, {...answer('silent-final'), text: 'NO_REPLY'}]};
  let status = await relay.tick();
  assert.equal(status.routed, 1);
  assert.equal(status.completed, 0, 'the hidden NO_REPLY leaves the route open, as before');
  assert.equal(state.sent.length, 0);
  const flagged = state.flaggedReads;
  clock += 60_000; await relay.tick();
  assert.equal(state.flaggedReads, flagged, 'the rejected flag is not retried on every pass');
  state.oldServer = false; clock += 10 * 60 * 1000;
  status = await relay.tick();
  assert.equal(status.completed, 1, 'once V1 supports the flag the route closes');
  assert.equal(state.sent.length, 0);
});

test('a question on an open route restarts its late-reply window', async t => {
  const start = Date.parse('2026-01-01T00:00:00Z') + 60_000;
  let clock = start;
  const {relay, state} = fixture(t, false, false, {now: () => clock});
  const page = '/api/threads/thread-1/messages?limit=200';
  await relay.tick();
  clock += 5 * 60 * 60 * 1000;
  // The turn asks the owner and waits on the answer.
  state.pages[page] = {messages: [{...answer('question', 'input-thread-1', 'question'), createdAt: new Date(clock).toISOString()}]};
  await relay.tick();
  assert.equal(state.sent.length, 1, 'the question is delivered');
  clock += 5 * 60 * 60 * 1000;
  state.pages[page].messages.push({...answer('final'), createdAt: new Date(clock).toISOString()});
  assert.equal((await relay.tick()).completed, 1, 'its final, 10 h after routing but 5 h after the question, is still delivered');
  assert.equal(state.sent.length, 2);
});

test('a late reply is not sent while any transport delivery is uncertain', async t => {
  let clock = Date.parse('2026-01-01T00:01:00Z');
  const {relay, state, inboxDb} = fixture(t, false, false, {now: () => clock});
  inboxDb.exec("UPDATE group_input SET created_at='2026-01-01T00:00:00.000Z'");
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [answer('fast-final')]};
  await relay.tick();
  state.pages['/api/threads/thread-1/messages?limit=50'] = {messages: [{...answer('coordinator'), source: 'api-session', createdAt: '2026-01-01T00:02:00Z'}]};
  inboxDb.exec("INSERT INTO group_send VALUES('uncertain')");
  clock += 20_000;
  assert.equal((await relay.tick()).error, 'group_delivery_requires_review');
  assert.equal(state.sent.length, 1);
});

test('a reply-quote of an Orkestr reply reaches the thread as structured replyTo plus a visible line', async t => {
  const {relay, state, inboxDb, relayDb} = fixture(t, false, false, {ownChatId: '15550000001@c.us', timeZone: 'UTC'});
  inboxDb.exec(`CREATE TABLE group_input_quote(id TEXT PRIMARY KEY,quoted_id TEXT,author TEXT,sent_at TEXT,body TEXT,from_me INTEGER,resolved INTEGER NOT NULL);
    INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-2','group-1','no need','2026-01-03');
    INSERT INTO group_input_quote VALUES('wa-2','true_group-1_SENT1','15550000001@c.us',NULL,'short wa body',1,1);
    INSERT INTO group_input(id,chat_id,body,created_at) VALUES('wa-3','group-1','what?','2026-01-04');
    INSERT INTO group_input_quote VALUES('wa-3','GONE',NULL,NULL,NULL,0,0);`);
  relayDb.exec(`CREATE TABLE IF NOT EXISTS reply_sent_text(provider_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,text TEXT NOT NULL,sent_at TEXT NOT NULL);
    INSERT INTO reply_sent_text VALUES('true_group-1_SENT1','r','Should I look into gulsah next? Full sentence follows here.','2026-01-02T21:50:00Z');`);
  await relay.tick();
  const own = state.posts.find(p => /no need/.test(p.body.text));
  assert.deepEqual(own.body.replyTo, {messageId: 'true_group-1_SENT1', author: 'orkestr', sentAt: '2026-01-02T21:50:00Z',
    text: 'Should I look into gulsah next? Full sentence follows here.', isOwnReply: true});
  assert.match(own.body.text, /\[Replying to Orkestr message from 21:50: "Should I look into gulsah next\?[^"]*"\]\n\nno need$/);
  const gone = state.posts.find(p => /what\?/.test(p.body.text));
  assert.equal(gone.body.replyTo.unavailable, true);
  assert.match(gone.body.text, /\[Replying to an unavailable message\]/);
  const plain = state.posts.find(p => /hello/.test(p.body.text));
  assert.equal(plain.body.replyTo, undefined);
});

test('reply files follow the text once each and unresolved files are skipped', async t => {
  const {relay, state} = fixture(t, false, false, {replyMediaRoot: '/srv/uploads'});
  const final = {...answer('final'), attachments: [{id: 'att-1', encrypted: true}, {id: 'att-2', encrypted: true}, {id: 'att-3'}]};
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [final]};
  const file = {path: '/srv/uploads/thread-1/artifacts/abc-report.pdf', filename: 'report.pdf', mimetype: 'application/pdf', sha256: 'a'.repeat(64)};
  state.pages['/api/threads/thread-1/messages/final/scoped-relay-files'] = {files: [{id: 'att-1', ...file}, {id: 'att-3', ...file, filename: 'list.xlsx'}]};
  assert.equal((await relay.tick()).completed, 1);
  await relay.tick();
  assert.deepEqual(state.sent.map(s => s.text ?? s.file?.filename), ['agent: answer', 'report.pdf', 'list.xlsx']);
  assert.deepEqual(state.sent[1].file, file);
  assert.equal(state.sent[1].parentId, 'wa-1');
  assert.notEqual(state.sent[1].requestId, state.sent[2].requestId);
});

test('without a media root, reply files are not sent', async t => {
  const {relay, state} = fixture(t);
  state.pages['/api/threads/thread-1/messages?limit=200'] = {messages: [{...answer('final'), attachments: [{id: 'att-1'}]}]};
  await relay.tick();
  assert.deepEqual(state.sent.map(s => s.text), ['agent: answer']);
});
