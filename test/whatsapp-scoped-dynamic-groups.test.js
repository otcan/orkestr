import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {createDynamicGroupRegistry, eligibleGroups, validateDynamicGroups} from '../packages/connectors/src/whatsapp-scoped-dynamic-groups.js';

const own = '15550000001@c.us', staticGroup = '120000000001@g.us', newGroup = '120000000009@g.us';
const since = '2026-01-01T00:00:00.000Z';

function journal(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-dynamic-groups-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return {dir, dbPath: path.join(dir, 'transport.sqlite')};
}

function delegated(id, chatId, extra = {}) {
  return {id, name: `Synthetic ${id}`, ownerUserId: 'admin', createdAt: '2026-02-01T00:00:00.000Z',
    binding: {connector: 'whatsapp', enabled: true, chatId, mirrorToWhatsApp: false, remoteBackend: 'synthetic-v2',
      remoteThreadId: '00000000-0000-4000-8000-000000000001', remoteRuntimeEnabled: true, displayName: `Synthetic ${id}`}, ...extra};
}

test('only new delegated owner group threads are eligible', () => {
  const rules = {ownerUserId: 'admin', since: Date.parse(since)};
  const threads = [
    delegated('thread-new', newGroup),
    delegated('thread-old', '120000000002@g.us', {createdAt: '2025-12-31T00:00:00.000Z'}),
    delegated('thread-other-owner', '120000000003@g.us', {ownerUserId: 'someone'}),
    delegated('thread-retired', '120000000004@g.us', {retired: true}),
    delegated('thread-local', '120000000005@g.us', {binding: {...delegated('x', '120000000005@g.us').binding, remoteRuntimeEnabled: false}}),
    delegated('thread-mirror', '120000000006@g.us', {binding: {...delegated('x', '120000000006@g.us').binding, mirrorToWhatsApp: true}}),
    delegated('thread-direct', '15550000002@c.us'),
  ];
  assert.deepEqual([...eligibleGroups(threads, rules).keys()], [newGroup]);
  assert.equal(validateDynamicGroups({}), null);
  assert.throws(() => validateDynamicGroups({dynamicGroups: {enabled: true}}), /configuration_invalid/);
  assert.throws(() => validateDynamicGroups({dynamicGroups: {enabled: true, since, journals: ['relative']}}), /configuration_invalid/);
});

test('a registered group joins the transport live, without a contract change, and only for new messages', async t => {
  const {dir, dbPath} = journal(t);
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  let clock = now;
  const config = {ownChatId: own, activatedAt: since, groups: [{chatId: staticGroup, threadId: 'thread-1'}],
    mediaDir: path.join(dir, 'media'), dynamicGroups: {enabled: true, since}};
  const transport = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath, now: () => clock});
  const contract = () => {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try { return db.prepare("SELECT value FROM group_meta WHERE key='contract'").get().value; } finally { db.close(); }
  };
  const before = contract();
  const client = {info: {wid: {_serialized: own}}, sendMessage: async () => ({id: {_serialized: 'sent-1'}})};
  const message = (id, ts) => ({id: {_serialized: id}, fromMe: true, to: newGroup, body: 'hello', timestamp: ts / 1000});
  assert.equal(transport.hasGroup(newGroup), false);
  assert.equal(await transport.observe(client, message('before', now - 60000)), false);

  const registry = createDynamicGroupRegistry(dbPath, {now: () => clock, staticGroups: config.groups});
  t.after(() => registry.close());
  assert.equal(registry.register({chatId: newGroup, threadId: 'thread-new', name: 'Synthetic new'}).registered, true);
  assert.equal(registry.register({chatId: newGroup, threadId: 'thread-new', name: 'Synthetic new'}).registered, false, 'idempotent');
  assert.throws(() => registry.register({chatId: newGroup, threadId: 'thread-other'}), /chat_conflict/);
  assert.throws(() => registry.register({chatId: '120000000010@g.us', threadId: 'thread-1'}), /thread_conflict/);
  assert.equal(registry.register({chatId: staticGroup, threadId: 'thread-1'}).reason, 'static');
  clock = now + 2000;
  assert.equal(transport.hasGroup(newGroup), true);
  // History from before the registration is never imported; new messages are.
  assert.equal(await transport.observe(client, message('old', now - 1000)), false);
  assert.equal(await transport.observe(client, message('fresh', now + 1000)), true);
  assert.equal((await transport.sendText(client, newGroup, 'reply', 'main', {requestId: 'r-1', parentId: 'fresh'})).ok, true);
  assert.equal(contract(), before, 'the static contract is unchanged');
  assert.equal(transport.policyFields('h').groupCount, 2);

  // Removal: the transport stops at once; the rows are kept.
  assert.equal(registry.remove(newGroup, 'archived').removed, true);
  clock = now + 4000;
  assert.equal(transport.hasGroup(newGroup), false);
  assert.equal(await transport.observe(client, message('after-removal', now + 3000)), false);
  await assert.rejects(transport.sendText(client, newGroup, 'reply', 'main', {requestId: 'r-2', parentId: 'fresh'}), /scope_denied/);

  // A journal written with registrations reopens (restart) and keeps working without the block.
  transport.close();
  const plain = createScopedGroupTransport({config: {...config, dynamicGroups: undefined}, token: 'test-token', base: {}, dbPath, now: () => clock});
  t.after(() => plain.close());
  assert.equal(plain.hasGroup(staticGroup), true);
});

test('the native worker allows sends to registered groups only with dynamicGroups', t => {
  const {dbPath} = journal(t);
  const config = {workerAccountId: 'sender', ownChatId: own, activatedAt: since, journalPath: dbPath,
    groups: [{chatId: staticGroup, threadId: 'thread-1'}], routeControl: {routeId: 'r', dbPath: `${dbPath}.route`, threadIds: ['thread-1']},
    dynamicGroups: {enabled: true, since}};
  const policy = createScopedNativeWorkerPolicy(config);
  t.after(() => policy.close());
  const send = to => () => policy.checkRequest('POST', new URL('http://local/send-text'),
    {accountId: 'sender', to, text: 'x', requestId: 'q', parentId: 'p'});
  assert.doesNotThrow(send(staticGroup));
  assert.throws(send(newGroup));
  const registry = createDynamicGroupRegistry(dbPath, {staticGroups: config.groups});
  registry.register({chatId: newGroup, threadId: 'thread-new', name: 'n'});
  registry.close();
  return new Promise(resolve => setTimeout(resolve, 1100)).then(() => {
    assert.doesNotThrow(send(newGroup));
    assert.doesNotThrow(() => policy.checkRequest('GET', new URL(`http://local/accounts/sender/chats/${encodeURIComponent(newGroup)}/history?limit=20`)));
    const plain = createScopedNativeWorkerPolicy({...config, dynamicGroups: undefined});
    try { assert.throws(() => plain.checkRequest('POST', new URL('http://local/send-text'),
      {accountId: 'sender', to: newGroup, text: 'x', requestId: 'q', parentId: 'p'})); } finally { plain.close(); }
  });
});

test('the relay registers new delegated groups, routes their input, and removes archived ones', async t => {
  const {dbPath} = journal(t);
  const mirror = journal(t).dbPath;
  // The primary journal as the transport writes it.
  const seed = createScopedGroupTransport({config: {ownChatId: own, activatedAt: since, groups: [{chatId: staticGroup, threadId: 'thread-1'}],
    dynamicGroups: {enabled: true, since}}, token: 'test-token', base: {}, dbPath, now: () => Date.parse('2026-03-01T00:00:00Z')});
  seed.close();
  let clock = Date.parse('2026-03-01T00:00:00.000Z');
  const state = {threads: [delegated('thread-new', newGroup)], posts: [], logs: []};
  const api = async (url, options) => {
    if (url.startsWith('/api/threads/summary')) return {threads: state.threads};
    if (url.endsWith('/input')) { state.posts.push({url, ...options}); return {message: {id: 'input-1'}}; }
    if (url.includes('/messages')) return {messages: []};
    const id = url.split('/')[3];
    const thread = state.threads.find(x => x.id === id) || {ownerUserId: 'admin', binding: {chatId: staticGroup, enabled: true}};
    return {thread};
  };
  const config = {ownerUserId: 'admin', journalPath: dbPath, forwardProgressSince: since, replyPrefix: 'agent:',
    groups: [{chatId: staticGroup, threadId: 'thread-1', name: 'Static'}], dynamicGroups: {enabled: true, since, journals: [mirror]}};
  const inboxDb = new DatabaseSync(dbPath, {readOnly: true}), relayDb = new DatabaseSync(':memory:');
  const relay = createScopedGroupRelay({config, inboxDb, relayDb, api, env: {}, now: () => clock, log: e => state.logs.push(e),
    send: async () => ({ok: true, ids: ['sent-1']})});
  t.after(() => { relay.close(); inboxDb.close(); relayDb.close(); });

  let status = await relay.tick();
  assert.equal(status.groups, 2, `${JSON.stringify(status)}`);
  assert.deepEqual(state.logs.filter(e => e.event === 'group_registered').map(e => e.journal), ['primary', 'mirror']);
  const mirrorDb = new DatabaseSync(mirror, {readOnly: true});
  assert.equal(mirrorDb.prepare('SELECT thread_id FROM group_registered WHERE removed_at IS NULL').get().thread_id, 'thread-new');
  mirrorDb.close();
  // Input in the new group is routed to its thread.
  const writer = new DatabaseSync(dbPath);
  writer.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('wa-new-1', newGroup, 'hello new', '2026-03-01T00:00:01.000Z');
  writer.close();
  status = await relay.tick();
  assert.equal(state.posts.filter(p => p.url === '/api/threads/thread-new/input').length, 1);
  // The chat is archived (V1 thread retired): its registration is removed on the next poll.
  state.threads = [delegated('thread-new', newGroup, {retired: true})];
  clock += 31_000;
  status = await relay.tick();
  assert.equal(status.groups, 1);
  assert.equal(state.logs.filter(e => e.event === 'group_registration_removed').length, 2);
  // A V1 registry failure changes nothing and is reported once.
  state.threads = null;
  clock += 31_000;
  status = await relay.tick();
  assert.ok(status.errors.includes('group_registry_unavailable'));
});
