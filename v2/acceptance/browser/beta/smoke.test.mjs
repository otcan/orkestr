import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {browserSmoke} from './smoke.mjs';

test('mismatched served pair refuses before login and still joins owned cleanup', async () => {
  let pair = 0, lease = 0, closed = 0;
  const page = new EventEmitter();
  page.goto = () => { throw Error('login must not start'); };
  const result = await browserSmoke({page, context: {}, origin: 'https://example.invalid',
    sourceSha: 'a'.repeat(40), credentials: {}, signal: new AbortController().signal,
    verifyServedPair: async () => { pair++; return false; },
    verifyLease: async () => { lease++; return true; },
    closeContext: async () => { closed++; return true; }});
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.phase, 'pair');
  assert.equal(result.checks.length, 0);
  assert.deepEqual([pair, lease, closed], [1, 0, 1]);
  assert.equal(result.cleanup.case_work, 'joined');
  assert.equal(page.listenerCount('request'), 0);
});

test('a revoked lease cannot reach login even with matching artifacts', async () => {
  let closed = false;
  const result = await browserSmoke({page: new EventEmitter(), context: {},
    origin: 'https://example.invalid', sourceSha: 'b'.repeat(40), credentials: {},
    signal: new AbortController().signal, verifyServedPair: async () => true,
    verifyLease: async () => false, closeContext: async () => { closed = true; return true; }});
  assert.equal(result.status, 'failed');
  assert.equal(result.provider_execution, false);
  assert.equal(closed, true);
});
