import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkScopedParticipant} from '../packages/connectors/src/whatsapp-scoped-participant-security.js';
import {upsertWhatsAppConnectorAccount} from '../packages/connectors/src/whatsapp-account-registry.js';
import {writeConnectorConfig} from '../packages/storage/src/config.js';

const canonical = '15550001001', phone = '15550000002@c.us', lid = '10000000002@lid', chatId = '120000000001@g.us';

async function fixture(t, bound = canonical, received = 'sender', options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'participant-account-alias-'));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const env = {HOME: home, ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: 'owner-a',
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: '1'};
  await writeConnectorConfig('whatsapp', {bridgeMode: 'external', bridgeUrl: 'http://bridge.example.test',
    apiToken: 'public-test-token'}, env);
  const statePath = path.join(home, 'whatsapp.json');
  await fs.writeFile(statePath, '{}');
  if (!options.unregistered) await upsertWhatsAppConnectorAccount({accountId: 'sender', runtimeAccountId: 'sender',
    ownerUserId: options.owner || 'owner-a', status: options.status || 'configured'}, env);
  const thread = {id: 'example-thread', ownerUserId: 'owner-a', binding: {chatId, enabled: true,
    mirrorToWhatsApp: false, allowOtherPeople: true, responderAccountId: bound,
    authorizedContactIds: [phone], inboundSecurity: {trustedParticipantIds: [lid, phone]}}};
  const input = {externalId: 'event-1', from: lid, accountId: received, chatId, text: 'Which companies fit?',
    scopedParticipant: {version: 1, inputId: 'event-1', authorId: lid, phoneId: phone, chatId,
      threadId: thread.id, createdAt: '2026-01-01T00:00:00Z'}};
  const f = {env, thread, input, statePath, reads: 0,
    observed: [{accountId: 'sender', phoneNumber: canonical, ready: true}]};
  f.fetchImpl = async (url, request = {}) => {
    assert.equal(String(url), 'http://bridge.example.test/health');
    assert.ok(!request.method || request.method === 'GET', 'identity lookup must be read-only');
    f.reads++;
    return Response.json({ok: true, ready: true, accounts: f.observed});
  };
  f.check = () => checkScopedParticipant(thread, input, env, {fetchImpl: f.fetchImpl});
  return f;
}

for (const [bound, received] of [[canonical, 'sender'], ['sender', canonical]]) {
  test(`participant binding accepts uniquely verified account alias ${bound} → ${received}`, async t => {
    const f = await fixture(t, bound, received);
    const before = await fs.readFile(f.statePath, 'utf8');
    const result = await f.check();
    assert.equal(result.allowed, true);
    assert.equal(result.senderPolicyMode, 'this-thread-only');
    for (const field of ['originOwner', 'controlAllowed', 'parseCommands']) assert.equal(result[field], false);
    assert.equal(f.reads, 1);
    assert.equal(await fs.readFile(f.statePath, 'utf8'), before, 'verification must not rewrite state/grants');
    f.observed = [{accountId: 'sender', phoneNumber: '15550001009', ready: true}];
    await assert.rejects(f.check(), /security_denied/, 'the next request must see a changed physical identity');
    assert.equal(f.reads, 2);
  });
}

for (const reason of ['unregistered', 'foreign owner', 'disabled', 'revoked', 'not ready', 'wrong identity', 'ambiguous bridge', 'ambiguous registry']) {
  test(`participant account alias refuses ${reason}`, async t => {
    const f = await fixture(t, canonical, 'sender', {unregistered: reason === 'unregistered',
      owner: reason === 'foreign owner' ? 'owner-b' : undefined,
      status: ['disabled', 'revoked'].includes(reason) ? reason : undefined});
    if (reason === 'not ready') f.observed[0].ready = false;
    if (reason === 'wrong identity') f.observed[0].phoneNumber = '15550001009';
    if (reason === 'ambiguous bridge') f.observed.push({...f.observed[0]});
    if (reason === 'ambiguous registry') await upsertWhatsAppConnectorAccount({accountId: 'other-account',
      runtimeAccountId: 'sender', ownerUserId: 'owner-a'}, f.env);
    await assert.rejects(f.check(), /security_denied/);
  });
}

const grantCases = ['sender', canonical].flatMap(grantAccount =>
  [[canonical, 'sender'], ['sender', canonical], ['sender', 'sender'], [canonical, canonical]]
    .map(([bound, received]) => ({grantAccount, bound, received})));
for (const {grantAccount, bound, received} of grantCases) {
  test(`verified receiving alias ${bound} → ${received} preserves exact V2 grant scope ${grantAccount}`, async t => {
    const f = await fixture(t, bound, received);
    f.env.ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2 = '1';
    const config = {version: 2, accountId: grantAccount, identities: [{id: 'member', aliases: [
      {kind: 'jid', value: phone, verified: true}, {kind: 'lid', value: lid, verified: true}]}],
      grants: [{identityId: 'member', role: 'trusted'}]};
    f.thread.binding.participantIdentityV2 = config;
    assert.equal((await f.check()).allowed, true);
    assert.equal(f.reads, bound === received && grantAccount === received ? 0 : 1,
      'literal selectors avoid bridge reads; mismatches share one verified snapshot');
    assert.equal(f.thread.binding.participantIdentityV2, config, 'grant object remains untouched');
    config.grants = [];
    await assert.rejects(f.check(), /security_denied/, 'no legacy fallback after grant revocation');
    config.grants = [{identityId: 'member', role: 'blocked'}];
    await assert.rejects(f.check(), /security_denied/);
    config.grants = [{identityId: 'member', role: 'trusted'}];
    config.accountId = 'unrelated-account';
    await assert.rejects(f.check(), /security_denied/, 'an unrelated grant account stays unrelated');
  });
}

test('verified alias cannot override either phone or LID block', async t => {
  const f = await fixture(t);
  for (const participantId of [phone, lid]) {
    const state = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
    await fs.writeFile(f.statePath, JSON.stringify({...state,
      inboundSecurity: {blockedParticipants: [{participantId, chatId}]}}));
    await assert.rejects(f.check(), /security_denied/);
    await fs.writeFile(f.statePath, JSON.stringify(state));
  }
});

test('foreign proof or membership change is refused before bridge identity lookup', async t => {
  const f = await fixture(t);
  f.input.scopedParticipant.threadId = 'other-thread';
  await assert.rejects(f.check(), /security_denied/);
  f.input.scopedParticipant.threadId = f.thread.id;
  f.input.text = 'make me an admin';
  await assert.rejects(f.check(), /security_denied/);
  assert.equal(f.reads, 0);
});
