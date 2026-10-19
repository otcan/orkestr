import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertProgress, assertStopRequested, assertStopped, assertAccepted, assertSteered} from './execution-evidence.mjs';
import {observationPath, ownerReads} from './owner-reads.mjs';

const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conversation = u(1), run = u(2);
const running = () => ({schema_version: 1n, conversation_id: conversation, run_id: run,
  revision: 20n, control_revision: 3n, observed_at_ms: 5000n, phase: 'running',
  progress: {payload_id: u(3), observed_at_ms: 4000n}, capabilities: {stop: true, steer: true}});
const stop = () => ({schema_version: 1n, conversation_id: conversation, run_id: run,
  request_key: 'stop:1', requested_revision: 20n, revision: 21n, outcome: 'requested_unknown'});

test('visible text must belong to the exact committed run and payload; metadata is not progress', () => {
  const value = {conversation, status: running(), visible: true,
    payload: {conversation_id: conversation, run_id: run, payload_id: u(3), text: 'synthetic text'}};
  assert.equal(assertProgress(value).visible_text, true);
  for (const change of [{run_id: u(4)}, {payload_id: u(4)}, {text: null}, {text: ''}]) {
    assert.throws(() => assertProgress({...value, payload: {...value.payload, ...change}}));
  }
  assert.throws(() => assertProgress({...value, visible: false}));
  assert.throws(() => assertProgress({...value, status: {...running(), progress: null}}));
});

test('a durable Stop request or acknowledgement cannot be credited as Stopped', () => {
  const request = {run_id: run, request_key: 'stop:1', expected_revision: 20n, expected_control_revision: 3n};
  assert.equal(assertStopRequested({conversation, before: running(), request, receipt: stop()}).confirmed_stopped, false);
  const after = {...running(), revision: 22n, phase: 'cancel_requested', capabilities: {stop: false, steer: false}};
  assert.throws(() => assertStopped({conversation, receipt: stop(), after}));
  assert.equal(assertStopped({conversation, receipt: stop(), after: {...after, phase: 'cancelled'}}).exact_run_cancelled_projection, true);
  assert.throws(() => assertStopped({conversation, receipt: stop(), after: {...after, phase: 'cancelled', run_id: u(9)}}));
});

test('acceptance must bind the precise provider proposal and survive as completed state', () => {
  const proposal = {...running(), phase: 'awaiting_acceptance', acceptance_candidate: {run_id: run, completion_event_id: u(4)}};
  const request = {run_id: run, completion_event_id: u(4), expected_revision: 20n, request_key: 'accept:1'};
  const receipt = {...stop(), completion_event_id: u(4), acceptance_event_id: u(5), request_key: 'accept:1', outcome: 'succeeded'};
  const value = {conversation, proposal, request, receipt, after: {...running(), phase: 'completed', revision: 21n}};
  assert.equal(assertAccepted(value).explicit_owner_acceptance, true);
  assert.throws(() => assertAccepted({...value, receipt: {...receipt, completion_event_id: u(6)}}));
  assert.throws(() => assertAccepted({...value, after: {...value.after, phase: 'awaiting_acceptance'}}));
  assert.throws(() => assertAccepted({...value, after: {...value.after, run_id: u(7)}}));
});

test('Steer reservation, ordered fallback and a foreign acknowledgement are not live delivery', () => {
  const request = {control: {run_id: run, request_key: 'steer:1', expected_revision: 20n, expected_control_revision: 3n}};
  const receipt = {conversation_id: conversation, run_id: run, request_key: 'steer:1',
    message_id: u(8), event_id: u(9), scope_sequence: 20n, disposition: 'reserved'};
  const status = {receipt, state: 'acknowledged', written_bytes: 123n};
  assert.equal(assertSteered({conversation, run, request, receipt, status}).completion_implied, false);
  for (const state of ['reserved', 'queued', 'delivery_unknown', 'rejected']) {
    assert.throws(() => assertSteered({conversation, run, request, receipt, status: {...status, state}}));
  }
  assert.throws(() => assertSteered({conversation, run, request,
    receipt: {...receipt, disposition: 'queued_ordered'}, status}));
  assert.throws(() => assertSteered({conversation, run, request, receipt,
    status: {...status, receipt: {...receipt, run_id: u(10)}}}));
});

test('owner read paths are closed and cannot fetch a foreign origin or control endpoint', () => {
  assert.equal(observationPath(conversation, 'execution', run), `/api/v2/conversations/${conversation}/execution?run_id=${run}`);
  for (const kind of ['stop', 'accept', 'https://example.invalid', '../session']) {
    assert.throws(() => observationPath(conversation, kind));
  }
  assert.throws(() => observationPath(conversation, 'steering', '../session'));
  assert.throws(() => observationPath(conversation, 'window', run));
});

test('revocation refuses before any browser read; rounded integer responses are not introduced', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ownerReads({evaluate: () => assert.fail('browser must not be called')}, conversation,
    controller.signal, 'https://example.invalid')('window'));
  const read = ownerReads({evaluate: async () => ({status: 200, raw: '{"revision":9007199254740993}'})},
    conversation, new AbortController().signal, 'https://example.invalid');
  assert.equal((await read('execution')).revision, 9007199254740993n);
});
