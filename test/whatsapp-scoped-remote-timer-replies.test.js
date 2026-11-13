// Replies to V2 timer turns on a delegated relay thread, and V1 timer
// delegation notices, go out once through the timer notification journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createTimerNotificationProofStore, notificationKey} from '../packages/connectors/src/whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {remoteTimerParentEvent, QUICK_MAX_AGE_MS} from '../packages/connectors/src/whatsapp-scoped-remote-timer-replies.js';
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

test('conversation transport replies stay plain and are delivered once', async t => {
  for (const parent of [
    {text: 'Coordinator', timerId: 'post', postAuthor: 'coordinator'},
    {text: 'Operator', timerId: 'post', postAuthor: 'operator'},
    {text: 'Question', timerId: 'post', postAuthor: 'assistant_question'},
    {text: 'Web transport excerpt', timerId: 'web'},
    {text: 'Internal result reference', timerId: 'task-update'},
    {text: 'Quick reply', timerId: 'fast'},
    {text: 'Status', timerId: 'status'},
  ]) {
    const {notifier, state} = fixture(t);
    Object.assign(state.messages[0], parent);
    assert.equal((await notifier.tick()).sent, 1);
    assert.equal(state.sent[0].text, 'Good morning.');
    assert.equal((await notifier.tick()).sent, 0);
    assert.equal(state.sent.length, 1);
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

// A V2 Quick reply for an input whose Deep final V1 already has was withdrawn
// by the V2 adapter's ordering fence: it must never go out late, neither on a
// first pass nor when a prepared send resumes after a relay restart.
function quickFixture(t) {
  const f = fixture(t);
  Object.assign(f.state.messages[0], {text: 'Quick reply', timerId: 'fast'});
  Object.assign(f.state.messages[1], {remoteLayer: 'fast', remoteOriginalInputId: 'input-a', text: 'Checking the status now.'});
  const input = {id: 'local-input-a', role: 'user', state: 'completed', remoteBackend: 'example-backend', remoteThreadId: 'remote-thread',
    remoteMessageId: 'input-a', createdAt: iso(4000), text: 'Status?'};
  const deep = {id: 'deep-a', role: 'assistant', state: 'completed', phase: 'final_answer', source: 'rust-v2-pilot', parentMessageId: input.id, chatId,
    remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'deep-export-a', remoteLayer: 'deep',
    remoteOriginalInputId: 'input-a', deliveryState: 'delivered', createdAt: iso(9500), text: 'Registration confirmed.', cursor: 3};
  f.state.messages.unshift(input);
  return {...f, input, deep};
}

test('a Quick reply whose input already has its Deep final is dropped and reported not sent', async t => {
  for (const mode of ['delivered', 'pending', 'parentOnly']) {
    const {notifier, state, deep} = quickFixture(t);
    if (mode === 'pending') delete deep.deliveryState;
    if (mode === 'parentOnly') delete deep.remoteOriginalInputId;
    state.messages.push(deep);
    await notifier.tick();
    assert.equal(state.sent.length, 0, mode);
    assert.equal(state.reports.length, 1, mode);
    assert.match(state.reports[0].url, /\/messages\/answer1\/scoped-relay-delivery$/);
    assert.deepEqual(state.reports[0].body, {outcome: 'suppressed', reason: 'superseded_by_final'}, mode);
    await notifier.tick();
    assert.equal(state.sent.length, 0, mode);
    assert.equal(state.reports.length, 1, mode);
  }
});

test('a Deep final for another input, or a sibling Quick, does not drop a Quick reply', async t => {
  const {notifier, state, deep} = quickFixture(t);
  state.messages.push({...deep, remoteOriginalInputId: 'input-b', parentMessageId: 'local-input-b'},
    {...deep, id: 'quick-sibling', remoteLayer: 'fast', parentMessageId: 'v2timer-other'});
  assert.equal((await notifier.tick()).sent, 1);
  assert.match(state.sent[0].text, /^Checking the status now\./);
  assert.equal(state.reports[0].body.requestIds.length, 1);
});

test('a prepared Quick reply resumed after a relay restart is revoked once its Deep final exists', async t => {
  const {state, options, proofs, deep} = quickFixture(t);
  const id = 'timer:' + notificationKey(['thread-1', 'v2timer-remote1']) + ':0';
  proofs.prepareBatch([{id, threadId: 'thread-1', chatId, timerId: 'fast', parentId: 'v2timer-remote1', answerId: 'answer1',
    text: '⚡ Quick reply\nChecking the status now.', createdAt: iso(9000), runAt: iso(5000), expiresAt: iso(909000)}]);
  state.messages.push(deep);
  const resumed = createScopedTimerNotifications(options);
  t.after(() => resumed.close());
  await resumed.tick();
  assert.equal(state.sent.length, 0);
  assert.equal(proofs.get(id).state, 'revoked');
  assert.deepEqual(state.reports.map(r => r.body), [{outcome: 'suppressed', reason: 'superseded_by_final'}]);
});

test('a Deep final imported while a Quick reply is being prepared still stops the send', async t => {
  const {notifier, state, deep} = quickFixture(t);
  let reads = 0;
  const base = [...state.messages];
  Object.defineProperty(state, 'messages', {get: () => (++reads > 1 ? [...base, deep] : base)});
  await notifier.tick();
  assert.equal(state.sent.length, 0);
  assert.deepEqual(state.reports.map(r => r.body), [{outcome: 'suppressed', reason: 'superseded_by_final'}]);
});

test('a Quick reply older than its staleness bound is never sent, even without a final', async t => {
  const {notifier, state, advance} = quickFixture(t);
  advance(QUICK_MAX_AGE_MS + 1);
  await notifier.tick();
  assert.equal(state.sent.length, 0);
  assert.deepEqual(state.reports.map(r => r.body), [{outcome: 'suppressed', reason: 'quick_stale'}]);
  // A timer reply of the same age is not a Quick reply and still goes out.
  const other = fixture(t);
  other.advance(QUICK_MAX_AGE_MS + 1);
  assert.equal((await other.notifier.tick()).sent, 1);
});

// ORK-819: every V2 pseudo-timer reply went out with the compact notice
// footer (no agent, no message type), and status lines and progress notes
// were never marked as updates.
test('each V2 pseudo-timer reply kind carries its agent and message type in the footer', async t => {
  const agent = {remoteProvider: 'codex', remoteModel: 'example-model', remoteLayer: 'deep', remoteIdentitySource: 'run'};
  const quota = '\ncodex: no data\nclaude: no data\nq:0 · ';
  const cases = [
    ['scheduled timer answer', {text: 'Scheduled timer: Morning brief', timerId: '00000000-0000-4000-8000-000000000001'}, agent,
      /^⏰ Morning brief\nGood morning\.\n\n🤖 codex example-model · msg:\*final\*\n/],
    ['adapter status line', {text: 'Status', timerId: 'status'}, agent, /^Good morning\.\n\n🤖 codex example-model · msg:\*update\*\n/],
    ['status line without a verified run', {text: 'Status', timerId: 'status'}, {}, /^Good morning\.\n\n🤖 Agent · msg:\*update\*\n/],
    ['web progress note', {text: 'Web progress: excerpt', timerId: 'web-progress'}, agent, /\n\n🤖 codex example-model · msg:\*update\*\n/],
    ['task progress note', {text: 'Task update', timerId: 'task-update-progress'}, agent, /\n\n🤖 codex example-model · msg:\*update\*\n/],
    ['web answer', {text: 'Web answer: excerpt', timerId: 'web'}, agent, /\n\n🤖 codex example-model · msg:\*final\*\n/],
    ['task answer', {text: 'Task update', timerId: 'task-update'}, agent, /\n\n🤖 codex example-model · msg:\*final\*\n/],
    ['coordinator post', {text: 'Coordinator', timerId: 'post', postAuthor: 'coordinator'},
      {remoteProvider: 'claude', remoteModel: 'example-opus', remoteLayer: 'coordinator', remoteIdentitySource: 'post'},
      /\n\n🤖 claude example-opus · msg:\*final\*\n/],
  ];
  for (const [name, parent, identity, footer] of cases) {
    const {notifier, state} = fixture(t, {footer: true});
    Object.assign(state.messages[0], parent);
    Object.assign(state.messages[1], identity);
    assert.equal((await notifier.tick()).sent, 1, name);
    assert.match(state.sent[0].text, footer, name);
    assert.ok(state.sent[0].text.includes(quota), name);
  }
  // A notice keeps the compact footer: no agent line, no message type.
  for (const [name, parent, identity] of [
    ['operator post', {text: 'Operator', timerId: 'post', postAuthor: 'operator'}, agent],
    ['owner web message mirror', {text: 'Web message', timerId: 'web'}, {remoteLayer: 'notice'}],
  ]) {
    const {notifier, state} = fixture(t, {footer: true});
    Object.assign(state.messages[0], parent);
    Object.assign(state.messages[1], identity);
    assert.equal((await notifier.tick()).sent, 1, name);
    assert.match(state.sent[0].text, /^Good morning\.\n\ncodex: no data\nclaude: no data\nq:0 · /, name);
    assert.doesNotMatch(state.sent[0].text, /🤖|msg:/, name);
  }
});
