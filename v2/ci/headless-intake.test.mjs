import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIntake } from './headless-intake.mjs';
import { readFileSync } from 'node:fs';
const receipt = JSON.parse(readFileSync(new URL('../fixtures/message-receipt.json', import.meta.url)));
const snapshot = JSON.parse(readFileSync(new URL('../fixtures/conversation-snapshot.json', import.meta.url)));
const sample = () => ({ input: { client_message_id: 'synthetic-ci', text: snapshot.messages[0].text },
  text: snapshot.messages[0].text, conversation: snapshot.conversation_id, receipt: structuredClone(receipt),
  snapshot: { ...structuredClone(snapshot), scope: { kind: 'global' } } });
test('canonical receipt and exact persisted message pass independently of transient status copy', () => verifyIntake(sample()));
for (const [name, mutate] of [
  ['wrong receipt identity', x => { x.receipt.message_id = x.receipt.event_id; }],
  ['nonaccepted receipt', x => { x.receipt.status = 'pending'; }],
  ['foreign scope', x => { x.snapshot.scope = { kind: 'project' }; }],
  ['missing persisted message', x => { x.snapshot.messages = []; }],
  ['duplicate admission', x => { x.snapshot.messages.push(x.snapshot.messages[0]); }],
  ['wrong persisted text', x => { x.snapshot.messages[0].text = 'different'; }],
  ['uncommitted watermark', x => { x.snapshot.last_sequence = 0; }],
]) test(name, () => { const value = sample(); mutate(value); assert.throws(() => verifyIntake(value)); });
