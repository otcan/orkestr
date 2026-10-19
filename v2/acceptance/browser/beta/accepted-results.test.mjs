import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {acceptedResult, acceptedText, acceptedResultRendered} from './accepted-results.mjs';
import {executionUi} from './execution-ui.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conversation = id(1);
const row = {run_id: id(2), completion_event_id: id(3), acceptance_event_id: id(4),
  acceptance_sequence: 7n, payload_id: id(5), payload_removed: false};
const receipt = {...row, conversation_id: conversation, outcome: 'succeeded'};
const page = {conversation_id: conversation, results: [row], next_after_sequence: null};
const payload = {conversation_id: conversation, run_id: id(2), payload_id: id(5), text: 'fixed reply'};

test('accepted result binds completion, acceptance and payload without fabricating a message ID', () => {
  const result = acceptedResult({conversation, receipt, page});
  assert.equal(acceptedText({conversation, result, payload}), 'fixed reply');
  assert.equal(Object.hasOwn(result, 'message_id'), false);
});

test('another run, old completion, current progress alone or a removed result cannot satisfy reload', () => {
  for (const patch of [{run_id: id(9)}, {completion_event_id: id(9)}, {acceptance_event_id: id(9)},
    {payload_id: null}, {payload_removed: true}]) {
    assert.throws(() => acceptedResult({conversation, receipt, page: {...page, results: [{...row, ...patch}]}}));
  }
  assert.throws(() => acceptedResult({conversation, receipt, page: {...page, results: []}}));
  assert.throws(() => acceptedResult({conversation, receipt, page: {progress: payload}}));
  for (const patch of [{conversation_id: id(9)}, {run_id: id(9)}, {payload_id: id(9)}, {text: ''}]) {
    assert.throws(() => acceptedText({conversation, result: row, payload: {...payload, ...patch}}));
  }
});

test('invalid order, duplicate acceptance and mismatched cursors are refused', () => {
  for (const results of [[row, row], [{...row, acceptance_sequence: 0n}],
    [row, {...row, acceptance_sequence: 6n}]]) {
    assert.throws(() => acceptedResult({conversation, receipt, page: {...page, results}}));
  }
  assert.throws(() => acceptedResult({conversation, receipt, page: {...page, next_after_sequence: 8n}}));
  assert.throws(() => acceptedResult({conversation, receipt, page: {...page, conversation_id: id(9)}}));
});

test('rendered reload proof requires the exact accepted-history article and text', () => {
  const origin = 'https://example.invalid';
  const dataset = {runId: row.run_id, completionEventId: row.completion_event_id,
    acceptanceEventId: row.acceptance_event_id, payloadId: row.payload_id};
  const evaluate = (rows, selectedOrigin = origin, panel = true) => vm.runInNewContext(
    `(${acceptedResultRendered.toString()})(input)`, {
      input: {origin, result: row, text: payload.text}, location: {origin: selectedOrigin},
      document: {querySelector: selector => {
        assert.equal(selector, 'section[aria-label="Accepted replies"]');
        return panel ? {querySelectorAll: tag => { assert.equal(tag, 'article'); return rows; }} : null;
      }},
    });
  const article = (patch = {}, text = payload.text) => ({dataset: {...dataset, ...patch},
    querySelectorAll: selector => {
      assert.equal(selector, 'pre[data-accepted-output="true"]'); return [{textContent: text}];
    }});
  assert.equal(evaluate([article()]), true);
  for (const key of Object.keys(dataset)) assert.equal(evaluate([article({[key]: id(99)})]), false);
  assert.equal(evaluate([article({}, 'old progress')]), false);
  assert.equal(evaluate([article(), article()]), false);
  assert.equal(evaluate([article()], origin, false), false, 'progress elsewhere cannot count as history');
  assert.throws(() => evaluate([article()], 'https://foreign.invalid'), /unexpected_origin/);
});

test('restored accepted history never requires a live execution handle or sends an action', async () => {
  const paths = [], origin = 'https://example.invalid';
  const controls = executionUi({origin, conversation, signal: new AbortController().signal,
    verifyLease: async () => true, capture: {take: () => assert.fail('no control request')},
    page: {waitForFunction: async (predicate, options, expected) => {
      assert.equal(predicate, acceptedResultRendered); assert.equal(options.timeout, 10000);
      assert.equal(expected.result.acceptance_event_id, receipt.acceptance_event_id);
      assert.equal(expected.text, payload.text);
    }},
    read: async (kind, selector) => {
      paths.push(kind);
      if (kind === 'accepted') return page;
      assert.equal(kind, 'payload', 'no live exact-run lookup after window retirement');
      assert.equal(selector, row.payload_id); return payload;
    }});
  const result = await controls.completed(receipt);
  assert.equal(result.accepted_result_restored, true);
  assert.deepEqual(paths, ['accepted', 'payload']);
  assert.deepEqual(controls.counts(), {messages: 0, stop: 0, acceptance: 0, steering: 0});
});
