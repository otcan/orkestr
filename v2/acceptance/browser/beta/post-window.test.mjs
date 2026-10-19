import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserPostWindow} from './post-window.mjs';

const base = {origin: 'https://example.invalid', sourceSha: 'a'.repeat(40),
  message: 'one fixed synthetic post-window input', credentials: {}, context: {},
  signal: new AbortController().signal, verifyLease: async () => true};

test('post-window pair refusal creates no login, input or replacement window and closes owned context', async () => {
  let closed = 0, navigation = 0;
  const result = await browserPostWindow({...base, page: {goto: async () => { navigation++; }},
    verifyServedPair: async () => false, closeContext: async () => { closed++; return true; }});
  assert.equal(result.status, 'failed'); assert.equal(result.failure.phase, 'pair');
  assert.equal(closed, 1); assert.equal(navigation, 0);
  assert.equal(result.cleanup.case_work, 'joined');
  assert.deepEqual(result.actions, {messages: 0, stop: 0, acceptance: 0, steering: 0});
});

test('interrupted post-window work never performs pair or admission work', async () => {
  const abort = new AbortController(); abort.abort(); let closed = 0;
  const result = await browserPostWindow({...base, page: {}, signal: abort.signal,
    verifyServedPair: async () => assert.fail('must not inspect or admit'),
    closeContext: async () => { closed++; return true; }});
  assert.equal(result.status, 'failed'); assert.equal(closed, 1);
  assert.equal(result.cleanup.case_work, 'joined'); assert.equal(result.actions.messages, 0);
});

test('unknown owned-context cleanup cannot credit a post-window pass', async () => {
  const result = await browserPostWindow({...base, page: {}, verifyServedPair: async () => false,
    closeContext: async () => { throw Error('synthetic owned close failure'); }});
  assert.equal(result.status, 'failed'); assert.equal(result.cleanup.owned.complete, false);
});
