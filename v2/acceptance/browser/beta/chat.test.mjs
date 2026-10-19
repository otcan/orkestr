import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserChat} from './chat.mjs';
import {executionUi} from './execution-ui.mjs';

const origin = 'https://example.invalid', conversation = '00000000-0000-4000-8000-000000000001';
const fixture = {mode: 'synthetic', messages: ['first stream', 'held input', 'fresh post Stop', 'continuation'],
  steering: 'fixed synthetic steer', requireSteer: true};

test('chat pair mismatch refuses before login, input or provider work and closes only its owned context', async () => {
  let closed = 0, login = 0;
  const report = await browserChat({page: {goto: async () => { login++; }}, context: {}, origin,
    credentials: {}, sourceSha: 'a'.repeat(40), fixture, signal: new AbortController().signal,
    verifyServedPair: async () => false, verifyLease: async () => true,
    closeContext: async () => { closed++; return true; }});
  assert.equal(report.status, 'failed'); assert.equal(report.failure.phase, 'pair');
  assert.equal(login, 0); assert.equal(closed, 1); assert.equal(report.cleanup.case_work, 'joined');
  assert.deepEqual(report.actions, {messages: 0, stop: 0, acceptance: 0, steering: 0});
});

test('revoked desktop lease prevents send and read effects before text entry', async () => {
  let calls = 0;
  const ui = executionUi({page: {url: () => origin}, origin, conversation,
    signal: new AbortController().signal, verifyLease: async () => false,
    read: async () => { calls++; }, capture: {take: () => { calls++; }}});
  await assert.rejects(ui.send('synthetic fixed input'), {code: 'revoked'});
  assert.equal(calls, 0); assert.equal(ui.counts().messages, 0);
});

test('an opening or reconciliation-required window never receives another input', async () => {
  let writes = 0;
  for (const state of ['opening', 'retiring', 'reconciliation_required']) {
    const ui = executionUi({page: {url: () => origin, $eval: async () => { writes++; }}, origin, conversation,
      signal: new AbortController().signal, verifyLease: async () => true,
      read: async () => ({state}), capture: {take: () => assert.fail('no mutation receipt expected')}});
    await assert.rejects(ui.send('synthetic fixed input'), /window_not_ready_for_input/);
  }
  assert.equal(writes, 0);
});

test('an already interrupted chat still closes and joins its owned context', async () => {
  const abort = new AbortController(); abort.abort(); let closed = 0;
  const report = await browserChat({page: {}, context: {}, origin, credentials: {}, fixture,
    sourceSha: 'b'.repeat(40), signal: abort.signal,
    verifyServedPair: async () => assert.fail('pair must not be read'), verifyLease: async () => true,
    closeContext: async () => { closed++; return true; }});
  assert.equal(report.status, 'failed'); assert.equal(closed, 1);
  assert.equal(report.cleanup.case_work, 'joined');
});
