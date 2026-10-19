import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertServiceHealth} from './service-identity.mjs';

test('health must name the same stamped server, not simply return HTTP success', () => {
  const expected = {source: 'a'.repeat(40), version: '2.0.0-beta.1'};
  const health = {status: 'ok', product: 'orkestr-v2', contract_version: 0, fixture_mode: false,
    build: {format: 'orkestr-v2-build-identity-v1', component: 'server',
      source_commit: expected.source, version: expected.version}};
  assert.equal(assertServiceHealth(health, expected), true);
  assert.throws(() => assertServiceHealth({...health, build: {...health.build, source_commit: 'b'.repeat(40)}}, expected));
  assert.throws(() => assertServiceHealth({...health, fixture_mode: true}, expected));
});
