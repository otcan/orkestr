import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../apps/server/src/server.js';
import {createThread, listThreadMessages} from '../packages/core/src/threads.js';
import {approvePairingChallenge, createPairingChallenge, pairBrowser, sessionCookieHeader} from '../packages/core/src/security.js';
import {upsertWhatsAppConnectorAccount} from '../packages/connectors/src/whatsapp-account-registry.js';

test('participant check requires authentication, stays read-only, and blocked input never enqueues', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orkestr-scoped-participant-api-'));
  const overrides = {ORKESTR_HOME: home, ORKESTR_AUTH_REQUIRED: '1', ORKESTR_WHATSAPP_AUTOSTART: '0', WHATSAPP_LOCAL_AUTOSTART: '0'};
  const before = Object.fromEntries(Object.keys(overrides).map(k => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(home, {recursive: true, force: true});
  });
  const pn = '15550000002@c.us', lid = '10000000002@lid', chatId = '120000000001@g.us';
  const thread = await createThread({id: 'example-thread', name: 'Example', binding: {connector: 'whatsapp', chatId,
    enabled: true, mirrorToWhatsApp: false, allowOtherPeople: true, responderAccountId: 'test-account',
    authorizedContactIds: [pn], inboundSecurity: {trustedParticipantIds: [lid, pn]}}});
  const statePath = path.join(home, 'whatsapp.json');
  await fs.writeFile(statePath, '{}');
  const input = {text: 'Which companies fit?', source: 'whatsapp_group_relay', externalId: 'event-1', from: lid,
    accountId: 'test-account', chatId, scopedParticipant: {version: 1, inputId: 'event-1', authorId: lid, phoneId: pn,
      chatId, threadId: thread.id, createdAt: '2026-01-01T00:00:00Z'}};
  server = await startServer({port: 0, host: '127.0.0.1'});
  const base = `http://127.0.0.1:${server.address().port}/api/threads/${thread.id}`;
  const post = (suffix, cookie) => fetch(base + suffix, {method: 'POST', headers: {'content-type': 'application/json', ...(cookie ? {cookie} : {})}, body: JSON.stringify(input)});
  const unauthenticated = await post('/whatsapp-participant-check');
  assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const challenge = await createPairingChallenge({env: process.env});
  await approvePairingChallenge(challenge.challengeId, {env: process.env, approvedBy: 'node-test'});
  const paired = await pairBrowser({challengeId: challenge.challengeId, env: process.env, userAgent: 'node-test', ip: '127.0.0.1'});
  const cookie = sessionCookieHeader(paired.token, process.env, {requestHost: '127.0.0.1'}).split(';')[0];
  const accepted = await post('/whatsapp-participant-check', cookie);
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).controlAllowed, false);
  assert.equal((await listThreadMessages(thread.id)).length, 0);
  await fs.writeFile(statePath, JSON.stringify({inboundSecurity: {blockedParticipants: [{participantId: pn, chatId}]}}));
  for (const suffix of ['/whatsapp-participant-check', '/input']) {
    const denied = await post(suffix, cookie);
    assert.equal(denied.status, 403); await denied.text();
  }
  assert.equal((await listThreadMessages(thread.id)).length, 0);
});

test('authenticated participant API accepts a verified account alias without enqueue or authority elevation', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orkestr-participant-account-api-'));
  const overrides = {ORKESTR_HOME: home, ORKESTR_AUTH_REQUIRED: '1', ORKESTR_WHATSAPP_AUTOSTART: '0', WHATSAPP_LOCAL_AUTOSTART: '0'};
  const before = Object.fromEntries(Object.keys(overrides).map(k => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(home, {recursive: true, force: true});
  });
  const pn = '15550000002@c.us', lid = '10000000002@lid', chatId = '120000000001@g.us';
  const thread = await createThread({id: 'alias-thread', name: 'Example', binding: {connector: 'whatsapp', chatId,
    enabled: true, mirrorToWhatsApp: false, allowOtherPeople: true, responderAccountId: '15550001001',
    authorizedContactIds: [pn], inboundSecurity: {trustedParticipantIds: [lid, pn]}}});
  await upsertWhatsAppConnectorAccount({accountId: 'sender', runtimeAccountId: 'sender', phoneNumber: '15550001001'});
  const input = {text: 'Which companies fit?', source: 'whatsapp_group_relay', externalId: 'event-1', from: lid,
    accountId: 'sender', chatId, scopedParticipant: {version: 1, inputId: 'event-1', authorId: lid, phoneId: pn,
      chatId, threadId: thread.id, createdAt: '2026-01-01T00:00:00Z'}};
  server = await startServer({port: 0, host: '127.0.0.1'});
  const challenge = await createPairingChallenge({env: process.env});
  await approvePairingChallenge(challenge.challengeId, {env: process.env, approvedBy: 'node-test'});
  const paired = await pairBrowser({challengeId: challenge.challengeId, env: process.env, userAgent: 'node-test', ip: '127.0.0.1'});
  const cookie = sessionCookieHeader(paired.token, process.env, {requestHost: '127.0.0.1'}).split(';')[0];
  const base = `http://127.0.0.1:${server.address().port}/api/threads/${thread.id}`;
  const post = body => fetch(base + '/whatsapp-participant-check', {method: 'POST',
    headers: {'content-type': 'application/json', cookie}, body: JSON.stringify(body)});
  const statePath = path.join(home, 'whatsapp.json');
  const stateBefore = await fs.readFile(statePath, 'utf8');
  const accepted = await post(input);
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.equal(result.allowed, true);
  for (const key of ['originOwner', 'controlAllowed', 'parseCommands']) assert.equal(result[key], false);
  assert.equal(result.senderPolicyMode, 'this-thread-only');
  assert.equal(await fs.readFile(statePath, 'utf8'), stateBefore);
  const denied = await post({...input, accountId: 'unrelated-account'});
  assert.equal(denied.status, 403); await denied.text();
  assert.equal((await listThreadMessages(thread.id)).length, 0);
});
