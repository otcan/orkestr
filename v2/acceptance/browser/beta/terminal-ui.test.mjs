import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionUi} from './execution-ui.mjs';
import {ownerReads} from './owner-reads.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://example.invalid', conversation = id(1), run = id(2);

// The 84f7 server requires a live scope for GET execution?run_id, but its
// unselected owner projection remains readable after Context.close removes
// that scope. Exercise the actual UI driver and ownerReads status/JSON gate;
// only the page and transport are synthetic. No native or browser is started.
function fixture(operation, {after = {}, responseStatus = 200, pending = false,
  receiptChanges = {}} = {}) {
  const abort = new AbortController(), reads = [], clicks = [];
  let mutated = false, terminalReads = 0, captured = 0;
  const before = {schema_version: 1, conversation_id: conversation, run_id: run,
    revision: 20, control_revision: 3, observed_at_ms: 5000,
    phase: operation === 'stop' ? 'running' : 'awaiting_acceptance',
    capabilities: {stop: operation === 'stop', steer: false},
    ...(operation === 'accept' ? {acceptance_candidate: {run_id: run, completion_event_id: id(4)}} : {})};
  const request = {run_id: run, request_key: `${operation}:synthetic`, expected_revision: 20,
    ...(operation === 'stop' ? {expected_control_revision: 3} : {completion_event_id: id(4)})};
  const receipt = {schema_version: 1, conversation_id: conversation, run_id: run,
    request_key: request.request_key, requested_revision: 20, revision: 21,
    ...(operation === 'stop' ? {outcome: 'requested_unknown'} :
      {outcome: 'succeeded', completion_event_id: id(4), acceptance_event_id: id(5)}),
    ...receiptChanges};
  const terminal = {...before, revision: 22,
    phase: operation === 'stop' ? 'cancelled' : 'completed',
    acceptance_candidate: undefined, capabilities: {stop: false, steer: false}, ...after};
  const page = {
    url: () => origin,
    waitForFunction: async (_predicate, _options, label) => {
      assert.equal(label, operation === 'stop' ? 'Stop' : 'Accept completion');
    },
    evaluate: async (_callback, argument) => {
      if (typeof argument === 'string') {
        assert.equal(argument, operation === 'stop' ? 'Stop' : 'Accept completion');
        assert.equal(mutated, false, 'the control must never be retried');
        clicks.push(argument); mutated = true; return;
      }
      assert.equal(argument.origin, origin);
      reads.push(argument.path);
      if (!mutated) {
        assert.equal(argument.path, `/api/v2/conversations/${conversation}/execution?run_id=${run}`);
        return {status: 200, raw: JSON.stringify(before)};
      }
      // Scope removal is deterministic here: the old selected read gets 503.
      if (argument.path.includes('?')) return {status: 503};
      assert.equal(argument.path, `/api/v2/conversations/${conversation}/execution`);
      terminalReads++;
      // A persistently nonterminal response must not become success. Abort only
      // on its second read, after the driver's first predicate has rejected it.
      if (pending && terminalReads === 2) abort.abort();
      return {status: responseStatus, ...(responseStatus === 200 ? {raw: JSON.stringify(terminal)} : {})};
    },
  };
  const ui = executionUi({page, origin, conversation, signal: abort.signal,
    verifyLease: async () => true,
    read: ownerReads(page, conversation, abort.signal, origin),
    capture: {take: async kind => {
      assert.equal(kind, operation); assert.equal(mutated, true); captured++;
      return {status: 200, request: JSON.stringify(request), response: JSON.stringify(receipt)};
    }}});
  return {ui, reads, clicks, invoke: () => ui[operation](run),
    checked() {
      assert.equal(clicks.length, 1); assert.equal(captured, 1);
      assert.deepEqual(ui.counts(), {messages: 0, stop: operation === 'stop' ? 1 : 0,
        acceptance: operation === 'accept' ? 1 : 0, steering: 0});
    }};
}

for (const operation of ['stop', 'accept']) {
  test(`${operation}: a retired scope uses the durable exact-run terminal projection`, async () => {
    const f = fixture(operation), result = await f.invoke(); f.checked();
    assert.equal(result.after.run_id, run);
    assert.equal(result.after.phase, operation === 'stop' ? 'cancelled' : 'completed');
    assert.deepEqual(f.reads, [`/api/v2/conversations/${conversation}/execution?run_id=${run}`,
      `/api/v2/conversations/${conversation}/execution`]);
    if (operation === 'stop') assert.equal(result.proof.native_reap_independently_required, true);
    else assert.equal(result.proof.exact_completion_bound, true);
  });

  test(`${operation}: foreign run or conversation and stale revision cannot satisfy terminal proof`, async () => {
    for (const after of [{run_id: id(9)}, {conversation_id: id(9)}, {revision: 20}]) {
      const f = fixture(operation, {after});
      await assert.rejects(f.invoke(), {code: 'ERR_ASSERTION'}); f.checked();
    }
  });

  test(`${operation}: unavailable durable reads are failures, never evidence of retirement`, async () => {
    for (const responseStatus of [401, 403, 404, 503]) {
      const f = fixture(operation, {responseStatus});
      await assert.rejects(f.invoke(), /owner_observation_unavailable/); f.checked();
    }
  });

  test(`${operation}: another terminal or request/proposal state never receives completion credit`, async () => {
    const phases = operation === 'stop' ? ['cancel_requested', 'completed'] : ['awaiting_acceptance', 'cancelled'];
    for (const phase of phases) {
      const f = fixture(operation, {after: {phase}, pending: true});
      await assert.rejects(f.invoke(), {name: 'AbortError'}); f.checked();
      assert.equal(f.reads.length, 3, 'the first nonterminal sample must not complete');
    }
  });

  test(`${operation}: failed or blocked projection remains a failure`, async () => {
    for (const phase of ['failed', 'blocked']) {
      const f = fixture(operation, {after: {phase}});
      await assert.rejects(f.invoke(), {code: 'not_completed'}); f.checked();
    }
  });

  test(`${operation}: original control receipt correlation remains required for terminal proof`, async () => {
    const f = fixture(operation, {receiptChanges: {run_id: id(9)}});
    await assert.rejects(f.invoke(), {code: 'ERR_ASSERTION'}); f.checked();
    // accept's original implementation validates the full receipt with the
    // terminal snapshot; neither path may credit a different run as this one.
  });
}

test('Stop still requires disabled capabilities on the cancelled projection', async () => {
  for (const capabilities of [{stop: true, steer: false}, {stop: false, steer: true}]) {
    const f = fixture('stop', {after: {capabilities}});
    await assert.rejects(f.invoke(), {code: 'ERR_ASSERTION'}); f.checked();
  }
});
