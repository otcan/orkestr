import assert from 'node:assert/strict';
import test from 'node:test';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';
import { operatorNoticeChatOwnerOnly, operatorNoticeText } from '../packages/connectors/src/whatsapp-scoped-operator-footer.js';

const ownerChat = 'owner-chat@g.us';
const memberChat = 'member-chat@g.us';
const config = {
  appendDebugFooter: true, ownerUserId: 'owner-a',
  groups: [{ chatId: ownerChat, name: 'Owner' }, { chatId: memberChat, name: 'Shared' }, { chatId: 'flagged@g.us', whatsappNonOwnerMembers: true }],
  participantAuthors: [{ chatId: memberChat }],
};
const quota = { codex: { weeklyRemainingPct: 80 }, claude: { fiveHourRemainingPct: 90, weeklyRemainingPct: 70 } };
const COMPACT = /^🚨 Disk full\n\ncodex wk: 80%\nclaude 5h: 90% wk: 70%\nq:0 · load:\d+% · api:\d+% · help:\/help$/;

test('an operator notice in the owner-only chat gets the compact notice footer, like a relayed Operator post', async () => {
  const seen = [];
  const text = await operatorNoticeText({ text: '🚨 Disk full', to: ownerChat, config, formatter, fetchQuota: async owner => { seen.push(owner); return { quota }; } });
  assert.match(text, COMPACT);
  assert.deepEqual(seen, ['owner-a']);
  assert.doesNotMatch(text, /⚡|🧠|▶|dbg:|unknown/);
  // It is exactly the footer the V1 relay gives an Operator post (router_update notice).
  const relayed = formatter.whatsappNoticeFooter({ message: { role: 'assistant', kind: 'notice' }, thread: { whatsAppDebugProviderQuota: quota }, deliveryType: 'router_update' });
  const normalize = value => value.replace(/load:\d+% · api:\d+%/, 'load · api');
  assert.equal(normalize(text.slice('🚨 Disk full\n\n'.length)), normalize(relayed));
  assert.equal(formatter.stripWhatsAppDebugFooter(text), '🚨 Disk full');
});

test('a failed or slow quota lookup still sends the notice with honest no-data lines', async () => {
  const failed = await operatorNoticeText({ text: '🚨 Disk full', to: ownerChat, config, formatter, fetchQuota: async () => { throw new Error('down'); } });
  assert.match(failed, /^🚨 Disk full\n\ncodex: no data\nclaude: no data\nq:0 · load:/);
  const started = Date.now();
  const slow = await operatorNoticeText({ text: '🚨 Disk full', to: ownerChat, config, formatter, fetchQuota: () => new Promise(() => {}) });
  assert.match(slow, /\ncodex: no data\n/);
  assert.ok(Date.now() - started < 3000);
});

test('no footer in a chat with members, without the opt-in, without a formatter, or over the size limit', async () => {
  assert.equal(operatorNoticeChatOwnerOnly(config, ownerChat), true);
  assert.equal(operatorNoticeChatOwnerOnly(config, memberChat), false);
  assert.equal(operatorNoticeChatOwnerOnly(config, 'flagged@g.us'), false);
  assert.equal(operatorNoticeChatOwnerOnly(config, 'unknown@g.us'), false);
  const fetchQuota = async () => ({ quota });
  for (const [to, options] of [[memberChat, {}], ['flagged@g.us', {}], [ownerChat, { config: { ...config, appendDebugFooter: false } }],
    [ownerChat, { formatter: null }], [ownerChat, { maxLength: 20 }]]) {
    assert.equal(await operatorNoticeText({ text: '🚨 Disk full', to, config, formatter, fetchQuota, ...options }), '🚨 Disk full', to);
  }
});

test('a notice text that already carries a footer is not footed twice', async () => {
  const once = await operatorNoticeText({ text: '🚨 Disk full', to: ownerChat, config, formatter, fetchQuota: async () => ({ quota }) });
  const twice = await operatorNoticeText({ text: once, to: ownerChat, config, formatter, fetchQuota: async () => ({ quota }) });
  assert.equal((twice.match(/help:\/help/g) || []).length, 1);
});
