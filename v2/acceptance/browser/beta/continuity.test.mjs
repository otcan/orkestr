import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ContinuityEvidence, MIN_CONTINUITY_MS, observeContinuity} from './continuity.mjs';

test('oracle requires at least fifteen minutes of monotonic observations, not a sample count', () => {
  const evidence = new ContinuityEvidence(100);
  for (let n = 0; n <= 60; n++) evidence.sample(100 + n * 15_000, true);
  assert.deepEqual(evidence.finish(), {elapsed_ms: MIN_CONTINUITY_MS, samples: 61,
    maximum_gap_ms: 15_000, natural_time_required: true});
  const fast = new ContinuityEvidence(0);
  for (let n = 0; n < 61; n++) fast.sample(n, true);
  assert.throws(() => fast.finish(), {code: 'not_completed'});
});

test('missing coverage, unavailable samples and time regression permanently refuse success', () => {
  for (const [at, verified, code] of [[30_001, true, 'continuity_gap'], [10, false, 'continuity_unavailable'], [-1, true, 'invalid_sample']]) {
    const evidence = new ContinuityEvidence(0);
    assert.throws(() => evidence.sample(at, verified), {code});
    assert.throws(() => evidence.sample(15_000, true), {code});
    assert.throws(() => evidence.finish(), {code});
  }
});

test('real observer refuses short budgets and stops on revocation before verification', async () => {
  let calls = 0;
  const common = {verify: async () => { calls++; return true; }, heartbeat: async () => false,
    signal: new AbortController().signal};
  await assert.rejects(observeContinuity({...common, durationMs: 100}), {code: 'invalid_action'});
  await assert.rejects(observeContinuity(common), {code: 'revoked'});
  assert.equal(calls, 0);
});

test('an interrupted observer does not wait indefinitely for an ignored callback signal', async () => {
  const controller = new AbortController();
  const waiting = observeContinuity({verify: () => new Promise(() => {}),
    heartbeat: async () => true, signal: controller.signal});
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(waiting, {code: 'interrupted'});
});
