import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeExact, assertWindowAdmission, assertWindowReplay, assertHeldInput} from './window-evidence.mjs';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const limits = {duration_ms: 900000, attempts: 32, bytes: 67108864,
  cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576};
function example() {
  const request = {request_key: 'window-1', input_message_id: id(2), input_event_id: id(3),
    input_request_key: 'message-1', expected_generation: 0, window_id: null, predecessor_window_id: null};
  const status = {window_id: id(4), conversation_id: id(1), generation: 1, state: 'opening',
    input_message_id: id(2), input_event_id: id(3), predecessor_window_id: null,
    opened_at_ms: 1000, work_deadline_ms: 871000, expires_at_ms: 901000, limits};
  return {conversation: id(1), intakeRequest: {client_message_id: 'message-1'},
    intakeReceipt: {status: 'accepted', message_id: id(2), event_id: id(3), sequence: 1}, request,
    receipt: {request_key: 'window-1', input_message_id: id(2), input_event_id: id(3),
      input_request_key: 'message-1', duplicate: false, status}};
}

test('generation JSON is never rounded at the JavaScript boundary', () => {
  assert.equal(decodeExact('{"generation":9223372036854775807}').generation, 9223372036854775807n);
  assert.throws(() => decodeExact('{"generation":1.5}'));
  assert.throws(() => decodeExact('{"generation":1e12}'));
});

test('window generations enforce the frozen JavaScript-safe bound, even after exact decoding', () => {
  const data = example();
  data.previous = {...data.receipt.status, window_id: id(7), state: 'closed', generation: 9007199254740991n};
  Object.assign(data.request, {expected_generation: 9007199254740991n, predecessor_window_id: id(7)});
  Object.assign(data.receipt.status, {generation: 9007199254740992n, predecessor_window_id: id(7)});
  assert.throws(() => assertWindowAdmission(data));
});

test('the last safe generation remains joinable without creating another budget', () => {
  const data = example();
  const previous = {...data.receipt.status, state: 'active', generation: 9007199254740991n};
  data.previous = previous;
  Object.assign(data.request, {expected_generation: 9007199254740991n, window_id: previous.window_id});
  data.receipt.status = structuredClone(previous);
  assert.equal(assertWindowAdmission(data).original_budget_preserved, true);
});

test('opening belongs to the exact already admitted input, not merely its conversation', () => {
  assert.equal(assertWindowAdmission(example()).fresh_budget, true);
  for (const field of ['input_message_id', 'input_event_id', 'input_request_key']) {
    const data = example(); data.request[field] = 'foreign-value';
    assert.throws(() => assertWindowAdmission(data));
  }
});

test('a joined input retains the opening input and original budgets', () => {
  const data = example(), previous = {...data.receipt.status, state: 'active'};
  data.previous = previous;
  data.intakeRequest.client_message_id = 'message-2';
  Object.assign(data.intakeReceipt, {message_id: id(5), event_id: id(6), sequence: 2});
  Object.assign(data.request, {request_key: 'window-input-2', input_message_id: id(5),
    input_event_id: id(6), input_request_key: 'message-2', expected_generation: 1, window_id: id(4)});
  Object.assign(data.receipt, {request_key: 'window-input-2', input_message_id: id(5),
    input_event_id: id(6), input_request_key: 'message-2', status: structuredClone(previous)});
  assert.equal(assertWindowAdmission(data).original_budget_preserved, true);
  data.receipt.status.opened_at_ms++;
  data.receipt.status.work_deadline_ms++;
  data.receipt.status.expires_at_ms++;
  assert.throws(() => assertWindowAdmission(data));
});

test('retiring or unknown predecessor cannot be credited as a new fresh window', () => {
  for (const state of ['active', 'retiring', 'reconciliation_required']) {
    const data = example();
    data.previous = {...data.receipt.status, window_id: id(7), state};
    data.request.expected_generation = 1; data.request.predecessor_window_id = id(7);
    Object.assign(data.receipt.status, {generation: 2, predecessor_window_id: id(7)});
    assert.throws(() => assertWindowAdmission(data));
  }
});

test('replay preserves the original immutable opening even if current state later changes', () => {
  const original = example().receipt, replay = {...structuredClone(original), duplicate: true};
  assert.equal(assertWindowReplay(original, replay).new_budget, false);
  replay.status.state = 'active';
  assert.throws(() => assertWindowReplay(original, replay));
});

test('new user intent cannot silently release or rewrite the prior Stop hold', () => {
  const held = {message_id: id(2), source_event_id: id(3), reason: 'stop_boundary',
    boundary_run_id: id(7), boundary_event_id: id(8), scope_sequence: 1, through_scope_sequence: 4};
  const before = {schema_version: 1, conversation_id: id(1), revision: 7, observed_at_ms: 1000,
    eligible_input_available: false, next_after_sequence: null, held: [held]}, after = structuredClone(before);
  const data = {conversation: id(1), stoppedRun: id(7), admitted: example().intakeReceipt, before, after};
  assert.equal(assertHeldInput(data).prior_input_still_held, true);
  after.held[0].boundary_event_id = id(9);
  assert.throws(() => assertHeldInput(data));
  after.held = [];
  assert.throws(() => assertHeldInput(data));
});

test('a hold must have valid ordered boundaries and the exact original intake sequence', () => {
  const held = {message_id: id(2), source_event_id: id(3), reason: 'stop_boundary',
    boundary_run_id: id(7), boundary_event_id: id(8), scope_sequence: 1, through_scope_sequence: 4};
  const page = {schema_version: 1, conversation_id: id(1), revision: 7, observed_at_ms: 1000,
    eligible_input_available: false, next_after_sequence: null, held: [held]};
  for (const patch of [{scope_sequence: 99}, {scope_sequence: 0}, {scope_sequence: 2},
    {through_scope_sequence: 0}, {boundary_event_id: '00000000-0000-0000-0000-000000000000'}]) {
    const invalid = {...page, held: [{...held, ...patch}]};
    assert.throws(() => assertHeldInput({conversation: id(1), stoppedRun: id(7),
      admitted: example().intakeReceipt, before: invalid, after: structuredClone(invalid)}));
  }
});
