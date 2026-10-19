import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {networkTiming} from './network-timing.mjs';

test('timing receipts exclude query, credentials and content; failures are counted', () => {
  const page = new EventEmitter(), monitor = networkTiming(page, 'https://example.invalid');
  const request = {url: () => 'https://example.invalid/api/v2/health?private=value', resourceType: () => 'fetch'};
  page.emit('request', request); page.emit('requestfailed', request);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.requests, 1); assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.by_kind.fetch.failed, 1);
  assert(!JSON.stringify(snapshot).includes('private'));
  assert.equal(monitor.close(), true);
  assert.equal(page.listenerCount('request'), 0);
});

test('unexpected network destinations remain a failure after listener cleanup', () => {
  const page = new EventEmitter(), monitor = networkTiming(page, 'https://example.invalid');
  page.emit('request', {url: () => 'https://foreign.invalid/', resourceType: () => 'fetch'});
  assert.throws(() => monitor.snapshot(), {code: 'unexpected_origin'});
  monitor.close();
  assert.throws(() => monitor.snapshot(), {code: 'unexpected_origin'});
});
