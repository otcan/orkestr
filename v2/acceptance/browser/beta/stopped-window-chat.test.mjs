import {test} from 'node:test';
import assert from 'node:assert/strict';
import {opening, stoppedWindowFixture} from './stopped-window-fixture.mjs';

test('actual chat waits for the exact stopped window to close before fresh input', async () => {
  const f = stoppedWindowFixture(), result = await f.run(); f.checked();
  assert.equal(result.status, 'passed', JSON.stringify(result.failure));
  assert.deepEqual(result.actions, {messages: 4, stop: 1, acceptance: 2, steering: 1});
  const stop = f.events.indexOf('stop'), closed = f.events.indexOf('window:closed');
  assert(closed > stop);
  assert.deepEqual(f.events.slice(stop + 1, closed), ['window:retiring', 'window:retiring']);
  assert.equal(f.events[closed + 1], 'held');
  assert.deepEqual(result.checks.map(c => c.name), ['pair', 'login', 'initial_intake',
    'running_progress', 'steering', 'pre_stop_intake', 'stop', 'held_input',
    'post_stop_input', 'accepted_continuation']);
  assert.equal(result.checks.find(c => c.name === 'stop').native_reap_independently_required, true);
});

test('actual chat refuses changed or unavailable stopped-window evidence before held/fresh actions', async () => {
  const closed = {...opening, state: 'closed'};
  for (const sample of [null, {...closed, window_id: opening.input_message_id},
    {...closed, generation: 2}, {...closed, limits: {...closed.limits, attempts: 33}},
    {...closed, state: 'reconciliation_required'}]) {
    const f = stoppedWindowFixture([sample]), result = await f.run(); f.checked();
    assert.equal(result.status, 'failed'); assert.equal(result.failure.phase, 'stop');
    assert.deepEqual(result.actions, {messages: 2, stop: 1, acceptance: 0, steering: 1});
    assert(!f.events.includes('held'));
    assert.equal(f.events.filter(e => e === 'message').length, 2);
    assert.equal(f.events.filter(e => e === 'admission').length, 2);
  }
});
