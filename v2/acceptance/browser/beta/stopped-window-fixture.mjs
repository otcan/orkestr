// No browser or native process. Real chat/control/capture/read functions use
// this synthetic page transport; mutation order is recorded independently.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {browserChat} from './chat.mjs';

export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://example.invalid', conversation = id(1);
export const limits = {duration_ms: 900000, attempts: 32, bytes: 67108864,
  cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576};
const messages = ['synthetic first stream', 'synthetic held input',
  'synthetic fresh post Stop', 'synthetic accepted continuation'];
export const opening = {window_id: id(10), conversation_id: conversation, generation: 1,
  state: 'opening', input_message_id: id(100), input_event_id: id(200),
  predecessor_window_id: null, opened_at_ms: 1000, work_deadline_ms: 871000,
  expires_at_ms: 901000, limits};

export function stoppedWindowFixture(samples = ['retiring', 'retiring', 'closed']) {
  const signal = new AbortController(), page = new EventEmitter(), events = [];
  let stopped = false, closed = false, sends = 0, admissions = 0, window = null;
  let currentRun = id(20), draft = '', steering, reads = 0, cookies = 0, cleanup = 0;
  const accepted = [];
  const heldRow = {message_id: id(101), source_event_id: id(201), scope_sequence: 2,
    reason: 'stop_boundary', boundary_run_id: id(20), boundary_event_id: id(40),
    through_scope_sequence: 2};
  const status = () => ({schema_version: 1, conversation_id: conversation, run_id: currentRun,
    revision: 100 + sends * 10 + accepted.length * 2 + (stopped ? 2 : 0),
    control_revision: 3, observed_at_ms: 5000,
    phase: stopped && currentRun === id(20) ? 'cancelled' :
      accepted.some(a => a.run_id === currentRun) ? 'completed' : sends >= 3 ? 'awaiting_acceptance' : 'running',
    capabilities: {stop: !stopped && sends < 3, steer: !stopped && sends < 3},
    progress: {payload_id: id(Number(currentRun.slice(-12)) + 500), observed_at_ms: 4000},
    ...(sends >= 3 ? {acceptance_candidate: {run_id: currentRun, completion_event_id: id(300 + sends)}} : {})});
  const emit = (operation, request, receipt, code = 200) => page.emit('response', {
    url: () => `${origin}/api/v2/conversations/${conversation}/${operation}`,
    request: () => ({method: () => 'POST', postData: () => JSON.stringify(request)}),
    status: () => code, text: async () => JSON.stringify(receipt),
  });
  const write = name => {
    if (stopped && !closed) assert.fail('mutation_before_exact_stopped_window_closed');
    events.push(name);
  };
  const click = label => {
    if (label === 'Continue') return;
    if (label === 'Send') {
      write('message'); assert.equal(draft, messages[sends]);
      emit('messages', {text: draft, client_message_id: `input:${sends}`},
        {status: 'accepted', message_id: id(100 + sends), event_id: id(200 + sends), sequence: sends + 1}, 202);
      sends++; return;
    }
    if (label === 'Start work' || label === 'Add to current work') {
      write('admission');
      const join = admissions === 1 || admissions === 3;
      assert.equal(label, join ? 'Add to current work' : 'Start work');
      const prior = window, input = admissions;
      const request = {request_key: `window:${input}`, input_message_id: id(100 + input),
        input_event_id: id(200 + input), input_request_key: `input:${input}`,
        expected_generation: prior?.generation ?? 0,
        window_id: join ? prior.window_id : null, predecessor_window_id: !join ? prior?.window_id ?? null : null};
      if (!join) window = {...structuredClone(opening), window_id: id(10 + input),
        generation: input ? 2 : 1, input_message_id: id(100 + input), input_event_id: id(200 + input),
        predecessor_window_id: input ? opening.window_id : null};
      emit('window', request, {request_key: request.request_key,
        input_message_id: request.input_message_id, input_event_id: request.input_event_id,
        input_request_key: request.input_request_key, duplicate: false, status: structuredClone(window)}, 201);
      window.state = 'active'; admissions++;
      if (input >= 2) currentRun = id(20 + input);
      return;
    }
    if (label === 'Steer') {
      events.push('steer'); const before = status();
      const request = {text: 'synthetic steering', control: {run_id: currentRun,
        expected_revision: before.revision, expected_control_revision: 3, request_key: 'steer:1'}};
      const receipt = {conversation_id: conversation, run_id: currentRun, request_key: 'steer:1',
        message_id: id(400), event_id: id(401), scope_sequence: 3, disposition: 'reserved'};
      steering = {receipt, state: 'acknowledged', written_bytes: 100}; emit('steer', request, receipt); return;
    }
    if (label === 'Stop') {
      events.push('stop'); const before = status();
      const request = {run_id: currentRun, expected_revision: before.revision,
        expected_control_revision: 3, request_key: 'stop:1'};
      emit('stop', request, {schema_version: 1, conversation_id: conversation, run_id: currentRun,
        request_key: request.request_key, requested_revision: before.revision,
        revision: before.revision + 1, outcome: 'requested_unknown'});
      stopped = true; return;
    }
    assert.equal(label, 'Accept completion'); write('accept'); const before = status();
    const request = {run_id: currentRun, completion_event_id: before.acceptance_candidate.completion_event_id,
      expected_revision: before.revision, request_key: `accept:${sends}`};
    const receipt = {schema_version: 1, conversation_id: conversation, run_id: request.run_id,
      completion_event_id: request.completion_event_id, request_key: request.request_key,
      requested_revision: before.revision, revision: before.revision + 1,
      acceptance_event_id: id(600 + sends), outcome: 'succeeded'};
    accepted.push(receipt); emit('accept', request, receipt);
  };
  const read = path => {
    const leaf = path.split('/').at(-1).split('?')[0];
    if (path === '/api/v2/beta') return {schema_version: 1, conversation_id: conversation,
      provider: 'codex', role: 'deep', controls: {stop: false, steer: false, accept: false}, limits, window};
    if (leaf === 'window') {
      if (stopped && admissions === 2 && !closed) {
        const sample = samples[Math.min(reads++, samples.length - 1)];
        events.push(`window:${typeof sample === 'string' ? sample : 'invalid'}`);
        const value = typeof sample === 'string' ? {...window, state: sample} : sample;
        if (value?.state === 'closed') { closed = true; window = value; }
        return value;
      }
      return window;
    }
    if (leaf === 'execution') return status();
    if (path.includes('/payloads/')) {
      const row = accepted.find(a => id(Number(a.run_id.slice(-12)) + 500) === leaf);
      return {payload_id: leaf, conversation_id: conversation, run_id: row?.run_id ?? currentRun,
        text: 'synthetic committed output'};
    }
    if (leaf === 'held-inputs') {
      events.push('held');
      return {schema_version: 1, conversation_id: conversation, revision: status().revision,
        observed_at_ms: 5000, eligible_input_available: false, held: [heldRow], next_after_sequence: null};
    }
    if (leaf === 'accepted-results') return {conversation_id: conversation, next_after_sequence: null,
      results: accepted.map((a, i) => ({run_id: a.run_id, completion_event_id: a.completion_event_id,
        acceptance_event_id: a.acceptance_event_id, acceptance_sequence: 100 + i,
        payload_id: id(Number(a.run_id.slice(-12)) + 500), payload_removed: false}))};
    if (path.includes('/steering/')) return steering;
    assert.fail('unexpected_read');
  };
  Object.assign(page, {
    url: () => origin, goto: async () => ({url: () => origin}),
    reload: async () => ({url: () => origin}), waitForSelector: async () => {},
    waitForFunction: async () => true,
    $eval: async (selector, _callback, value) => {
      if (selector === '#composer') { write('draft'); draft = value.value; }
    },
    evaluate: async (callback, value, ...rest) => {
      if (rest.length) return click(value);
      if (value?.path) return {status: 200, raw: JSON.stringify(read(value.path))};
      if (value === origin) return {conversation};
      if (value?.origin === origin && Object.keys(value).length === 1) {
        return {conversation_id: conversation, run_id: currentRun,
          payload_id: status().progress.payload_id, text: 'synthetic committed output'};
      }
      if (value?.text) return true;
      assert.equal(value, undefined);
    },
  });
  return {events, run: () => browserChat({page, origin, expectedConversation: conversation,
    context: {cookies: async () => ++cookies === 1 ? [] : [{name: 'orkestr_v2_session', httpOnly: true, sameSite: 'Strict', path: '/api/v2'}]},
    sourceSha: 'a'.repeat(40), credentials: {username: 'synthetic', password: 'synthetic'},
    fixture: {mode: 'synthetic', messages, steering: 'synthetic steering', requireSteer: true},
    signal: signal.signal, verifyServedPair: async () => true, verifyLease: async () => true,
    closeContext: async () => { cleanup++; return true; }}), checked() {
    assert.equal(cleanup, 1); assert.equal(page.listenerCount('response'), 0);
  }};
}
