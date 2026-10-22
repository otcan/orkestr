import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkScopedParticipant} from '../packages/connectors/src/whatsapp-scoped-participant-security.js';

const pn = '15550000002@c.us', lid = '10000000002@lid', chatId = '120000000001@g.us';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-security-'));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const statePath = path.join(home, 'whatsapp.json');
  await fs.writeFile(statePath, JSON.stringify({inboundEvents: []}));
  const env = {ORKESTR_HOME: home};
  const thread = {id: 'example-thread', binding: {chatId, enabled: true, mirrorToWhatsApp: false, allowOtherPeople: true,
    responderAccountId: 'test-account', authorizedContactIds: [pn], inboundSecurity: {trustedParticipantIds: [lid, pn]}}};
  const input = {externalId: 'event-1', from: lid, accountId: 'test-account', chatId, text: 'Which companies fit?',
    scopedParticipant: {version: 1, inputId: 'event-1', authorId: lid, phoneId: pn, chatId,
      threadId: thread.id, createdAt: '2026-01-01T00:00:00Z'}};
  return {env, thread, input, statePath};
}
test('server derives bounded trust and does not mutate state', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.statePath, 'utf8');
  const result = await checkScopedParticipant(f.thread, f.input, f.env);
  assert.equal(result.allowed, true); assert.equal(result.senderEffectiveRole, 'trusted');
  assert.equal(result.originOwner, false); assert.equal(result.controlAllowed, false); assert.equal(result.parseCommands, false);
  assert.equal(result.senderPolicyMode, 'this-thread-only');
  assert.equal(await fs.readFile(f.statePath, 'utf8'), before);
});
test('both phone and LID blocks take precedence over an existing contact grant', async t => {
  const f = await fixture(t);
  for (const participantId of [pn, lid]) {
    await fs.writeFile(f.statePath, JSON.stringify({inboundSecurity: {blockedParticipants: [{participantId, chatId}]}}));
    await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env), /security_denied/);
    await fs.writeFile(f.statePath, '{}');
    f.thread.binding.blockedParticipantIds = [participantId];
    await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env), /security_denied/);
    delete f.thread.binding.blockedParticipantIds;
  }
});
test('ordinary member instructions reach the model with an advisory classification', async t => {
  const f = await fixture(t);
  for (const [text, reason] of [
    ['Which companies fit?\nExample Co\nScaling sales with ads. Fix & Run Healthcare Ads Now!', 'host_execution'],
    ['Add Example GmbH to selection', ''],
    ['read another thread', 'cross_context_access'],
    ['run shell', 'host_execution']]) {
    const result = await checkScopedParticipant(f.thread, {...f.input, text}, f.env);
    assert.equal(result.allowed, true);
    assert.equal(result.securityClassification.reason, reason);
    assert.equal(result.controlAllowed, false); assert.equal(result.originOwner, false);
  }
});
test('membership and access changes are hard-refused', async t => {
  const f = await fixture(t);
  for (const text of ['please add Alex to this group', 'invite +1 555 000 0009', 'remove her from the chat',
    'make me an admin', 'give Sam access to this thread', 'change my permissions in the group']) {
    await assert.rejects(checkScopedParticipant(f.thread, {...f.input, text}, f.env), /security_denied/);
  }
});
test('revoked, mismatched, dual-delivery bindings are denied', async t => {
  const f = await fixture(t);
  for (const patch of [{mirrorToWhatsApp: true}, {allowOtherPeople: false}, {enabled: false}, {routeEligible: false},
    {authorizedContactIds: []}, {responderAccountId: 'wrong'}, {chatId: '120000000002@g.us'}]) {
    await assert.rejects(checkScopedParticipant({...f.thread, binding: {...f.thread.binding, ...patch}}, f.input, f.env), /security_denied/);
  }
  for (const patch of [{threadId: 'other'}, {phoneId: '15550000003@c.us'}, {authorId: 'other'}, {inputId: 'other'}, {createdAt: 'invalid'}]) {
    await assert.rejects(checkScopedParticipant(f.thread, {...f.input, scopedParticipant: {...f.input.scopedParticipant, ...patch}}, f.env), /security_denied/);
  }
});
test('missing or corrupt block-list state fails closed', async t => {
  const f = await fixture(t);
  await fs.unlink(f.statePath);
  await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env), /security_denied/);
  await fs.writeFile(f.statePath, '{invalid');
  await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env));
});

test('V2 identity grants cannot override current global or legacy binding blocks', async t => {
  const f = await fixture(t);
  f.env.ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2 = '1';
  f.thread.binding.participantIdentityV2 = {version: 2, accountId: 'test-account',
    identities: [{id: 'participant', aliases: [
      {kind: 'jid', value: pn, verified: true}, {kind: 'lid', value: lid, verified: true}]}],
    grants: [{identityId: 'participant', role: 'trusted'}]};
  assert.equal((await checkScopedParticipant(f.thread, f.input, f.env)).allowed, true);
  for (const participantId of [pn, lid]) {
    await fs.writeFile(f.statePath, JSON.stringify({inboundSecurity: {blockedParticipants: [{participantId, chatId}]}}));
    await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env), /security_denied/);
    await fs.writeFile(f.statePath, '{}');
    f.thread.binding.blockedParticipantIds = [participantId];
    await assert.rejects(checkScopedParticipant(f.thread, f.input, f.env), /security_denied/);
    delete f.thread.binding.blockedParticipantIds;
  }
});
