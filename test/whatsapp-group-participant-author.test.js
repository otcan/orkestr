import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createGroupParticipantPolicy} from '../packages/connectors/src/whatsapp-group-participant-author.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

const now = Date.parse('2026-01-03T00:00:00Z');
const own = '15550000001@c.us', person = '15550000002@c.us', lid = '10000000002@lid';
const group = '120000000001@g.us', other = '120000000002@g.us';
function config() {
  return {ownerUserId: 'test-owner', workerAccountId: 'sender', ownChatId: own, activatedAt: '2026-01-01T00:00:00Z',
    groups: [{chatId: group, threadId: 'thread-1', name: 'Example'}, {chatId: other, threadId: 'thread-2', name: 'Other'}],
    participantAuthors: [{chatId: group, threadId: 'thread-1', ids: [person], since: '2026-01-02T00:00:00Z'}]};
}
function message(patch = {}) {
  return {id: {_serialized: 'participant-1', remote: group}, author: lid, fromMe: false,
    from: group, body: 'Which companies fit the project?', timestamp: now / 1000, ...patch};
}
function client(mapping = [{lid, pn: person}]) {
  return {info: {wid: {_serialized: own}}, getContactLidAndPhone: async () => mapping,
    sendMessage: async () => ({id: {_serialized: 'provider-1'}})};
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-participant-'));
  const c = {...config(), journalPath: path.join(dir, 'transport.sqlite')};
  const transport = createScopedGroupTransport({config: c, token: 'fake', base: {}, now: () => now});
  const inboxDb = new DatabaseSync(c.journalPath), relayDb = new DatabaseSync(':memory:');
  const state = {posts: [], sends: [], answers: [], allowed: true, allowOtherPeople: true};
  const api = async (url, options) => {
    if (url.endsWith('/whatsapp-participant-check')) return {allowed: true};
    if (url.endsWith('/input')) { state.posts.push(options.body); return {message: {id: 'input-1'}}; }
    if (url.includes('/messages')) return {messages: state.answers};
    return {thread: {ownerUserId: c.ownerUserId, binding: {chatId: group, enabled: true, mirrorToWhatsApp: false,
      allowOtherPeople: state.allowOtherPeople, authorizedContactIds: state.allowed ? [person] : []}}};
  };
  const relay = createScopedGroupRelay({config: c, inboxDb, relayDb, api, send: async p => {
    state.sends.push(p);
    return transport.sendText(client(), p.chatId, p.text, 'main', p);
  }});
  t.after(() => {relay.close(); inboxDb.close(); relayDb.close(); transport.close(); fs.rmSync(dir, {recursive: true, force: true});});
  return {transport, relay, inboxDb, state, c};
}
const answer = {id: 'answer-1', parentMessageId: 'input-1', role: 'assistant', state: 'completed', phase: 'final_answer', text: 'Project fit analysis'};

test('authorized participant reaches only bound thread with durable non-owner identity and one reply', async t => {
  const {transport, relay, inboxDb, state} = fixture(t);
  assert.equal(await transport.observe(client(), message()), true);
  const row = inboxDb.prepare('SELECT proof FROM group_input_author').get();
  assert.equal(JSON.parse(row.proof).phoneId, person);
  assert.equal((await relay.tick()).routed, 1);
  const input = state.posts[0];
  assert.equal(input.originOwner, false); assert.equal(input.controlAllowed, false); assert.equal(input.parseCommands, false);
  assert.equal(input.externalPrincipal.senderId, lid); assert.equal(input.externalPrincipal.bindingId, 'thread-1');
  assert.equal(input.senderEffectiveRole, 'trusted'); assert.equal(input.externalId, 'participant-1');
  state.answers = [answer];
  assert.equal((await relay.tick()).completed, 1);
  await relay.tick();
  assert.equal(await transport.observe(client(), message()), false);
  assert.equal(state.posts.length, 1); assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].chatId, group);
  assert.equal(await transport.observe(client(), message({id: {_serialized: 'provider-1'}, fromMe: true, to: group})), false);
});

test('participant admission rejects other groups, wrong account, stale/ambiguous/mismatched mappings', async t => {
  const {transport, inboxDb} = fixture(t);
  const cases = [
    [client(), message({from: other, id: {_serialized: 'other', remote: other}})],
    [client(), message({timestamp: Date.parse('2026-01-02T00:00:00Z') / 1000})],
    [client(), message({timestamp: (now + 6000) / 1000})],
    [client([{lid: '10000000003@lid', pn: person}]), message()],
    [client([{lid, pn: own}]), message()], [client([]), message()],
    [client([{lid, pn: person}, {lid, pn: person}]), message()],
    [client(), message({author: '15550000003@c.us'})],
    [{...client(), getContactLidAndPhone: async () => {throw Error('offline');}}, message()],
  ];
  for (const [c, m] of cases) assert.equal(await transport.observe(c, m), false);
  await assert.rejects(transport.observe({...client(), info: {wid: {_serialized: person}}}, message()), /account_mismatch/);
  assert.equal(inboxDb.prepare('SELECT count(*) n FROM group_input').get().n, 0);
  assert.equal(await transport.observe(client(), message({author: person})), true);
});

test('current binding revocation denies both routing and a previously queued reply', async t => {
  const {transport, relay, state} = fixture(t);
  await transport.observe(client(), message());
  state.allowed = false;
  assert.deepEqual((await relay.tick()).errors, ['group_participant_binding_denied']);
  assert.equal(state.posts.length, 0);
  state.allowed = true; state.allowOtherPeople = false;
  assert.deepEqual((await relay.tick()).errors, ['group_participant_binding_denied']);
  state.allowOtherPeople = true; await relay.tick();
  assert.equal(state.posts.length, 1);
  state.answers = [answer]; state.allowed = false;
  assert.deepEqual((await relay.tick()).errors, ['group_participant_binding_denied']);
  assert.equal(state.sends.length, 0);
});

test('proof write failure rolls back input and changed evidence is rejected', async t => {
  const {transport, relay, inboxDb, state} = fixture(t);
  inboxDb.exec("CREATE TRIGGER reject_proof BEFORE INSERT ON group_input_author BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await assert.rejects(transport.observe(client(), message()), /fixture/);
  assert.equal(inboxDb.prepare('SELECT count(*) n FROM group_input').get().n, 0);
  inboxDb.exec('DROP TRIGGER reject_proof');
  await transport.observe(client(), message());
  const proof = JSON.parse(inboxDb.prepare('SELECT proof FROM group_input_author').get().proof);
  for (const patch of [{inputId: 'other'}, {threadId: 'thread-2'}, {chatId: other}, {phoneId: own}, {createdAt: '2026-01-01'}]) {
    inboxDb.prepare('UPDATE group_input_author SET proof=?').run(JSON.stringify({...proof, ...patch}));
    assert.deepEqual((await relay.tick()).errors, ['group_participant_binding_denied']);
    await assert.rejects(transport.sendText(client(), group, 'reply', 'main', {requestId: 'r', parentId: 'participant-1'}), /participant_reply_denied/);
  }
  assert.equal(state.posts.length, 0); assert.equal(state.sends.length, 0);
});

test('restarting with participant grant removed cannot replay or send old participant input', async t => {
  const {transport, relay, inboxDb, c, state} = fixture(t);
  await transport.observe(client(), message()); await relay.tick();
  const removed = {...c, participantAuthors: []};
  const newTransport = createScopedGroupTransport({config: removed, token: 'fake', base: {}, now: () => now});
  const relayDb = new DatabaseSync(':memory:');
  const newRelay = createScopedGroupRelay({config: removed, inboxDb, relayDb,
    api: async () => ({thread: {ownerUserId: c.ownerUserId, binding: {chatId: group, enabled: true, mirrorToWhatsApp: false, allowOtherPeople: true, authorizedContactIds: [person]}}}),
    send: async () => assert.fail('revoked send')});
  t.after(() => {newRelay.close(); relayDb.close(); newTransport.close();});
  assert.deepEqual((await newRelay.tick()).errors, ['group_participant_binding_denied']);
  await assert.rejects(newTransport.sendText(client(), group, 'reply', 'main', {requestId: 'r', parentId: 'participant-1'}), /participant_reply_denied/);
  assert.equal(state.posts.length, 1);
});

test('invalid grants fail closed without global owner promotion', () => {
  for (const patch of [{threadId: 'other'}, {chatId: other}, {ids: ['*@c.us']}, {ids: [own]}, {ids: []}, {since: 'invalid'}, {since: '2025-01-01'}, {extra: true}]) {
    const c = config(); c.participantAuthors[0] = {...c.participantAuthors[0], ...patch};
    assert.throws(() => createGroupParticipantPolicy(c), /configuration_invalid/);
  }
  const c = config(); c.participantAuthors.push(c.participantAuthors[0]);
  assert.throws(() => createGroupParticipantPolicy(c), /configuration_invalid/);
});
