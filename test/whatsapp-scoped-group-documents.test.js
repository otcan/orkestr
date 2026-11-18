import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {GROUP_DOCUMENT_MAX_BYTES, GROUP_IMAGE_MAX_BYTES, groupMediaAllowed, groupMediaPolicy}
  from '../packages/connectors/src/whatsapp-scoped-group-inbound-media.js';
import {REMOTE_ATTACHMENT_MAX_BYTES} from '../packages/connectors/src/whatsapp-remote-attachment-upload.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

const MIB = 1024 * 1024;
const PDF = Buffer.from('%PDF-1.7\nsynthetic document\n%%EOF\n');

test('documents are attachable up to the delegated-thread ceiling; other types never are', () => {
  assert.equal(GROUP_DOCUMENT_MAX_BYTES, REMOTE_ATTACHMENT_MAX_BYTES, 'a V2 thread accepts no larger inbound file');
  assert.equal(GROUP_IMAGE_MAX_BYTES, 10 * MIB);
  assert.deepEqual(groupMediaPolicy('Application/PDF; name=x'), {mimetype: 'application/pdf', maxBytes: 16 * MIB, kind: 'document',
    extension: '.pdf', limitLabel: '16 MiB', fallbackName: 'document', attachedLabel: 'Document attached'});
  assert.equal(groupMediaPolicy('image/png').kind, 'image');
  for (const type of ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv', 'text/plain'])
    assert.equal(groupMediaPolicy(type).kind, 'document', type);
  for (const type of ['application/zip', 'application/x-msdownload', 'application/x-sh', 'text/html', 'image/svg+xml',
    'application/octet-stream', 'video/mp4', '', undefined])
    assert.equal(groupMediaPolicy(type), null, String(type));
  assert.equal(groupMediaAllowed('application/pdf', 16 * MIB), true);
  assert.equal(groupMediaAllowed('application/pdf', 16 * MIB + 1), false);
  assert.equal(groupMediaAllowed('image/jpeg', 10 * MIB + 1), false);
  assert.equal(groupMediaAllowed('application/zip', 10), false);
});

function transportFixture(t, dir) {
  const now = Date.now(), own = '15550000001@c.us', group = '120000000001@g.us';
  const dbPath = path.join(dir, 'group.sqlite'), mediaDir = path.join(dir, 'media');
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId: group, threadId: 'thread-1'}], mediaDir};
  const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath, now: () => now});
  t.after(() => p.close());
  const client = {info: {wid: {_serialized: own}}};
  const message = (id, extra) => ({id: {_serialized: id}, fromMe: true, to: group, body: '', timestamp: now / 1000, hasMedia: true, ...extra});
  const read = id => {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try {
      return {input: db.prepare('SELECT body FROM group_input WHERE id=?').get(id), media: db.prepare('SELECT * FROM group_input_media WHERE id=?').get(id)};
    } finally { db.close(); }
  };
  return {p, client, message, read, mediaDir};
}

test('the transport keeps a WhatsApp PDF like an image: private file, side-table row, body unchanged', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-documents-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {p, client, message, read, mediaDir} = transportFixture(t, dir);
  const pdf = message('owner-pdf-1', {type: 'document', body: 'please check this letter', _data: {filename: 'Letter 2026.pdf', mimetype: 'application/pdf', size: PDF.length},
    downloadMedia: async () => ({data: PDF.toString('base64'), mimetype: 'application/pdf'})});
  assert.equal(await p.observe(client, pdf), true);
  const {input, media} = read('owner-pdf-1');
  assert.equal(input.body, 'please check this letter');
  assert.equal(media.mimetype, 'application/pdf');
  assert.equal(media.filename, 'Letter 2026.pdf');
  assert.equal(media.size, PDF.length);
  assert.equal(path.dirname(media.path), path.resolve(mediaDir));
  assert.match(path.basename(media.path), /^[0-9a-f]{64}\.pdf$/);
  assert.deepEqual(await fs.readFile(media.path), PDF);
  assert.equal((await fs.stat(media.path)).mode & 0o777, 0o600);
});

test('the transport skips unsupported and oversized documents visibly; an announced oversize is not downloaded', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-documents-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {p, client, message, read} = transportFixture(t, dir);
  let downloads = 0;
  const big = message('owner-big-1', {type: 'document', _data: {mimetype: 'application/pdf', size: 16 * MIB + 1},
    downloadMedia: async () => { downloads++; return {data: PDF.toString('base64'), mimetype: 'application/pdf'}; }});
  assert.equal(await p.observe(client, big), true);
  assert.equal(downloads, 0);
  assert.equal(read('owner-big-1').input.body, '[WhatsApp attachment skipped: file exceeds 16 MiB limit]');
  assert.equal(read('owner-big-1').media, undefined);

  const zip = message('owner-zip-1', {type: 'document', body: 'archive', _data: {mimetype: 'application/zip', size: 4},
    downloadMedia: async () => ({data: Buffer.from('PK..').toString('base64'), mimetype: 'application/zip', filename: 'a.zip'})});
  assert.equal(await p.observe(client, zip), true);
  assert.equal(read('owner-zip-1').input.body, 'archive\n\n[WhatsApp attachment skipped: unsupported media type application/zip]');
  assert.equal(read('owner-zip-1').media, undefined);

  const unannounced = message('owner-big-2', {type: 'document',
    downloadMedia: async () => ({data: Buffer.alloc(16 * MIB + 1).toString('base64'), mimetype: 'application/pdf', filename: 'big.pdf'})});
  assert.equal(await p.observe(client, unannounced), true);
  assert.equal(read('owner-big-2').input.body, '[WhatsApp attachment skipped: file exceeds 16 MiB limit]');
  assert.equal(read('owner-big-2').media, undefined);
});

function relayFixture(t, mediaDir) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id TEXT,chat_id TEXT,body TEXT,created_at TEXT,media_path TEXT,media_filename TEXT,media_mimetype TEXT,media_size INTEGER);
    CREATE TABLE group_send(state TEXT);`);
  const config = {ownerUserId: 'admin', replyPrefix: 'agent:', mediaDir, forwardProgressSince: '2026-01-01T00:00:00Z',
    groups: [{chatId: 'group-1', threadId: 'thread-1', name: 'First'}]};
  const state = {posts: [], uploads: []};
  const api = async (url, options) => {
    if (url.startsWith('/api/quota/providers')) return {quota: {}};
    if (url.endsWith('/inbound-media')) {
      state.uploads.push(options.body);
      return {attachments: [{id: 'attachment-doc-1', name: 'letter.pdf', mimetype: 'application/pdf', path: '/server-owned/inbound/letter.pdf'}]};
    }
    if (url.endsWith('/scoped-relay-delivery')) return {ok: true};
    if (url.endsWith('/input')) { state.posts.push(options.body); return {message: {id: 'input-thread-1'}}; }
    if (url.includes('/messages')) return {messages: []};
    return {thread: {ownerUserId: 'admin', binding: {chatId: 'group-1', enabled: true}}};
  };
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, formatter, env: {}, send: async () => ({ok: true, ids: ['sent-1']})});
  t.after(() => { inboxDb.close(); relayDb.close(); });
  const insert = (id, body, file, name, mimetype, size) => inboxDb.prepare(`INSERT INTO group_input(id,chat_id,body,created_at,media_path,media_filename,media_mimetype,media_size)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, 'group-1', body, '2026-01-02', file, name, mimetype, size);
  return {relay, state, insert};
}

test('the relay uploads a kept document as a file attachment and names it when there is no caption', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-documents-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, insert} = relayFixture(t, dir);
  const file = path.join(dir, 'letter.pdf');
  await fs.writeFile(file, PDF);
  insert('wa-pdf', '', file, 'letter.pdf', 'application/pdf', PDF.length);
  await relay.tick();
  assert.equal(state.uploads.length, 1);
  const [meta] = JSON.parse(state.uploads[0].get('metadata'));
  assert.equal(meta.mimetype, 'application/pdf');
  assert.equal(meta.kind, 'file');
  assert.equal(meta.filename, 'letter.pdf');
  assert.equal(state.uploads[0].get('files').name, 'letter.pdf');
  assert.deepEqual(Buffer.from(await state.uploads[0].get('files').arrayBuffer()), PDF);
  const post = state.posts.find(body => /Document attached: letter\.pdf/.test(body.text));
  assert.ok(post);
  assert.equal(post.attachments[0].id, 'attachment-doc-1');
  assert.equal(await fs.stat(file).then(() => true, () => false), false, 'the staged copy is removed after upload');
});

test('the relay skips a document above 16 MiB or of an unsupported type without uploading it', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-group-documents-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const {relay, state, insert} = relayFixture(t, dir);
  const big = path.join(dir, 'big.pdf'), zip = path.join(dir, 'a.zip');
  await fs.writeFile(big, Buffer.alloc(16 * MIB + 1));
  await fs.writeFile(zip, Buffer.from('PK..'));
  insert('wa-big', 'big one', big, 'big.pdf', 'application/pdf', 16 * MIB + 1);
  insert('wa-zip', 'archive', zip, 'a.zip', 'application/zip', 4);
  await relay.tick();
  assert.equal(state.uploads.length, 0);
  for (const caption of ['big one', 'archive']) {
    const post = state.posts.find(body => body.text.includes(caption));
    assert.match(post.text, /attachment skipped: media unavailable or outside supported limits/);
    assert.equal(post.attachments, undefined);
  }
});
