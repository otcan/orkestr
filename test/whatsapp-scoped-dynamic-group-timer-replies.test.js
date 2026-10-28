// A group registered at runtime (dynamicGroups) gets its V2 timer and
// conversation-post replies like a static group under an allGroups scope.
// Before, the scope was built from the static `groups` list only, so a chat
// created after the relay started silently never received those replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createTimerNotificationProofStore, liveNotificationScope, notificationScope} from '../packages/connectors/src/whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createDynamicGroupRegistry} from '../packages/connectors/src/whatsapp-scoped-dynamic-groups.js';
import {remoteTimerParentEvent} from '../packages/connectors/src/whatsapp-scoped-remote-timer-replies.js';

const epoch = Date.parse('2026-01-01T00:00:00Z'), iso = ms => new Date(epoch + ms).toISOString();
const staticChat = '120000000001@g.us', newChat = '120000000009@g.us';

function fixture(t, {allGroups = true, register = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-group-timer-replies-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const journalPath = path.join(dir, 'transport.sqlite');
  let clock = epoch + 10000; const now = () => clock;
  const config = {ownChatId: '15550000001@c.us', ownerUserId: 'admin', activatedAt: iso(0), journalPath,
    mediaDir: path.join(dir, 'media'), groups: [{chatId: staticChat, threadId: 'thread-1', name: 'Static'}],
    dynamicGroups: {enabled: true, since: iso(0)},
    timerNotifications: {enabled: true, ...(allGroups ? {allGroups: true} : {threadIds: ['thread-1']}), since: iso(0), proofDbPath: ':memory:'},
    routeControl: {threadId: 'thread-1', routeId: 'temporary', dbPath: ':memory:'}};
  const fence = createDeliveryRouteFence({dbPath: ':memory:', now});
  fence.activate({to: 'temporary', evidence: {routeId: 'temporary', checkedAt: iso(10000), preserveExistingSince: iso(0), restrictionCleared: true, authenticated: true, ready: true, identityVerified: true, oldRouteStopped: true, legacyRouterDisabled: true, transportJournalsClear: true}});
  const proofs = createTimerNotificationProofStore({path: ':memory:', now});
  const transport = createScopedGroupTransport({config, token: 'test-only', base: {}, dbPath: journalPath, now, routeFence: fence, proofStore: proofs});
  if (register) {
    const registry = createDynamicGroupRegistry(journalPath, {now, staticGroups: config.groups});
    registry.register({chatId: newChat, threadId: 'thread-new', name: 'New chat'});
    registry.close();
  }
  // A coordinator post on the new chat's V2 conversation, as created at setup.
  const event = {type: remoteTimerParentEvent, threadId: 'thread-new', target: 'thread-new', targetType: 'thread', ownerUserId: 'admin',
    messageId: 'v2timer-post1', remoteBackend: 'example-backend', remoteThreadId: 'remote-new', remoteMessageId: 'post1', ts: iso(5000)};
  const parent = {id: 'v2timer-post1', role: 'user', source: 'orkestr-v2-timer', state: 'completed', text: 'Coordinator', timerId: 'post', postAuthor: 'coordinator',
    remoteBackend: 'example-backend', remoteThreadId: 'remote-new', remoteMessageId: 'post1', createdAt: iso(5000)};
  const answer = {id: 'answer1', role: 'assistant', state: 'completed', phase: 'final_answer', source: 'rust-v2-pilot',
    parentMessageId: parent.id, chatId: newChat, remoteBackend: 'example-backend', remoteThreadId: 'remote-new', remoteMessageId: 'export1',
    createdAt: iso(9000), text: 'This chat is connected.', cursor: 2};
  const binding = {chatId: newChat, enabled: true, mirrorToWhatsApp: false, remoteBackend: 'example-backend', remoteThreadId: 'remote-new', remoteRuntimeEnabled: true};
  const state = {sent: [], reports: []};
  const api = async (url, options = {}) => {
    if (url === '/api/timers') return {timers: []};
    if (url.startsWith('/api/events')) return {events: [event]};
    if (url.endsWith('/scoped-relay-delivery')) { state.reports.push({url, body: options.body}); return {ok: true}; }
    if (url.includes('/messages')) return {messages: [parent, answer]};
    if (url.includes('/quota/')) return {quota: {}};
    return {thread: {ownerUserId: 'admin', binding: url.includes('thread-new') ? binding : {...binding, chatId: staticChat, remoteThreadId: 'remote-static'}}};
  };
  const client = {info: {wid: {_serialized: config.ownChatId}}, sendMessage: async (to, text) => {
    state.sent.push({to, text}); return {id: {_serialized: 'sent-' + state.sent.length}};
  }};
  const notifier = createScopedTimerNotifications({config, api, env: {}, now, proofStore: proofs, routeFence: fence,
    send: p => transport.sendText(client, p.chatId, p.text, 'main', p)});
  t.after(() => { notifier.close(); transport.close(); proofs.close(); fence.close(); });
  return {notifier, state};
}

test('a registered group receives its V2 post reply once, through the transport proof check', async t => {
  const {notifier, state} = fixture(t);
  assert.equal((await notifier.tick()).sent, 1);
  assert.deepEqual(state.sent.map(s => s.to), [newChat]);
  assert.equal(state.sent[0].text, '🤖 Coordinator:\nThis chat is connected.');
  assert.equal(state.reports.length, 1);
  assert.match(state.reports[0].url, /\/api\/threads\/thread-new\/messages\/answer1\/scoped-relay-delivery$/);
  await notifier.tick();
  assert.equal(state.sent.length, 1);
});

test('an unregistered chat or an explicit thread list never grows', async t => {
  for (const options of [{register: false}, {allGroups: false}]) {
    const {notifier, state} = fixture(t, options);
    await notifier.tick();
    assert.equal(state.sent.length, 0);
    assert.equal(state.reports.length, 0);
  }
});

test('the live scope keeps static threads and chats authoritative', () => {
  const config = {groups: [{chatId: staticChat, threadId: 'thread-1'}], routeControl: {threadId: 'thread-1', routeId: 'r', dbPath: ':memory:'},
    timerNotifications: {enabled: true, allGroups: true, since: iso(0), proofDbPath: ':memory:'}};
  const scope = notificationScope(config);
  const view = {dynamic: () => [{chatId: newChat, threadId: 'thread-new'}, {chatId: staticChat, threadId: 'thread-spoof'}, {chatId: '120000000010@g.us', threadId: 'thread-1'}]};
  const live = liveNotificationScope(scope, view);
  assert.deepEqual(live.threads.keys(), ['thread-1', 'thread-new']);
  assert.equal(live.threads.get('thread-1'), staticChat);
  assert.equal(live.threads.get('thread-new'), newChat);
  assert.equal(live.threads.has('thread-spoof'), false);
  assert.equal(live.allowsChat(newChat), true);
  assert.equal(live.allowsChat('120000000010@g.us'), false);
  assert.equal(liveNotificationScope(scope, null), scope);
});
