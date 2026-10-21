import assert from 'node:assert/strict';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {validateOperatorNotifications} from '../packages/connectors/src/whatsapp-scoped-operator-notices.js';

const own = '15550000001@c.us', group = '120000000001@g.us', other = '120000000002@g.us';
function fixture(t, operatorNotifications, send) {
  const now = Date.now();
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId: group, threadId: 'thread-1'}, {chatId: other, threadId: 'thread-2'}],
    ...(operatorNotifications ? {operatorNotifications} : {})};
  const transport = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now});
  t.after(() => transport.close());
  const client = {info: {wid: {_serialized: own}}, sendMessage: send || (async () => ({id: {_serialized: 'agent-' + Math.random()}}))};
  return {transport, client, config};
}
const notice = (id, extra = {}) => ({operatorNotice: true, requestId: 'opnotice:' + id, ...extra});

test('operator notice is journaled, deduped by request id, and needs no parent or proof', async t => {
  let sends = 0;
  const {transport, client} = fixture(t, {enabled: true, chatIds: [group]}, async () => ({id: {_serialized: 'out-' + ++sends}}));
  const first = await transport.sendText(client, group, '⚠️ disk 80%', 'main', notice('abcdefgh1'));
  assert.deepEqual(first, {ok: true, ids: ['out-1']});
  const again = await transport.sendText(client, group, '⚠️ disk 80%', 'main', notice('abcdefgh1'));
  assert.equal(again.duplicate, true);
  assert.equal(sends, 1);
});

test('operator notice is denied when disabled, for unlisted chats, and with parents, proofs or a bad id', async t => {
  const off = fixture(t, undefined);
  await assert.rejects(off.transport.sendText(off.client, group, 'x', 'main', notice('abcdefgh2')), /operator_notice_denied/);
  const {transport, client} = fixture(t, {enabled: true, chatIds: [group]});
  for (const [to, request] of [[other, notice('abcdefgh3')], [group, notice('abcdefgh4', {parentId: 'p'})],
      [group, notice('abcdefgh5', {notificationId: 'opnotice:abcdefgh5'})], [group, {operatorNotice: true, requestId: 'plain-id-123456'}],
      [group, notice('x')]])
    await assert.rejects(transport.sendText(client, to, 'x', 'main', request), /operator_notice_denied/);
});

test('operator notices are capped per hour', async t => {
  const {transport, client} = fixture(t, {enabled: true, chatIds: [group], maxPerHour: 2});
  await transport.sendText(client, group, 'a', 'main', notice('abcdefgh6'));
  await transport.sendText(client, group, 'b', 'main', notice('abcdefgh7'));
  await assert.rejects(transport.sendText(client, group, 'c', 'main', notice('abcdefgh8')), /operator_notice_rate_limited/);
});

test('an uncertain operator notice blocks further sends like any other send', async t => {
  const {transport, client} = fixture(t, {enabled: true, chatIds: [group]}, async () => null);
  await assert.rejects(transport.sendText(client, group, 'a', 'main', notice('abcdefgh9')), /delivery_uncertain/);
  await assert.rejects(transport.sendText(client, group, 'b', 'main', notice('abcdefghA')), /delivery_uncertain/);
});

test('operator notification config must list configured groups', () => {
  const groups = [{chatId: group, threadId: 't'}];
  assert.equal(validateOperatorNotifications({groups}), null);
  assert.equal(validateOperatorNotifications({groups, operatorNotifications: {enabled: false}}), null);
  for (const bad of [{enabled: true}, {enabled: true, chatIds: []}, {enabled: true, chatIds: [other]}, {enabled: true, chatIds: [group], maxPerHour: 0},
      {enabled: true, chatIds: [group], extra: 1}])
    assert.throws(() => validateOperatorNotifications({groups, operatorNotifications: bad}), /operator_notifications_configuration_invalid/);
});

test('the native worker policy admits only a well-formed operator notice body', t => {
  const config = {workerAccountId: 'sender', ownChatId: own, activatedAt: new Date(Date.now() - 1000).toISOString(),
    groups: [{chatId: group, threadId: 'thread-1'}], routeControl: {threadIds: ['thread-1'], routeId: 'r', dbPath: ':memory:'},
    operatorNotifications: {enabled: true, chatIds: [group]}};
  const policy = createScopedNativeWorkerPolicy(config, {createTransport: () => ({close() {}, hasGroup: () => false})});
  const url = new URL('http://x/send-text');
  const ok = {accountId: 'sender', to: group, text: 'hi', requestId: 'opnotice:abcdefgh1', operatorNotice: true};
  assert.doesNotThrow(() => policy.checkRequest('POST', url, ok));
  for (const patch of [{to: other}, {requestId: 'abcdefgh1'}, {parentId: 'p'}, {accountId: 'main'}, {text: ' '}, {mentions: ['x']}])
    assert.throws(() => policy.checkRequest('POST', url, {...ok, ...patch}), /scoped_worker_operation_denied/);
});
