import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createScopedGroupCreator, scopedGroupCreateRequest, validateScopedGroupCreate} from '../packages/connectors/src/whatsapp-scoped-group-create.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';

const own = '15550000001@c.us', owner = '15550000002@c.us', stranger = '15550000003@c.us';
const groupId = '120000000077@g.us';

function journal(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-group-create-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return path.join(dir, 'transport.sqlite');
}
const config = dbPath => ({workerAccountId: 'sender', ownChatId: own, activatedAt: '2026-01-01T00:00:00Z', journalPath: dbPath,
  groups: [{chatId: '120000000001@g.us', threadId: 'thread-1'}],
  routeControl: {routeId: 'r', dbPath: `${dbPath}.route`, threadIds: ['thread-1']},
  groupCreate: {enabled: true, authorizedAt: '2026-01-01T00:00:00Z', ownerParticipantIds: [owner]}});
const body = extra => ({name: 'Synthetic chat', senderAccountId: 'sender', responderAccountId: 'sender', participantIds: [owner],
  adminParticipantIds: [owner], promoteParticipantsAsAdmins: true, generatePicture: false, deferSetup: true,
  operationId: 'wgp_synthetic-1', correlationId: 'wgp_synthetic-1', ...extra});

function client(state) {
  return {
    async createGroup(title, participants) {
      state.creates.push({title, participants});
      if (state.fail) throw new Error('synthetic_lost_answer');
      state.groups.push({id: {_serialized: groupId}, isGroup: true, name: title, groupMetadata: {creation: state.now / 1000,
        participants: [own, ...participants].map(id => ({id: {_serialized: id}}))}});
      return state.fail === false ? {gid: {_serialized: groupId}} : {gid: {_serialized: groupId}};
    },
    async getChats() { return state.groups; },
    async getChatById() {
      return {promoteParticipants: async ids => { state.promoted.push(...ids); }, setMessagesAdminsOnly: async value => { state.adminsOnly = value; }};
    },
  };
}

test('only owner-only groups of the worker account are admitted', () => {
  const policy = validateScopedGroupCreate(config('/x'));
  assert.ok(scopedGroupCreateRequest(policy, 'sender', body()));
  for (const bad of [{participantIds: [owner, stranger]}, {participantIds: []}, {senderAccountId: 'other'}, {adminParticipantIds: [stranger]},
    {name: ''}, {name: 'x'.repeat(101)}, {operationId: 'bad id'}, {mirrorToWhatsApp: true}])
    assert.equal(scopedGroupCreateRequest(policy, 'sender', body(bad)), null, JSON.stringify(bad));
  assert.equal(scopedGroupCreateRequest(null, 'sender', body()), null, 'no block: no creation');
  assert.equal(validateScopedGroupCreate({}), null);
  assert.throws(() => validateScopedGroupCreate({ownChatId: own, groupCreate: {enabled: true, authorizedAt: 'x', ownerParticipantIds: [owner]}}));
  assert.throws(() => validateScopedGroupCreate({ownChatId: own, groupCreate: {enabled: true, authorizedAt: '2026-01-01T00:00:00Z', ownerParticipantIds: [own]}}));
});

test('creation is journaled, idempotent, opens the group to the owner and settles a lost answer by reading back', async t => {
  const dbPath = journal(t);
  const state = {creates: [], groups: [], promoted: [], now: Date.parse('2026-03-01T00:00:00Z'), fail: false};
  const creator = createScopedGroupCreator({config: config(dbPath), now: () => state.now, lookupDelayMs: 1});
  t.after(() => creator.close());
  const policy = validateScopedGroupCreate(config(dbPath));
  const request = scopedGroupCreateRequest(policy, 'sender', body());
  const first = await creator.create(client(state), request, 'sender');
  assert.equal(first.chat.id, groupId);
  assert.deepEqual(state.promoted, [owner]);
  assert.equal(state.adminsOnly, false, 'everyone in the group may post');
  const again = await creator.create(client(state), request, 'sender');
  assert.deepEqual([again.duplicate, again.chat.id], [true, groupId]);
  assert.equal(state.creates.length, 1, 'never created twice');
  await assert.rejects(creator.create(client(state), {...request, name: 'Other'}, 'sender'), /request_conflict/);

  // A lost answer: the group exists and is found by reading back.
  const lost = {creates: [], groups: [], promoted: [], now: state.now, fail: true};
  const second = scopedGroupCreateRequest(policy, 'sender', body({operationId: 'wgp_synthetic-2', name: 'Synthetic lost'}));
  const lostClient = client(lost);
  lostClient.createGroup = async (title, participants) => {
    lost.groups.push({id: {_serialized: '120000000078@g.us'}, isGroup: true, name: title, groupMetadata: {creation: lost.now / 1000,
      participants: [own, ...participants].map(id => ({id: {_serialized: id}}))}});
    throw new Error('synthetic_lost_answer');
  };
  const settled = await creator.create(lostClient, second, 'sender');
  assert.equal(settled.chat.id, '120000000078@g.us');

  // Nothing found: unsettled for this id only; another create still works.
  const none = {creates: [], groups: [], promoted: [], now: state.now, fail: true};
  const third = scopedGroupCreateRequest(policy, 'sender', body({operationId: 'wgp_synthetic-3', name: 'Synthetic none'}));
  await assert.rejects(creator.create(client(none), third, 'sender'), /outcome_unsettled/);
  await assert.rejects(creator.create(client(none), third, 'sender'), /outcome_unsettled/);
  const fourth = scopedGroupCreateRequest(policy, 'sender', body({operationId: 'wgp_synthetic-4', name: 'Synthetic fourth'}));
  assert.equal((await creator.create(client({creates: [], groups: [], promoted: [], now: state.now, fail: false}), fourth, 'sender')).chat.id, groupId);
});

test('the worker policy admits group creation only with the block and the narrow shape', t => {
  const dbPath = journal(t);
  const policy = createScopedNativeWorkerPolicy(config(dbPath));
  t.after(() => policy.close());
  const check = (p, b) => () => p.checkRequest('POST', new URL('http://local/chats'), b);
  assert.doesNotThrow(check(policy, body()));
  assert.throws(check(policy, body({participantIds: [stranger]})));
  const plain = createScopedNativeWorkerPolicy({...config(dbPath), groupCreate: undefined});
  t.after(() => plain.close());
  assert.throws(check(plain, body()));
});
