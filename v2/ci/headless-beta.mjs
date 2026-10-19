import assert from 'node:assert/strict';

// A missing route is a broken composition, not an unconfigured beta.
export function discoveryMode(status, body) {
  if (status === 404 && body?.code === 'beta_unconfigured'
      && body.message === 'Beta execution is not configured'
      && typeof body.request_id === 'string' && body.request_id.length > 0
      && body.retryable === false) return { kind: 'unconfigured' };
  assert.equal(status, 200, 'Beta discovery must be configured or explicitly unconfigured');
  assert.equal(body?.schema_version, 1);
  assert.equal(body.provider, 'codex');
  assert.equal(body.role, 'deep');
  assert.match(body.conversation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(body.conversation_id, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(body.limits, { duration_ms: 900000, attempts: 32, bytes: 67108864,
    cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576 });
  for (const name of ['stop', 'steer', 'accept']) assert.equal(typeof body.controls?.[name], 'boolean');
  assert.ok(body.window === null || body.window?.conversation_id === body.conversation_id);
  return { kind: 'configured', conversation: body.conversation_id };
}
