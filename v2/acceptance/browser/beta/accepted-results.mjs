import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const id = value => assert(typeof value === 'string' && UUID.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000');
const sequence = value => {
  assert(typeof value === 'bigint' || Number.isSafeInteger(value));
  assert(BigInt(value) > 0n); return BigInt(value);
};

// Core a38f55d9/c1f301e5 exposes accepted result provenance, not an invented
// assistant MessageId. A current progress panel cannot satisfy this evidence.
export function acceptedResult({conversation, receipt, page}) {
  id(conversation); assert.equal(page.conversation_id, conversation);
  assert.equal(receipt.conversation_id, conversation); assert.equal(receipt.outcome, 'succeeded');
  for (const key of ['run_id', 'completion_event_id', 'acceptance_event_id']) id(receipt[key]);
  assert.notEqual(receipt.completion_event_id, receipt.acceptance_event_id);
  assert(Array.isArray(page.results) && page.results.length <= 50);
  let previous = 0n;
  for (const row of page.results) {
    for (const key of ['run_id', 'completion_event_id', 'acceptance_event_id']) id(row[key]);
    const next = sequence(row.acceptance_sequence); assert(next > previous); previous = next;
    assert.equal(typeof row.payload_removed, 'boolean');
    if (row.payload_id !== null) id(row.payload_id);
    assert(!row.payload_removed || row.payload_id !== null);
  }
  if (page.next_after_sequence !== null) {
    assert(page.results.length > 0); assert.equal(sequence(page.next_after_sequence), previous);
  }
  const rows = page.results.filter(row => row.acceptance_event_id === receipt.acceptance_event_id);
  assert.equal(rows.length, 1, 'accepted_result_missing');
  const row = rows[0];
  for (const key of ['run_id', 'completion_event_id', 'acceptance_event_id']) assert.equal(row[key], receipt[key]);
  assert.equal(row.payload_removed, false, 'accepted_payload_removed');
  id(row.payload_id);
  return row;
}

export function acceptedText({conversation, result, payload}) {
  assert.equal(payload.conversation_id, conversation);
  assert.equal(payload.run_id, result.run_id); assert.equal(payload.payload_id, result.payload_id);
  assert(typeof payload.text === 'string' && Buffer.byteLength(payload.text) > 0 &&
    Buffer.byteLength(payload.text) <= 32768, 'accepted_text_payload_required');
  return payload.text;
}

// This exact pure predicate is evaluated in the page. It deliberately cannot
// match the current execution/progress panel or a different accepted result.
export function acceptedResultRendered({origin, result, text}) {
  if (location.origin !== origin) throw Error('unexpected_origin');
  const panel = document.querySelector('section[aria-label="Accepted replies"]');
  const rows = [...(panel?.querySelectorAll('article') ?? [])]
    .filter(node => node.dataset.acceptanceEventId === result.acceptance_event_id);
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (row.dataset.runId !== result.run_id || row.dataset.completionEventId !== result.completion_event_id ||
      row.dataset.payloadId !== result.payload_id) return false;
  const outputs = [...row.querySelectorAll('pre[data-accepted-output="true"]')];
  return outputs.length === 1 && outputs[0].textContent === text;
}
