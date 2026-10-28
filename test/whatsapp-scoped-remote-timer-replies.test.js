// Replies to V2 timer turns on a delegated relay thread, and V1 timer
// delegation notices, go out once through the timer notification journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createTimerNotificationProofStore} from '../packages/connectors/src/whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {remoteTimerParentEvent} from '../packages/connectors/src/whatsapp-scoped-remote-timer-replies.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

const epoch = Date.parse('2026-01-01T00:00:00Z'), iso = ms => new Date(epoch + ms).toISOString();
const chatId = '120000000001@g.us';

function fixture(t, {footer = false} = {}) {
  let clock = epoch + 10000; const now = () => clock;
  const config = {ownChatId: '15550000001@c.us', ownerUserId: 'admin', activatedAt: iso(0),
    groups: [{chatId, threadId: 'thread-1', name: 'Example'}], appendDebugFooter: footer,
    timerNotifications: {enabled: true, threadId: 'thread-1', since: iso(0), proofDbPath: ':memory:'},
    routeControl: {threadId: 'thread-1', routeId: 'temporary', dbPath: ':memory:'}};
  const fence = createDeliveryRouteFence({dbPath: ':memory:', now});
  fence.activate({to: 'temporary', evidence: {routeId: 'temporary', checkedAt: iso(10000), preserveExistingSince: iso(0), restrictionCleared: true, authenticated: true, ready: true, identityVerified: true, oldRouteStopped: true, legacyRouterDisabled: true, transportJournalsClear: true}});
  const proofs = createTimerNotificationProofStore({path: ':memory:', now});
  const event = {type: remoteTimerParentEvent, threadId: 'thread-1', target: 'thread-1', targetType: 'thread', ownerUserId: 'admin',
    messageId: 'v2timer-remote1', remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'remote1', ts: iso(5000)};
  const parent = {id: 'v2timer-remote1', role: 'user', source: 'orkestr-v2-timer', state: 'completed', text: 'Scheduled timer: Morning brief',
    remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'remote1', createdAt: iso(5000)};
  const answer = {id: 'answer1', role: 'assistant', state: 'completed', phase: 'final_answer', source: 'rust-v2-pilot',
    parentMessageId: parent.id, chatId, remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'acceptance1',
    createdAt: iso(9000), text: 'Good morning.', cursor: 2};
  // Owner-only relay binding as in a real owner group: the owner's two
  // accounts are both owner and authorized; no additional participants.
  const binding = {chatId, enabled: true, mirrorToWhatsApp: false, remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteRuntimeEnabled: true,
    allowOtherPeople: true, ownerContactIds: ['15550000001@c.us', '5550001@lid'], authorizedContactIds: ['15550000001@c.us', '5550001@lid'],
    additionalParticipantsEnabled: false, additionalParticipantIds: [], suppressWhatsAppDebugFooter: false, inboundSecurity: {}};
  const state = {events: [event], timers: [], messages: [parent, answer], binding, sent: [], reports: [], fail: false, reportFail: false};
  const api = async (url, options = {}) => {
    if (url === '/api/timers') return {timers: state.timers};
    if (url.startsWith('/api/events')) return {events: state.events};
    if (url.endsWith('/scoped-relay-delivery')) {
      if (state.reportFail) throw new Error('report_unavailable');
      state.reports.push({url, body: options.body});
      return {ok: true};
    }
    if (url.includes('/messages')) return {messages: state.messages};
    if (url.includes('/quota/')) return {quota: {}};
    return {thread: {ownerUserId: 'admin', binding: state.binding}};
  };
  const transport = createScopedGroupTransport({config, token: 'test-only', base: {}, dbPath: ':memory:', now, routeFence: fence, proofStore: proofs});
  const client = {info: {wid: {_serialized: config.ownChatId}}, sendMessage: async (to, text) => {
    state.sent.push({to, text}); if (state.fail) throw new Error('timeout');
    return {id: {_serialized: 'sent-' + state.sent.length}};
  }};
  const options = {config, api, formatter, env: {}, now, proofStore: proofs, routeFence: fence, send: p => p.document ? transport.sendDocument(client, p.chatId, p.document, 'main', p, media => ({media})) : transport.sendText(client, p.chatId, p.text, 'main', p)};
  const notifier = createScopedTimerNotifications(options);
  t.after(() => { notifier.close(); transport.close(); proofs.close(); fence.close(); });
  return {notifier, state, options, proofs, fence, advance: ms => clock += ms};
}

test('V2 Quick replies are marked with the Quick bolt, real timers keep the clock', async t => {
  for (const [parent, header] of [
    [{text: 'Quick reply', timerId: 'fast'}, '⚡ Quick reply'],
    [{text: 'Daily inbox check', timerId: 'timer-1'}, '⏰ Daily inbox check'],
  ]) {
    const {notifier, state} = fixture(t);
    Object.assign(state.messages[0], parent);
    assert.equal((await notifier.tick()).sent, 1);
    assert.equal(state.sent[0].text, `${header}\nGood morning.`);
  }
});

test('V2 Quick, coordinator and timer replies keep the owner footer; system posts do not', async t => {
  for (const [parent, layer, footer] of [
    [{text: 'Quick reply', timerId: 'fast'}, {remoteLayer: 'fast', remoteProvider: 'codex', remoteModel: 'example-luna'}, /\n\n⚡ Quick: codex example-luna · 🧠 Deep: pending · ▶ Quick\n/],
    [{text: 'Coordinator', timerId: 'post', postAuthor: 'coordinator'}, {remoteLayer: 'coordinator', remoteProvider: 'claude-code', remoteModel: 'opus-example', remoteIdentitySource: 'post'}, /\n\n⚡ Quick: — · 🧠 Coordinator: claude-code opus-example · ▶ Coordinator\n/],
    [{text: 'Daily inbox check', timerId: 'timer-1'}, {remoteLayer: 'deep', remoteProvider: 'codex'}, /\n\n⚡ Quick: — · 🧠 Deep: codex \? · ▶ Deep\n/],
  ]) {
    const {notifier, state} = fixture(t, {footer: true});
    Object.assign(state.messages[0], parent);
    Object.assign(state.messages[1], layer);
    assert.equal((await notifier.tick()).sent, 1);
    assert.match(state.sent[0].text, footer);
    assert.match(state.sent[0].text, /help:\/help$/);
  }
  // A system post is a notice: in this owner-only chat it carries only the
  // compact quota/load footer, with no Quick/Deep layer line.
  const {notifier, state} = fixture(t, {footer: true});
  Object.assign(state.messages[0], {text: 'Operator', timerId: 'post', postAuthor: 'operator'});
  assert.equal((await notifier.tick()).sent, 1);
  assert.match(state.sent[0].text, /^⚙️ System:\nGood morning\.\n\ncodex: no data\nclaude: no data\nq:0 · load:\d+% · api:\d+% · help:\/help$/, 'a system notice carries the compact footer');
  assert.doesNotMatch(state.sent[0].text, /⚡|🧠|▶|unknown/);
});

test('a system notice in a shared group carries no footer', async t => {
  const {notifier, state} = fixture(t, {footer: true});
  Object.assign(state.binding, {additionalParticipantsEnabled: true, additionalParticipantIds: ['15550000099@c.us']});
  Object.assign(state.messages[0], {text: 'Operator', timerId: 'post', postAuthor: 'operator'});
  assert.equal((await notifier.tick()).sent, 1);
  assert.equal(state.sent[0].text, '⚙️ System:\nGood morning.');
});

test('V2 conversation posts are labelled by author, never as timers', async t => {
  for (const [parent, header] of [
    [{text: 'Coordinator', timerId: 'post', postAuthor: 'coordinator'}, '🤖 Coordinator:'],
    [{text: 'Operator', timerId: 'post', postAuthor: 'operator'}, '⚙️ System:'],
    [{text: 'Question', timerId: 'post', postAuthor: 'assistant_question'}, '❓ Question:'],
    [{text: 'Operator', timerId: 'post'}, '⚙️ System:'],
    [{text: 'Coordinator', timerId: 'post'}, '🤖 Coordinator:'],
  ]) {
    const {notifier, state} = fixture(t);
    Object.assign(state.messages[0], parent);
    assert.equal((await notifier.tick()).sent, 1);
    assert.equal(state.sent[0].text, `${header}\nGood morning.`);
    assert.doesNotMatch(state.sent[0].text, /Timer/);
  }
});

test('a V2 timer reply on a delegated relay thread is delivered once and reported delivered', async t => {
  const {notifier, state, options} = fixture(t);
  assert.equal((await notifier.tick()).sent, 1);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].to, chatId);
  assert.match(state.sent[0].text, /^⏰ Morning brief\nGood morning\./);
  assert.equal(state.reports.length, 1);
  assert.match(state.reports[0].url, /\/api\/threads\/thread-1\/messages\/answer1\/scoped-relay-delivery$/);
  assert.equal(state.reports[0].body.requestIds.length, 1);
  assert.deepEqual(state.reports[0].body.connectorMessageIds, ['sent-1']);
  await notifier.tick();
  const resumed = createScopedTimerNotifications(options); await resumed.tick(); resumed.close();
  assert.equal(state.sent.length, 1);
  assert.equal(state.reports.length, 1);
});

test('a failed delivery report is retried without resending', async t => {
  const {notifier, state} = fixture(t);
  state.reportFail = true;
  await assert.rejects(notifier.tick(), /report_unavailable/);
  assert.equal(state.sent.length, 1);
  state.reportFail = false;
  await notifier.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.reports.length, 1);
  assert.deepEqual(state.reports[0].body.connectorMessageIds, ['sent-1']);
});

test('an uncertain send is never retried or reported, also after restart', async t => {
  const {notifier, state, options, fence} = fixture(t);
  state.fail = true;
  await assert.rejects(notifier.tick(), /unresolved/);
  const resumed = createScopedTimerNotifications(options);
  await assert.rejects(resumed.tick(), /unresolved/); resumed.close();
  assert.equal(state.sent.length, 1);
  assert.equal(state.reports.length, 0);
  assert.equal(fence.blocked(), true);
});

test('stale replies and disabled reply mirroring are reported as not sent so the remote input settles', async t => {
  for (const mode of ['stale', 'mirrorRepliesOff']) {
    const {notifier, state} = fixture(t);
    if (mode === 'stale') state.messages[1].createdAt = iso(-1000000);
    if (mode === 'mirrorRepliesOff') state.binding.mirrorReplies = false;
    await notifier.tick();
    assert.equal(state.sent.length, 0, mode);
    assert.equal(state.reports.length, 1, mode);
    assert.equal(state.reports[0].body.outcome, 'suppressed', mode);
    assert.equal(state.reports[0].body.reason, mode === 'stale' ? 'expired' : 'mirror_replies_disabled');
    await notifier.tick();
    assert.equal(state.reports.length, 1, mode);
  }
});

test('spoofed, foreign, silent and undelegated V2 timer replies never send or report', async t => {
  for (const mode of ['notDelegated', 'otherRemote', 'spoofedParent', 'wrongRemoteMessage', 'noRemoteAnswer', 'noReply', 'foreignOwner', 'mirrorOn', 'beforeCutoff']) {
    const {notifier, state} = fixture(t);
    if (mode === 'notDelegated') state.binding.remoteRuntimeEnabled = false;
    if (mode === 'otherRemote') state.binding.remoteThreadId = 'another-remote-thread';
    if (mode === 'spoofedParent') state.messages[0].source = 'timer_due';
    if (mode === 'wrongRemoteMessage') state.messages[0].remoteMessageId = 'other';
    if (mode === 'noRemoteAnswer') delete state.messages[1].remoteMessageId;
    if (mode === 'noReply') state.messages[1].text = 'NO_REPLY';
    if (mode === 'foreignOwner') state.events[0].ownerUserId = 'someone-else';
    if (mode === 'mirrorOn') state.binding.mirrorToWhatsApp = true;
    if (mode === 'beforeCutoff') state.events[0].ts = iso(-1000);
    await notifier.tick().catch(() => null);
    assert.equal(state.sent.length, 0, mode);
    assert.equal(state.reports.length, 0, mode);
  }
});

test('a V2 timer reply that has not arrived yet waits and is delivered when it does', async t => {
  const {notifier, state} = fixture(t);
  const answer = state.messages.pop();
  await notifier.tick();
  assert.equal(state.sent.length, 0);
  state.messages.push(answer);
  await notifier.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.reports.length, 1);
});

test('a V1 timer paused because its thread is delegated notifies the owner once', async t => {
  const {notifier, state} = fixture(t);
  state.timers = [{id: 'timer1', label: 'Daily check', ownerUserId: 'admin', target: 'thread-1', targetType: 'thread', enabled: false,
    cadence: 'daily', pausedReason: 'thread_delegated_to_remote_runtime', lastDelegationNoticeMessageId: 'notice1'}];
  state.events = [{type: 'thread_signal_appended', source: 'timer_delegation_fence', signalMode: 'notify_passively', ownerUserId: 'admin', threadId: 'thread-1', messageId: 'notice1', ts: iso(9000)}];
  state.messages = [{id: 'notice1', role: 'assistant', state: 'completed', phase: 'signal', source: 'timer_delegation_fence', signalMode: 'notify_passively',
    ownerUserId: 'admin', chatId, createdAt: iso(9000), text: 'Timer "Daily check" did not run: this chat is now handled by Orkestr V2, so V1 paused it.'}];
  assert.equal((await notifier.tick()).sent, 1);
  assert.match(state.sent[0].text, /^⏰ Daily check\nTimer "Daily check" did not run/);
  await notifier.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.reports.length, 0);
});

test('a delegation notice for a timer that was re-enabled or never paused does not send', async t => {
  for (const mode of ['reenabled', 'otherNotice', 'authSource']) {
    const {notifier, state} = fixture(t);
    state.timers = [{id: 'timer1', label: 'Daily check', ownerUserId: 'admin', target: 'thread-1', targetType: 'thread', enabled: mode === 'reenabled',
      cadence: 'daily', pausedReason: 'thread_delegated_to_remote_runtime', lastDelegationNoticeMessageId: mode === 'otherNotice' ? 'other' : 'notice1'}];
    const source = mode === 'authSource' ? 'timer_connector_health' : 'timer_delegation_fence';
    state.events = [{type: 'thread_signal_appended', source, signalMode: 'notify_passively', ownerUserId: 'admin', threadId: 'thread-1', messageId: 'notice1', ts: iso(9000)}];
    state.messages = [{id: 'notice1', role: 'assistant', state: 'completed', phase: 'signal', source, signalMode: 'notify_passively',
      ownerUserId: 'admin', chatId, createdAt: iso(9000), text: 'Paused.'}];
    await notifier.tick();
    assert.equal(state.sent.length, 0, mode);
  }
});

test('a long V2 timer reply is one message plus the full text as a Markdown document, reported together', async t => {
  const {state, options} = fixture(t);
  state.messages[1].text = 'Morning paragraph. '.repeat(1500);
  const env = {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '5000'};
  const notifier = createScopedTimerNotifications({...options, env});
  t.after(() => notifier.close());
  assert.equal((await notifier.tick()).sent, 2);
  assert.match(state.sent[0].text, /^⏰ Morning brief\nMorning paragraph\.[\s\S]*\n\n… \(full reply attached\)/);
  assert.ok(state.sent[0].text.length < 5000 + 4000);
  const {media} = state.sent[1].text;
  assert.equal(media.mimetype, 'text/markdown');
  assert.equal(Buffer.from(media.data, 'base64').toString('utf8'), `⏰ Morning brief\n${state.messages[1].text.trim()}`);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].body.requestIds.length, 2);
  assert.deepEqual(state.reports[0].body.connectorMessageIds, ['sent-1', 'sent-2']);
  const resumed = createScopedTimerNotifications({...options, env}); await resumed.tick(); resumed.close();
  assert.equal(state.sent.length, 2);
});
