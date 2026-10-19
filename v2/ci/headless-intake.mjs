import assert from 'node:assert/strict';

// Bind the actual composer request, durable receipt and authorized history.
export function verifyIntake({ input, receipt, snapshot, conversation, text }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.equal(input.text, text);
  assert.ok(typeof input.client_message_id === 'string' && input.client_message_id.length > 0);
  assert.match(receipt.message_id, uuid);
  assert.match(receipt.event_id, uuid);
  assert.equal(receipt.status, 'accepted');
  assert.ok(Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0);
  assert.equal(snapshot.conversation_id, conversation);
  assert.deepEqual(snapshot.scope, { kind: 'global' });
  assert.equal(snapshot.next_cursor, null, 'Fresh isolated history must fit one page');
  assert.ok(snapshot.last_sequence >= receipt.sequence);
  assert.equal(snapshot.messages.length, 1, 'Exactly one fresh admission');
  assert.deepEqual(snapshot.messages[0], {
    message_id: receipt.message_id, sequence: receipt.sequence, actor_kind: 'owner', text,
  });
}
