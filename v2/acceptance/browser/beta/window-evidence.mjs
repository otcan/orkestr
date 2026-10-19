// Assertions over ordinary HTTP observations, never a dispatch/control grant.
// Keep integer identity intact; JavaScript must not round Core generations.
import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_SAFE_GENERATION = 9007199254740991n;
const LIMITS = Object.freeze({duration_ms: 900000n, attempts: 32n, bytes: 67108864n,
  cleanup_ms: 30000n, cleanup_attempts: 4n, cleanup_bytes: 1048576n});

export function decodeExact(raw) {
  assert.equal(typeof raw, 'string');
  assert(Buffer.byteLength(raw) <= 65536, 'bounded_observation_required');
  return JSON.parse(raw, (_, value, context) => {
    if (typeof value !== 'number') return value;
    assert(context && /^-?(?:0|[1-9][0-9]*)$/.test(context.source), 'exact_integer_observation_required');
    return BigInt(context.source);
  });
}

function integer(value) {
  assert(typeof value === 'bigint' || Number.isSafeInteger(value), 'integer_identity_required');
  return BigInt(value);
}
function uuid(value) { assert(typeof value === 'string' && UUID.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)); }
function status(value, conversation) {
  uuid(value.window_id); assert.equal(value.conversation_id, conversation);
  assert(integer(value.generation) > 0n && integer(value.generation) <= MAX_SAFE_GENERATION);
  assert(['opening', 'active', 'retiring', 'closed', 'reconciliation_required'].includes(value.state));
  uuid(value.input_message_id); uuid(value.input_event_id);
  const limits = Object.fromEntries(Object.entries(value.limits).map(([key, item]) => [key, integer(item)]));
  assert.deepEqual(limits, LIMITS, 'reviewed_beta_limits_required');
  assert(integer(value.opened_at_ms) > 0n);
  assert.equal(integer(value.expires_at_ms) - integer(value.opened_at_ms), LIMITS.duration_ms);
  assert.equal(integer(value.expires_at_ms) - integer(value.work_deadline_ms), LIMITS.cleanup_ms);
}

export function assertBetaDiscovery(value, conversation) {
  uuid(conversation);
  assert.equal(integer(value.schema_version), 1n);
  assert.equal(value.conversation_id, conversation, 'configured_conversation_must_match_login');
  assert.equal(value.provider, 'codex'); assert.equal(value.role, 'deep');
  assert.deepEqual(Object.keys(value.controls).sort(), ['accept', 'steer', 'stop']);
  assert(Object.values(value.controls).every(item => typeof item === 'boolean'));
  assert.deepEqual(Object.fromEntries(Object.entries(value.limits).map(([key, item]) => [key, integer(item)])), LIMITS);
  if (value.window !== null) status(value.window, conversation);
  return {configured_conversation_matches: true, provider: 'codex', role: 'deep'};
}

export function assertWindowAdmission({conversation, intakeRequest, intakeReceipt,
  request, receipt, previous = null}) {
  uuid(conversation);
  assert.equal(intakeReceipt.status, 'accepted');
  assert(integer(intakeReceipt.sequence) > 0n);
  uuid(intakeReceipt.message_id); uuid(intakeReceipt.event_id);
  for (const item of [request, receipt]) {
    assert.equal(item.input_message_id, intakeReceipt.message_id, 'exact_admitted_message_required');
    assert.equal(item.input_event_id, intakeReceipt.event_id, 'exact_admitted_event_required');
    assert.equal(item.input_request_key, intakeRequest.client_message_id, 'exact_input_request_key_required');
  }
  assert.equal(receipt.request_key, request.request_key);
  assert.equal(receipt.duplicate, false);
  status(receipt.status, conversation);
  if (previous) status(previous, conversation);
  const generation = previous ? integer(previous.generation) : 0n;
  assert(integer(request.expected_generation) >= 0n && integer(request.expected_generation) <= MAX_SAFE_GENERATION);
  assert.equal(integer(request.expected_generation), generation);
  if (request.window_id !== null) {
    assert(previous && previous.state === 'active', 'active_predecessor_required');
    assert.equal(request.predecessor_window_id, null);
    assert.equal(request.window_id, previous.window_id);
    // A join receipt names this new input, but its status retains the opening
    // input and the exact original budget/deadlines. It does not create a window.
    assert.deepEqual(receipt.status, previous, 'joined_input_reset_window_budget');
  } else {
    assert.equal(request.predecessor_window_id, previous?.window_id ?? null);
    assert(!previous || previous.state === 'closed', 'closed_predecessor_required');
    assert.equal(receipt.status.state, 'opening');
    assert.equal(integer(receipt.status.generation), generation + 1n);
    assert.notEqual(receipt.status.window_id, previous?.window_id);
    assert.equal(receipt.status.predecessor_window_id, previous?.window_id ?? null);
    assert.equal(receipt.status.input_message_id, intakeReceipt.message_id);
    assert.equal(receipt.status.input_event_id, intakeReceipt.event_id);
  }
  return {exact_input_bound: true, fresh_budget: request.window_id === null,
    original_budget_preserved: request.window_id !== null};
}

export function assertWindowReplay(original, replay) {
  assert.equal(original.duplicate, false); assert.equal(replay.duplicate, true);
  const {duplicate: _old, ...first} = original, {duplicate: _new, ...second} = replay;
  assert.deepEqual(second, first, 'window_retry_changed_immutable_receipt');
  return {immutable_admission_replayed: true, new_budget: false};
}

export function assertHeldInput({conversation, stoppedRun, admitted, before, after}) {
  uuid(conversation); uuid(stoppedRun); uuid(admitted.message_id); uuid(admitted.event_id);
  assert(integer(admitted.sequence) > 0n);
  for (const page of [before, after]) {
    assert.equal(page.conversation_id, conversation);
    assert.equal(integer(page.schema_version), 1n);
    assert(integer(page.revision) >= 0n && integer(page.observed_at_ms) > 0n);
    assert.equal(typeof page.eligible_input_available, 'boolean');
    assert(Array.isArray(page.held) && page.held.length <= 100);
    let previous = 0n;
    for (const held of page.held) {
      for (const key of ['message_id', 'source_event_id', 'boundary_run_id', 'boundary_event_id']) uuid(held[key]);
      assert.equal(held.reason, 'stop_boundary');
      const sequence = integer(held.scope_sequence);
      assert(sequence > previous && integer(held.through_scope_sequence) >= sequence);
      previous = sequence;
    }
    if (page.next_after_sequence !== null) {
      assert(page.held.length > 0 && integer(page.next_after_sequence) === previous);
    }
  }
  const select = page => page.held.filter(item => item.message_id === admitted.message_id);
  const original = select(before), current = select(after);
  assert.equal(original.length, 1); assert.equal(current.length, 1);
  assert.equal(original[0].source_event_id, admitted.event_id);
  assert.equal(integer(original[0].scope_sequence), integer(admitted.sequence));
  assert.equal(original[0].reason, 'stop_boundary');
  assert.equal(original[0].boundary_run_id, stoppedRun);
  assert.deepEqual(current[0], original[0], 'new_input_must_not_release_old_hold');
  return {prior_input_still_held: true, exact_hold_provenance_preserved: true};
}
