import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {SCOPED_FILE_MAX_BYTES, readReplyFile, scopedFileMimetype, scopedFileSendKind, validReplyFileShape} from '../packages/connectors/src/whatsapp-scoped-reply-files.js';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function snapshot(t, threadId = 'thread-1', data = Buffer.from('%PDF-1.7 report'), name = 'report.pdf', mimetype = 'application/pdf') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-files-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = path.join(root, threadId, 'artifacts');
  fs.mkdirSync(dir, {recursive: true});
  const digest = sha(data);
  const file = path.join(dir, `${digest}-${name}`);
  fs.writeFileSync(file, data);
  return {root, data, file: {path: file, filename: name, mimetype, sha256: digest}};
}

test('a reply file is read only from its own thread snapshot with a matching digest', t => {
  const {root, data, file} = snapshot(t);
  assert.deepEqual(readReplyFile(file, {root, threadId: 'thread-1'}), data);
  const other = path.join(root, 'thread-2', 'artifacts');
  fs.mkdirSync(other, {recursive: true});
  const moved = path.join(other, path.basename(file.path));
  fs.copyFileSync(file.path, moved);
  const outside = path.join(root, 'secret.pdf');
  fs.writeFileSync(outside, data);
  const link = path.join(root, 'thread-1', 'artifacts', `${file.sha256}-link.pdf`);
  fs.symlinkSync(outside, link);
  for (const [bad, threadId] of [
    [{...file, path: moved}, 'thread-1'],
    [file, 'thread-2'],
    [{...file, path: outside}, 'thread-1'],
    [{...file, path: link}, 'thread-1'],
    [{...file, sha256: sha('other')}, 'thread-1'],
    [{...file, mimetype: 'not a type'}, 'thread-1'],
    [{...file, mimetype: 'Application/PDF'}, 'thread-1'],
    [{...file, mimetype: ''}, 'thread-1'],
    [{...file, filename: '../x.pdf'}, 'thread-1'],
    [{...file, path: 'relative.pdf'}, 'thread-1'],
    [{...file, extra: true}, 'thread-1'],
  ]) assert.throws(() => readReplyFile(bad, {root, threadId}), /reply_file_denied/);
  fs.writeFileSync(file.path, 'changed after staging');
  assert.throws(() => readReplyFile(file, {root, threadId: 'thread-1'}), /reply_file_denied/);
});

test('the worker accepts send-file only for listed groups and with a media root', () => {
  const config = {workerAccountId: 'existing', groups: [{threadId: 'thread1', chatId: '120000000001@g.us'}], routeControl: {threadId: 'thread1'}};
  const url = s => new URL(s, 'http://local');
  const body = {accountId: 'existing', to: '120000000001@g.us', path: '/srv/uploads/thread1/artifacts/a.pdf',
    filename: 'a.pdf', mimetype: 'application/pdf', sha256: 'a'.repeat(64), requestId: 'f1', parentId: 'p1'};
  assert.throws(() => createScopedNativeWorkerPolicy(config).checkRequest('POST', url('/send-file'), body), /denied/);
  const p = createScopedNativeWorkerPolicy({...config, replyMediaRoot: '/srv/uploads'});
  p.checkRequest('POST', url('/send-file'), body);
  for (const patch of [{to: '120000000002@g.us'}, {accountId: 'other'}, {mimetype: 'text/html\r\nx: 1'}, {mimetype: ''}, {sha256: 'x'},
    {path: 'relative'}, {parentId: undefined}, {notificationId: 'f1'}, {text: 'caption'}])
    assert.throws(() => p.checkRequest('POST', url('/send-file'), {...body, ...patch}), /denied/);
  assert.equal(validReplyFileShape({path: body.path, filename: body.filename, mimetype: body.mimetype, sha256: body.sha256}), true);
  // Any type in canonical form passes (ORK-827), including ones the worker never saw before.
  for (const mimetype of ['text/html', 'application/zip', 'text/csv', 'application/octet-stream', 'application/x-msdownload', 'model/gltf+json'])
    p.checkRequest('POST', url('/send-file'), {...body, filename: 'a.file', mimetype});
});

test('every type has a canonical form and a send kind; only inline media up to 16 MB stays media', () => {
  assert.equal(scopedFileMimetype('Text/HTML; charset=utf-8'), 'text/html');
  assert.equal(scopedFileMimetype('application/zip'), 'application/zip');
  for (const bad of [undefined, null, '', 'text', 'text/', '/html', 'text /html', 'text/html\nx: 1', 7])
    assert.equal(scopedFileMimetype(bad), 'application/octet-stream', String(bad));
  const MB = 1024 * 1024;
  assert.equal(scopedFileSendKind({mimetype: 'image/jpeg', size: 2 * MB}), 'image');
  assert.equal(scopedFileSendKind({mimetype: 'image/png', size: 16 * MB}), 'image');
  assert.equal(scopedFileSendKind({mimetype: 'video/mp4', size: MB}), 'video');
  assert.equal(scopedFileSendKind({mimetype: 'audio/mpeg', size: MB}), 'audio');
  for (const mimetype of ['image/png', 'video/mp4', 'audio/ogg'])
    assert.equal(scopedFileSendKind({mimetype, size: 16 * MB + 1}), 'document', `${mimetype} over 16 MB`);
  for (const mimetype of ['text/html', 'application/zip', 'text/csv', 'application/octet-stream', 'image/svg+xml', 'image/gif', 'video/quicktime', 'audio/wav'])
    assert.equal(scopedFileSendKind({mimetype, size: MB}), 'document', mimetype);
  assert.equal(SCOPED_FILE_MAX_BYTES, 64 * MB);
});

test('a reply file is one journaled send with the reply parent, dedupe and conflict rules', async t => {
  const {root, data, file} = snapshot(t);
  const now = Date.now(), own = '15550000001@c.us', group = '120000000001@g.us';
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId: group, threadId: 'thread-1'}], replyMediaRoot: root};
  const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now});
  t.after(() => p.close());
  const calls = [];
  const client = {info: {wid: {_serialized: own}}, sendMessage: async (to, content, options) => {
    calls.push({to, content, options}); return {id: {_serialized: `agent-${calls.length}`}};
  }};
  const media = m => ({media: m});
  await assert.rejects(p.sendFile(client, group, file, 'main', {requestId: 'f1', parentId: 'owner-1'}, media), /parent_required/);
  await p.observe(client, {id: {_serialized: 'owner-1'}, fromMe: true, to: group, body: 'send the pdf', timestamp: now / 1000});
  await assert.rejects(p.sendFile(client, group, {...file, sha256: sha('x')}, 'main', {requestId: 'f1', parentId: 'owner-1'}, media), /scope_denied/);
  await assert.rejects(p.sendFile(client, group, file, 'main', {requestId: 'f1', parentId: 'owner-1'}), /scope_denied/);
  const request = {requestId: 'f1', parentId: 'owner-1'};
  assert.deepEqual((await p.sendFile(client, group, file, 'main', request, media)).ids, ['agent-1']);
  assert.equal((await p.sendFile(client, group, file, 'main', request, media)).duplicate, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {sendSeen: false, sendMediaAsDocument: true});
  assert.equal(calls[0].content.media.filename, 'report.pdf');
  assert.deepEqual(Buffer.from(calls[0].content.media.data, 'base64'), data);
  await assert.rejects(p.sendText(client, group, 'text', 'main', request), /conflict/);
  const noRoot = createScopedGroupTransport({config: {...config, replyMediaRoot: undefined}, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now});
  t.after(() => noRoot.close());
  await noRoot.observe(client, {id: {_serialized: 'owner-1'}, fromMe: true, to: group, body: 'send the pdf', timestamp: now / 1000});
  await assert.rejects(noRoot.sendFile(client, group, file, 'main', request, media), /scope_denied/);
});

test('an HTML page, a ZIP, a CSV and an unknown type each go as a document under their own name; photos stay media', async t => {
  const now = Date.now(), own = '15550000001@c.us', group = '120000000001@g.us';
  const cases = [
    ['weekly-plan.html', 'text/html', Buffer.from('<!doctype html><title>Plan</title>'), 'document'],
    ['October package.zip', 'application/zip', Buffer.from('PK\x03\x04 synthetic'), 'document'],
    ['totals.csv', 'text/csv', Buffer.from('a,b\n1,2\n'), 'document'],
    ['model.weights', 'application/octet-stream', Buffer.from([0, 1, 2, 3]), 'document'],
    ['chart.png', 'image/png', Buffer.from('\x89PNG synthetic'), 'image'],
    ['clip.mp4', 'video/mp4', Buffer.from('synthetic mp4'), 'video'],
  ];
  let n = 0;
  for (const [name, mimetype, bytes, kind] of cases) {
    const {root, data, file} = snapshot(t, 'thread-1', bytes, name, mimetype);
    const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId: group, threadId: 'thread-1'}], replyMediaRoot: root};
    const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now});
    t.after(() => p.close());
    const calls = [];
    const client = {info: {wid: {_serialized: own}}, sendMessage: async (to, content, options) => {
      calls.push({to, content, options}); return {id: {_serialized: `agent-${++n}`}};
    }};
    await p.observe(client, {id: {_serialized: 'owner-1'}, fromMe: true, to: group, body: 'send it', timestamp: now / 1000});
    const sent = await p.sendFile(client, group, file, 'main', {requestId: `f-${n + 1}`, parentId: 'owner-1'}, m => ({media: m}));
    assert.equal(sent.ids.length, 1, name);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(calls[0].options, {sendSeen: false, sendMediaAsDocument: kind === 'document'}, name);
    assert.equal(calls[0].content.media.filename, name);
    assert.equal(calls[0].content.media.mimetype, mimetype);
    assert.deepEqual(Buffer.from(calls[0].content.media.data, 'base64'), data, name);
  }
});

test('a document whose send returns no model is confirmed by its own filename', async t => {
  const now = Date.now(), own = '15550000001@c.us', group = '120000000001@g.us';
  const {root, file} = snapshot(t, 'thread-1', Buffer.from('<p>plan</p>'), 'plan.html', 'text/html');
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId: group, threadId: 'thread-1'}], replyMediaRoot: root};
  const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now, sendLookupDelayMs: 1});
  t.after(() => p.close());
  const sentAt = Math.floor(now / 1000);
  const own_ = (type, filename, id) => ({id: {_serialized: id}, fromMe: true, timestamp: sentAt, ack: 1, type, _data: {filename}});
  const client = {info: {wid: {_serialized: own}}, sendMessage: async () => undefined,
    getChatById: async () => ({fetchMessages: async () => [own_('document', 'other.html', 'x-1'), own_('document', 'plan.html', 'x-2')]})};
  await p.observe(client, {id: {_serialized: 'owner-1'}, fromMe: true, to: group, body: 'send it', timestamp: now / 1000});
  const sent = await p.sendFile(client, group, file, 'main', {requestId: 'f-plan', parentId: 'owner-1'}, m => ({media: m}));
  assert.deepEqual(sent.ids, ['x-2']);
});
