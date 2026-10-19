import assert from 'node:assert/strict';

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const id = value => assert(typeof value === 'string' && ID.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000');
const FIELDS = ['conversation_id', 'run_id', 'completion_event_id', 'acceptance_event_id', 'outcome'];

// These are two fixed acceptance cases, not arbitrary phase/budget replay.
export function postWindowPurpose(purpose) {
  if (purpose === 'post_continuity') return {priorAccepted: 2,
    scope: 'one_explicit_post_continuity_input', check: 'fresh_window_after_continuity'};
  assert.equal(purpose, 'post_service_restart', 'closed_continuation_purpose_required');
  return {priorAccepted: 3, scope: 'one_explicit_post_service_restart_input',
    check: 'fresh_window_after_service_restart'};
}

export function priorAccepted(predecessor, conversation, purpose) {
  id(conversation);
  const expected = postWindowPurpose(purpose).priorAccepted;
  assert(Array.isArray(predecessor.accepted) && predecessor.accepted.length === expected);
  for (const row of predecessor.accepted) {
    assert.equal(row.conversation_id, conversation); assert.equal(row.outcome, 'succeeded');
    for (const key of FIELDS.slice(1, 4)) id(row[key]);
    assert.notEqual(row.completion_event_id, row.acceptance_event_id);
  }
  for (const key of FIELDS.slice(1, 4)) {
    assert.equal(new Set(predecessor.accepted.map(row => row[key])).size, expected);
  }
  return predecessor.accepted;
}

// Observation-only handoff for a separately reviewed operator. This does not
// assert that the new window retired or that any process was reaped/restarted.
export function nextWindowHandoff({predecessor, conversation, purpose, window, accepted}) {
  const previous = priorAccepted(predecessor, conversation, purpose);
  id(window.window_id); assert.notEqual(window.window_id, predecessor.window_id);
  assert.equal(window.conversation_id, conversation);
  assert.equal(window.predecessor_window_id, predecessor.window_id);
  const generation = Number(window.generation);
  assert(Number.isSafeInteger(generation) && generation > 0);
  assert.equal(BigInt(generation), BigInt(predecessor.generation) + 1n);
  assert.equal(accepted.conversation_id, conversation); assert.equal(accepted.outcome, 'succeeded');
  for (const key of FIELDS.slice(1, 4)) {
    id(accepted[key]); assert(!previous.some(row => row[key] === accepted[key]));
  }
  assert.notEqual(accepted.completion_event_id, accepted.acceptance_event_id);
  assert(Array.isArray(predecessor.held) && predecessor.held.length === 1);
  return {window_id: window.window_id, generation,
    accepted: [...previous.map(row => Object.fromEntries(FIELDS.map(key => [key, row[key]]))),
      Object.fromEntries(FIELDS.map(key => [key, accepted[key]]))],
    held: structuredClone(predecessor.held)};
}
