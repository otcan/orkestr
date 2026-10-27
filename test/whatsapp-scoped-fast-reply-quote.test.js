// A V2 Quick reply that answers one input of a burst quotes (reply-to) that
// WhatsApp input; a lone Quick reply, Deep replies and everything else do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {remoteLayerMetadata} from '../packages/connectors/src/whatsapp-remote-footer.js';
import {createRoutedInputLookup, createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createTimerNotificationProofStore} from '../packages/connectors/src/whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {remoteTimerParentEvent} from '../packages/connectors/src/whatsapp-scoped-remote-timer-replies.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

const epoch = Date.parse('2026-01-01T00:00:00Z'), iso = ms => new Date(epoch + ms).toISOString();
const chatId = '120000000001@g.us', own = '15550000001@c.us';
const waInput = `false_${chatId}_3EB0EXAMPLE01_${own}`;

test('V2 quoteSource maps to remoteQuoteSource only on a Fast reply naming its source input', () => {
  assert.deepEqual(remoteLayerMetadata({firstResponse: true, layer: 'fast', quoteSource: true, sourceInputId: 'input-1'}),
    {remoteLayer: 'fast', remoteOriginalInputId: 'input-1', remoteQuoteSource: true});
  assert.deepEqual(remoteLayerMetadata({firstResponse: true, layer: 'fast', sourceInputId: 'input-1'}),
    {remoteLayer: 'fast', remoteOriginalInputId: 'input-1'}, 'a lone Quick reply is not quoted');
  assert.equal(remoteLayerMetadata({firstResponse: true, quoteSource: true}).remoteQuoteSource, undefined, 'no source input');
  assert.equal(remoteLayerMetadata({firstResponse: true, quoteSource: 'true', sourceInputId: 'input-1'}).remoteQuoteSource, undefined);
  assert.equal(remoteLayerMetadata({phase: 'final_answer', layer: 'deep', quoteSource: true, sourceInputId: 'input-1'}).remoteQuoteSource, undefined, 'Deep');
  assert.equal(remoteLayerMetadata({firstResponse: true, quoteSource: true, sourceInputId: 'input-1'}, {timerId: 'post', postAuthor: 'coordinator'}).remoteQuoteSource, undefined);
});

function fixture(t, {routed = {[`thread-1|local-input-1`]: waInput}} = {}) {
  let clock = epoch + 10000; const now = () => clock;
  const config = {ownChatId: own, ownerUserId: 'admin', activatedAt: iso(0),
    groups: [{chatId, threadId: 'thread-1', name: 'Example'}],
    timerNotifications: {enabled: true, threadId: 'thread-1', since: iso(0), proofDbPath: ':memory:'},
    routeControl: {threadId: 'thread-1', routeId: 'temporary', dbPath: ':memory:'}};
  const fence = createDeliveryRouteFence({dbPath: ':memory:', now});
  fence.activate({to: 'temporary', evidence: {routeId: 'temporary', checkedAt: iso(10000), preserveExistingSince: iso(0), restrictionCleared: true, authenticated: true, ready: true, identityVerified: true, oldRouteStopped: true, legacyRouterDisabled: true, transportJournalsClear: true}});
  const proofs = createTimerNotificationProofStore({path: ':memory:', now});
  const event = {type: remoteTimerParentEvent, threadId: 'thread-1', target: 'thread-1', targetType: 'thread', ownerUserId: 'admin',
    messageId: 'v2timer-remote1', remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'remote1', ts: iso(5000)};
  // The owner's relayed WhatsApp input, as V1 recorded it when forwarding it to V2.
  const input = {id: 'local-input-1', role: 'user', source: 'whatsapp_group_relay', state: 'delivered', text: '[WhatsApp: Example]\n\nsecond question',
    remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'adapter-input-1', createdAt: iso(3000)};
  const parent = {id: 'v2timer-remote1', role: 'user', source: 'orkestr-v2-timer', state: 'completed', text: 'Quick reply', timerId: 'fast',
    remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'remote1', createdAt: iso(5000)};
  const answer = {id: 'answer1', role: 'assistant', state: 'completed', phase: 'final_answer', source: 'rust-v2-adapter',
    parentMessageId: parent.id, chatId, remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteMessageId: 'fast1',
    remoteLayer: 'fast', remoteOriginalInputId: 'adapter-input-1', remoteQuoteSource: true, createdAt: iso(9000), text: 'On it.', cursor: 2};
  const binding = {chatId, enabled: true, mirrorToWhatsApp: false, remoteBackend: 'example-backend', remoteThreadId: 'remote-thread', remoteRuntimeEnabled: true,
    allowOtherPeople: true, ownerContactIds: [own], authorizedContactIds: [own], additionalParticipantsEnabled: false, additionalParticipantIds: [],
    suppressWhatsAppDebugFooter: false, inboundSecurity: {}};
  const state = {events: [event], messages: [input, parent, answer], sent: [], payloads: [], reports: [], transportReports: []};
  const api = async (url, options = {}) => {
    if (url === '/api/timers') return {timers: []};
    if (url.startsWith('/api/events')) return {events: state.events};
    if (url.endsWith('/scoped-relay-delivery')) { state.reports.push({url, body: options.body}); return {ok: true}; }
    if (url.includes('/messages')) return {messages: state.messages};
    if (url.includes('/quota/')) return {quota: {}};
    return {thread: {ownerUserId: 'admin', binding: state.binding}};
  };
  state.binding = binding;
  const transport = createScopedGroupTransport({config, token: 'test-only', base: {}, dbPath: ':memory:', now, routeFence: fence, proofStore: proofs,
    report: entry => state.transportReports.push(entry)});
  const client = {info: {wid: {_serialized: own}}, sendMessage: async (to, text, options) => {
    state.sent.push({to, text, options});
    return {id: {_serialized: 'sent-' + state.sent.length}};
  }};
  const send = p => {
    state.payloads.push(p);
    return p.document ? transport.sendDocument(client, p.chatId, p.document, 'main', p, media => ({media})) : transport.sendText(client, p.chatId, p.text, 'main', p);
  };
  const options = {config, api, formatter, env: {}, now, proofStore: proofs, routeFence: fence, send,
    routedInput: (threadId, messageId) => routed[`${threadId}|${messageId}`] || ''};
  const notifier = createScopedTimerNotifications(options);
  t.after(() => { notifier.close(); transport.close(); proofs.close(); fence.close(); });
  // The transport recorded the owner's input when it arrived in the group.
  const observe = id => transport.observe(client, {id: {_serialized: id}, fromMe: true, to: chatId, body: 'second question', timestamp: (epoch + 3000) / 1000});
  return {notifier, state, options, observe, transport, client};
}

test('a burst Quick reply quotes the WhatsApp input it answers', async t => {
  const {notifier, state, observe} = fixture(t);
  assert.equal(await observe(waInput), true);
  assert.equal((await notifier.tick()).sent, 1);
  assert.equal(state.payloads[0].quotedMessageId, waInput);
  assert.deepEqual(state.sent[0].options, {sendSeen: false, quotedMessageId: waInput});
  assert.match(state.sent[0].text, /^⚡ Quick reply\nOn it\./);
  assert.equal(state.reports.length, 1);
});

test('only the first chunk of a burst Quick reply carries the quote', async t => {
  const {state, options, observe} = fixture(t);
  await observe(waInput);
  state.messages[2].text = 'Quick paragraph. '.repeat(1500);
  const notifier = createScopedTimerNotifications({...options, env: {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '5000'}});
  t.after(() => notifier.close());
  assert.equal((await notifier.tick()).sent, 2);
  assert.equal(state.payloads[0].quotedMessageId, waInput);
  assert.equal('quotedMessageId' in state.payloads[1], false);
  assert.deepEqual(state.sent[0].options, {sendSeen: false, quotedMessageId: waInput});
  assert.equal(state.sent[1].options.quotedMessageId, undefined);
});

test('lone Quick, Deep, timer and unresolvable replies are sent unquoted', async t => {
  for (const mode of ['lone', 'deep', 'realTimer', 'noRouted', 'noLocalInput', 'ambiguousInput', 'otherRemoteThread', 'lookupThrows']) {
    const {notifier, state, observe, options} = fixture(t, {routed: mode === 'noRouted' ? {} : undefined});
    await observe(waInput);
    const [input, parent, answer] = state.messages;
    if (mode === 'lone') delete answer.remoteQuoteSource;
    if (mode === 'deep') answer.remoteLayer = 'deep';
    if (mode === 'realTimer') parent.timerId = 'timer-1';
    if (mode === 'noLocalInput') state.messages.shift();
    if (mode === 'ambiguousInput') state.messages.push({...input, id: 'local-input-2'});
    if (mode === 'otherRemoteThread') input.remoteThreadId = 'another-remote-thread';
    let tick = notifier;
    if (mode === 'lookupThrows') {
      tick = createScopedTimerNotifications({...options, routedInput: () => { throw new Error('journal_unavailable'); }});
      t.after(() => tick.close());
    }
    assert.equal((await tick.tick()).sent, 1, mode);
    assert.equal('quotedMessageId' in state.payloads[0], false, mode);
    assert.deepEqual(state.sent[0].options, {sendSeen: false}, mode);
    assert.equal(state.reports.length, 1, mode);
  }
});

test('the transport drops a quote that names no input of the same chat and still sends', async t => {
  const now = Date.now(), other = '120000000002@g.us', reports = [], sent = [];
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId, threadId: 'thread-1'}, {chatId: other, threadId: 'thread-2'}]};
  const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now, report: entry => reports.push(entry)});
  t.after(() => p.close());
  const client = {info: {wid: {_serialized: own}}, sendMessage: async (to, text, options) => { sent.push({to, text, options}); return {id: {_serialized: 'agent-' + sent.length}}; }};
  for (const [id, to] of [['owner-1', chatId], ['owner-2', other]])
    assert.equal(await p.observe(client, {id: {_serialized: id}, fromMe: true, to, body: 'hello', timestamp: now / 1000}), true);
  const cases = [['owner-1', 'owner-1'], ['owner-2', undefined], ['unknown-id', undefined], [{id: 'owner-1'}, undefined], ['', undefined]];
  for (const [i, [quotedMessageId, expected]] of cases.entries()) {
    const r = await p.sendText(client, chatId, `reply ${i}`, 'main', {requestId: `r${i}`, parentId: 'owner-1', quotedMessageId});
    assert.equal(r.ok, true);
    assert.equal(sent[i].options.quotedMessageId, expected, String(quotedMessageId));
  }
  assert.equal(reports.filter(e => e.event === 'group_send_quote_dropped').length, 3);
  // The journal hash covers text and parent only: a retry with a different quote is the same request.
  assert.equal((await p.sendText(client, chatId, 'reply 0', 'main', {requestId: 'r0', parentId: 'owner-1'})).duplicate, true);
  assert.equal(sent.length, cases.length);
});

test('send-text whitelists accept a well-formed quotedMessageId and nothing else', () => {
  const now = Date.now();
  const config = {ownChatId: own, activatedAt: new Date(now - 1000).toISOString(), groups: [{chatId, threadId: 'thread-1'}]};
  const p = createScopedGroupTransport({config, token: 'test-token', base: {}, dbPath: ':memory:', now: () => now});
  try {
    const check = body => { let code = 200, passed = false; const res = {status: n => { code = n; return res; }, json: () => {}};
      p.middleware({method: 'POST', path: '/send-text', query: {}, body, get: () => 'Bearer test-token'}, res, () => { passed = true; }); return passed || code; };
    const body = {to: chatId, text: 'reply', accountId: 'main', requestId: 'r1', parentId: 'owner-1'};
    assert.equal(check(body), true);
    assert.equal(check({...body, quotedMessageId: waInput}), true);
    for (const quotedMessageId of [{id: waInput}, 'bad id', 'x'.repeat(257), 7]) assert.equal(check({...body, quotedMessageId}), 403);
    assert.equal(check({...body, quotedMsg: waInput}), 403);
  } finally { p.close(); }
  const worker = createScopedNativeWorkerPolicy({workerAccountId: 'existing', groups: [{threadId: 'thread1', chatId}], routeControl: {threadId: 'thread1'}});
  const url = new URL('/send-text', 'http://local');
  const body = {accountId: 'existing', to: chatId, text: 'reply', requestId: 'r1', parentId: 'p1'};
  worker.checkRequest('POST', url, {...body, quotedMessageId: waInput});
  worker.checkRequest('POST', url, {...body, notificationId: 'r1', quotedMessageId: waInput});
  for (const quotedMessageId of [{id: waInput}, 'bad id', 7]) assert.throws(() => worker.checkRequest('POST', url, {...body, quotedMessageId}), /denied/);
});

test('the routed input lookup reads one relay route read-only and never throws', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-quote-routed-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const dbPath = path.join(dir, 'relay.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE routed(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    INSERT INTO routed(id,thread_id,message_id) VALUES('${waInput}','thread-1','local-input-1');
    INSERT INTO routed(id,thread_id,message_id) VALUES('wa-a','thread-1','local-dup'),('wa-b','thread-1','local-dup');`);
  db.close();
  const routed = createRoutedInputLookup(dbPath);
  t.after(() => routed.close());
  assert.equal(routed.lookup('thread-1', 'local-input-1'), waInput);
  assert.equal(routed.lookup('thread-2', 'local-input-1'), '', 'another thread');
  assert.equal(routed.lookup('thread-1', 'local-dup'), '', 'ambiguous');
  assert.equal(routed.lookup('thread-1', 'missing'), '');
  assert.equal(createRoutedInputLookup(path.join(dir, 'absent.sqlite')).lookup('thread-1', 'local-input-1'), '');
  assert.equal(createRoutedInputLookup(undefined).lookup('thread-1', 'local-input-1'), '');
});
