import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionUi} from './execution-ui.mjs';
import {ownerReads} from './owner-reads.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://example.invalid', conversation = id(1), run = id(2);
const text = 'Continue the same synthetic text-only task.';

// Real executionUi and ownerReads, with only the page/HTTP responses faked.
// Store commits delivery_unknown before granting the native write; that state
// can therefore be observed before the exact request is acknowledged.
function fixture(states, {clock, statusReceipt = {}} = {}) {
  const abort = new AbortController(), paths = [], samples = [];
  let fills = 0, clicks = 0, captures = 0;
  const request = {text, control: {run_id: run, request_key: 'steer:synthetic',
    expected_revision: 10, expected_control_revision: 3}};
  const receipt = {schema_version: 1, conversation_id: conversation, run_id: run,
    request_key: request.control.request_key, message_id: id(3), event_id: id(4),
    scope_sequence: 12, disposition: 'reserved'};
  const before = {schema_version: 1, conversation_id: conversation, run_id: run,
    revision: 10, control_revision: 3, observed_at_ms: 5000, phase: 'running',
    capabilities: {stop: true, steer: true}};
  const page = {
    url: () => origin,
    waitForFunction: async (_fn, _options, label) => assert.equal(label, 'Steer'),
    $eval: async (selector, _fn, argument) => {
      assert.equal(selector, 'section[aria-label="Steer running work"] textarea');
      assert.deepEqual(argument, {text, origin}); assert.equal(++fills, 1);
    },
    evaluate: async (_fn, argument) => {
      if (typeof argument === 'string') {
        assert.equal(argument, 'Steer'); assert.equal(++clicks, 1); return;
      }
      assert.equal(argument.origin, origin); paths.push(argument.path);
      if (argument.path.endsWith(`/execution?run_id=${run}`)) {
        assert.equal(clicks, 0); return {status: 200, raw: JSON.stringify(before)};
      }
      assert.equal(argument.path, `/api/v2/conversations/${conversation}/steering/${receipt.request_key}`);
      assert.equal(clicks, 1); assert.equal(captures, 1);
      const state = states[Math.min(samples.length, states.length - 1)]; samples.push(state);
      if (clock) clock.ms += 7500;
      return {status: 200, raw: JSON.stringify({state, written_bytes: state === 'reserved' ? 0 : 405,
        receipt: {...receipt, ...statusReceipt}})};
    },
  };
  const ui = executionUi({page, origin, conversation, signal: abort.signal,
    verifyLease: async () => true, read: ownerReads(page, conversation, abort.signal, origin),
    capture: {take: async operation => {
      assert.equal(operation, 'steer'); assert.equal(clicks, 1); assert.equal(++captures, 1);
      return {status: 200, request: JSON.stringify(request), response: JSON.stringify(receipt)};
    }}});
  return {samples, invoke: () => ui.steer(run, text, true), checked() {
    assert.equal(fills, 1); assert.equal(clicks, 1); assert.equal(captures, 1);
    assert.equal(paths.length, samples.length + 1);
    assert.deepEqual(ui.counts(), {messages: 0, stop: 0, acceptance: 0, steering: 1});
  }};
}

test('a reserved steer may be delivery_unknown before its exact acknowledgement', async () => {
  const f = fixture(['reserved', 'delivery_unknown', 'acknowledged']);
  const result = await f.invoke(); f.checked();
  assert.deepEqual(f.samples, ['reserved', 'delivery_unknown', 'acknowledged']);
  assert.equal(result.native_steering_acknowledged, true);
  assert.equal(result.completion_implied, false);
});

test('permanent delivery_unknown reaches the original deadline without resubmission', async t => {
  const clock = {ms: 0}; t.mock.method(performance, 'now', () => clock.ms);
  const f = fixture(['delivery_unknown'], {clock});
  await assert.rejects(f.invoke(), {code: 'timeout'}); f.checked();
  assert.deepEqual(f.samples, ['delivery_unknown', 'delivery_unknown']);
  assert.equal(clock.ms, 15000);
});

for (const state of ['rejected', 'queued']) {
  test(`a ${state} steer fails without another mutation`, async () => {
    const f = fixture([state]);
    await assert.rejects(f.invoke(), {code: 'not_completed'}); f.checked();
    assert.deepEqual(f.samples, [state]);
  });
}

test('a later acknowledgement still must match the exact captured receipt', async () => {
  const f = fixture(['delivery_unknown', 'acknowledged'], {statusReceipt: {run_id: id(9)}});
  await assert.rejects(f.invoke(), {code: 'ERR_ASSERTION'}); f.checked();
  assert.deepEqual(f.samples, ['delivery_unknown', 'acknowledged']);
});
