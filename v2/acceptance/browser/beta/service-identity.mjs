import assert from 'node:assert/strict';

export function assertServiceHealth(value, {source, version}) {
  assert(/^[a-f0-9]{40}$/.test(source));
  assert.equal(value.status, 'ok'); assert.equal(value.product, 'orkestr-v2');
  assert.equal(value.contract_version, 0); assert.equal(value.fixture_mode, false);
  assert.equal(value.build.format, 'orkestr-v2-build-identity-v1');
  assert.equal(value.build.component, 'server');
  assert.equal(value.build.source_commit, source); assert.equal(value.build.version, version);
  return true;
}
