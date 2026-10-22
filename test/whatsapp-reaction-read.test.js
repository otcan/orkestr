import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeReactions, readReactionSnapshots, serializeMessagesWithReactions} from '../packages/connectors/src/whatsapp-reaction-read.js';

const ownChatId = '15550000001@c.us';
const sender = (fromMe, extra = {}) => ({id: {_serialized: `r-${fromMe}`, fromMe}, msgId: {_serialized: 'm1'}, reaction: '👍', timestamp: 100, ack: 1, ...extra});

test('same emoji by us and them retains per-sender origin and target, not aggregate ownership', () => {
  const result = normalizeReactions({id: {_serialized: 'm1'}}, [{hasReactionByMe: true, senders: [sender(true), sender(false)]}], {ownChatId});
  assert.equal(result.reactionsStatus, 'available');
  assert.deepEqual(result.reactions.map(r => [r.messageId, r.emoji, r.origin, r.fromMe]), [['m1', '👍', 'us', true], ['m1', '👍', 'them', false]]);
  assert.equal(result.reactions[0].timestamp, '1970-01-01T00:01:40.000Z');
});

test('unmapped LID or conflicting ownership is unknown; exact own identity is sufficient', () => {
  const reactions = [sender(undefined, {senderId: '12345678@lid'}), sender(false, {senderId: ownChatId}), sender(undefined, {senderId: ownChatId})];
  const result = normalizeReactions({id: 'm1'}, [{senders: reactions}], {ownChatId});
  assert.deepEqual(result.reactions.map(r => r.origin), ['unknown', 'unknown', 'us']);
});

test('foreign parent and malformed data are never silently reported as no reactions', () => {
  const result = normalizeReactions({id: 'm1'}, [{senders: [sender(true, {msgId: 'other'}), sender(true, {reaction: ''})]}, {}]);
  assert.deepEqual(result, {reactions: [], reactionsStatus: 'partial'});
  assert.equal(normalizeReactions({id: 'm1'}, undefined).reactionsStatus, 'unavailable');
});

test('reaction failures preserve history and do not mark messages seen', async () => {
  let seen = 0;
  const messages = [{id: 'm0', hasReaction: false}, {id: 'm1', hasReaction: true, getReactions: async () => {throw Error('private provider details');}},
    {id: 'm2', hasReaction: true}, {id: 'm3', getReactions: async () => []}];
  for (const message of messages) message.sendSeen = () => {seen++;};
  const result = await serializeMessagesWithReactions(messages, m => ({id: m.id, body: 'preserved'}));
  assert.deepEqual(result.map(r => r.reactionsStatus), ['available', 'unavailable', 'unavailable', 'available']);
  assert.equal(result.every(r => r.body === 'preserved'), true);
  assert.equal(seen, 0);
});

test('hung provider is bounded to the configured concurrency and is not empty-success', async () => {
  let calls = 0;
  const messages = Array.from({length: 50}, (_, i) => ({id: `m${i}`, getReactions: () => {calls++; return new Promise(() => {});}}));
  const result = await readReactionSnapshots(messages, {timeoutMs: 10, concurrency: 2});
  assert.equal(calls, 2);
  assert.equal(result.length, 50);
  assert.equal(result.every(r => r.reactionsStatus === 'unavailable'), true);
});
