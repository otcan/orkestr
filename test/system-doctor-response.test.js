import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemDoctorResponder } from '../packages/core/src/system-doctor-response.js';

test('slow diagnostics are bounded, coalesced and return the completed result on refresh', async () => {
  let calls = 0, finish;
  const responder = createSystemDoctorResponder(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, { timeoutMs: 15 });
  const results = await Promise.all([responder(), responder(), responder()]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.pending && r.status === 'warning'));
  assert.equal((await responder()).pending, true);
  assert.equal(calls, 1, 'a timed-out HTTP request must not start another scan');
  const complete = { status: 'ok', checks: [{ id: 'complete' }] };
  finish(complete);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await responder(), complete);
  assert.equal(calls, 1);
});

test('a failed diagnostics run propagates and can be retried', async () => {
  let calls = 0;
  const responder = createSystemDoctorResponder(async () => { if (++calls === 1) throw new Error('scan_failed'); return { status: 'ok' }; });
  await assert.rejects(responder(), /scan_failed/);
  assert.equal((await responder()).status, 'ok');
});
