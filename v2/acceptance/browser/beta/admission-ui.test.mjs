import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {executionUi} from './execution-ui.mjs';
import {decodeExact} from './window-evidence.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const origin = 'https://example.invalid', conversation = id(1);
const limits = {duration_ms: 900000, attempts: 32, bytes: 67108864,
  cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576};

function fixture(join = false, status = 201) {
  const events = [], text = 'Fixed synthetic input', client = 'input-2';
  const opening = {window_id: id(4), conversation_id: conversation, generation: 1,
    state: join ? 'active' : 'opening', input_message_id: join ? id(8) : id(2),
    input_event_id: join ? id(9) : id(3), predecessor_window_id: null,
    opened_at_ms: 1000, work_deadline_ms: 871000, expires_at_ms: 901000, limits};
  const previous = join ? decodeExact(JSON.stringify(opening)) : null;
  const intake = {request: JSON.stringify({text, client_message_id: client}), status,
    response: JSON.stringify({status: 'accepted', message_id: id(2), event_id: id(3), sequence: 2})};
  const window = {status: 200,
    request: JSON.stringify({request_key: 'window-2', input_message_id: id(2), input_event_id: id(3),
      input_request_key: client, expected_generation: join ? 1 : 0,
      window_id: join ? id(4) : null, predecessor_window_id: null}),
    response: JSON.stringify({request_key: 'window-2', input_message_id: id(2), input_event_id: id(3),
      input_request_key: client, duplicate: false, status: opening})};
  let admitted = false, intakeRead = false;
  const execute = (fn, label, expectedOrigin, section) => {
    const button = {textContent: label, disabled: false, click() {
      events.push(label);
      if (label !== 'Send') {
        assert.equal(intakeRead, true, 'admission cannot precede the intake receipt');
        assert.equal(section, 'Work window'); admitted = true;
      } else assert.equal(section, 'Conversation');
    }};
    return vm.runInNewContext(`(${fn.toString()})(label, expectedOrigin, section)`, {
      label, expectedOrigin, section, location: {origin},
      document: {querySelector: () => ({querySelectorAll: () => [button]})},
    });
  };
  const page = {url: () => origin,
    waitForSelector: async selector => assert.equal(selector, '#composer'),
    $eval: async () => { events.push('draft'); },
    waitForFunction: async (fn, _options, ...args) => assert.equal(execute(fn, ...args), true),
    evaluate: (fn, ...args) => args.length ? execute(fn, ...args) : undefined};
  const ui = executionUi({page, origin, conversation, signal: new AbortController().signal,
    verifyLease: async () => true,
    read: async kind => { assert.equal(kind, 'window'); return admitted ? decodeExact(JSON.stringify({...opening, state: 'active'})) : previous; },
    capture: {take(kind) {
      if (kind === 'messages') { events.push('intake_receipt'); intakeRead = true; return intake; }
      assert.equal(kind, 'window'); assert.equal(admitted, true); events.push('admission_receipt'); return window;
    }}});
  return {ui, text, events};
}

test('first and joined work each need a distinct owner admission after the ordinary intake receipt', async () => {
  for (const join of [false, true]) {
    const {ui, text, events} = fixture(join);
    const result = await ui.send(text);
    assert.deepEqual(events, ['draft', 'Send', 'intake_receipt',
      join ? 'Add to current work' : 'Start work', 'admission_receipt']);
    assert.equal(result.proof.fresh_budget, !join);
    assert.equal(result.proof.original_budget_preserved, join);
  }
});

test('an unsuccessful intake never proceeds to window admission', async () => {
  const {ui, text, events} = fixture(false, 409);
  await assert.rejects(ui.send(text), /control_response_not_successful/);
  assert.deepEqual(events, ['draft', 'Send', 'intake_receipt']);
});
