import test from 'node:test';
import assert from 'node:assert/strict';
import {requestJson} from '../apps/cli/src/api-client.js';

test('caller cancellation reaches a long-poll and is distinct from a deadline', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  const request = requestJson('/long-poll', {baseUrl: 'http://example.test', env: {ORKESTR_DISABLE_CLI_AUTH: '1'},
    timeoutMs: 40000, signal: controller.signal,
    fetchImpl: async (_url, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
      entered();
    })});
  await started;
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
});
