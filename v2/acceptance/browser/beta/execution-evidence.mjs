import assert from 'node:assert/strict';

const PHASES = new Set(['queued', 'starting', 'running', 'cancel_requested',
  'cancelled', 'awaiting_acceptance', 'completed', 'failed', 'blocked']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const id = value => assert(typeof value === 'string' && UUID.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000', 'exact_id_required');
const integer = value => {
  assert(typeof value === 'bigint' || Number.isSafeInteger(value)); return BigInt(value);
};

export function executionStatus(value, conversation, run) {
  assert(value, 'execution_unavailable');
  id(conversation); assert.equal(value.conversation_id, conversation);
  assert.equal(integer(value.schema_version), 1n);
  assert(integer(value.revision) >= 0n && integer(value.observed_at_ms) > 0n);
  assert(PHASES.has(value.phase));
  if (value.phase !== 'queued') id(value.run_id);
  if (run !== undefined) assert.equal(value.run_id, run, 'selected_run_changed');
  if (value.control_revision !== undefined && value.control_revision !== null) {
    id(value.run_id); assert(integer(value.control_revision) > 0n);
  }
  assert.equal(typeof value.capabilities?.stop, 'boolean');
  assert.equal(typeof value.capabilities?.steer, 'boolean');
  if (value.progress) {
    id(value.progress.payload_id);
    assert(integer(value.progress.observed_at_ms) > 0n &&
      integer(value.progress.observed_at_ms) <= integer(value.observed_at_ms));
  }
  return value;
}

export function assertProgress({conversation, status, payload, visible}) {
  executionStatus(status, conversation);
  assert(['running', 'awaiting_acceptance'].includes(status.phase));
  assert(status.progress, 'committed_progress_required');
  assert.equal(payload.conversation_id, conversation);
  assert.equal(payload.run_id, status.run_id);
  assert.equal(payload.payload_id, status.progress.payload_id);
  assert(typeof payload.text === 'string' && Buffer.byteLength(payload.text) > 0 &&
    Buffer.byteLength(payload.text) <= 32768, 'actual_text_payload_required');
  assert.equal(visible, true, 'matching_text_must_be_rendered');
  return {committed_payload: true, exact_run_payload: true, visible_text: true};
}

export function assertStopRequested({conversation, before, request, receipt}) {
  executionStatus(before, conversation);
  assert.equal(before.phase, 'running'); assert.equal(before.capabilities.stop, true);
  assert.equal(request.run_id, before.run_id);
  assert(integer(request.expected_control_revision) > 0n);
  assert.equal(integer(request.expected_control_revision), integer(before.control_revision));
  assert.equal(receipt.schema_version === 1 || receipt.schema_version === 1n, true);
  assert.equal(receipt.conversation_id, conversation); assert.equal(receipt.run_id, before.run_id);
  assert.equal(receipt.request_key, request.request_key);
  assert.equal(integer(receipt.requested_revision), integer(request.expected_revision));
  assert(integer(receipt.revision) > integer(receipt.requested_revision));
  assert.equal(receipt.outcome, 'requested_unknown');
  return {exact_stop_intent: true, confirmed_stopped: false};
}

export function assertStopped({conversation, receipt, after}) {
  executionStatus(after, conversation, receipt.run_id);
  assert.equal(after.phase, 'cancelled', 'request_or_ack_is_not_stopped');
  assert(integer(after.revision) >= integer(receipt.revision));
  assert.equal(after.capabilities.stop, false); assert.equal(after.capabilities.steer, false);
  return {exact_run_cancelled_projection: true, native_reap_independently_required: true};
}

export function assertAccepted({conversation, proposal, request, receipt, after}) {
  executionStatus(proposal, conversation);
  assert.equal(proposal.phase, 'awaiting_acceptance');
  assert.equal(proposal.acceptance_candidate?.run_id, proposal.run_id);
  id(proposal.acceptance_candidate.completion_event_id);
  assert.equal(request.run_id, proposal.run_id);
  assert.equal(request.completion_event_id, proposal.acceptance_candidate.completion_event_id);
  assert.equal(integer(receipt.schema_version), 1n);
  assert.equal(receipt.conversation_id, conversation); assert.equal(receipt.run_id, request.run_id);
  assert.equal(receipt.completion_event_id, request.completion_event_id);
  id(receipt.acceptance_event_id); assert.notEqual(receipt.acceptance_event_id, receipt.completion_event_id);
  assert.equal(receipt.request_key, request.request_key);
  assert.equal(integer(receipt.requested_revision), integer(request.expected_revision));
  assert(integer(receipt.revision) > integer(receipt.requested_revision));
  assert.equal(receipt.outcome, 'succeeded');
  executionStatus(after, conversation, request.run_id);
  assert.equal(after.phase, 'completed'); assert(integer(after.revision) >= integer(receipt.revision));
  return {explicit_owner_acceptance: true, exact_completion_bound: true, completed_projection: true};
}

export function assertSteered({conversation, run, request, receipt, status}) {
  assert.equal(request.control.run_id, run);
  assert(integer(request.control.expected_revision) >= 0n);
  assert(integer(request.control.expected_control_revision) > 0n);
  assert.equal(receipt.conversation_id, conversation); assert.equal(receipt.run_id, run);
  assert.equal(receipt.request_key, request.control.request_key);
  id(receipt.message_id); id(receipt.event_id); assert(integer(receipt.scope_sequence) > 0n);
  assert.equal(receipt.disposition, 'reserved', 'queued_is_not_live_steer');
  assert.deepEqual(status.receipt, receipt);
  assert.equal(status.state, 'acknowledged', 'reservation_is_not_acknowledgement');
  assert(integer(status.written_bytes) > 0n);
  return {native_steering_acknowledged: true, completion_implied: false};
}
