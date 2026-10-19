import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {waitStoppedWindow} from './stopped-window.mjs';
import {opening, id} from './stopped-window-fixture.mjs';

const check = (read, options = {}) => waitStoppedWindow({read, opening,
  conversation: opening.conversation_id, signal: new AbortController().signal, ...options});

test('only the exact closed original window passes; all immutable fields remain bound', async () => {
  await check(async kind => { assert.equal(kind, 'window'); return {...opening, state: 'closed'}; });
  for (const changed of [{window_id: id(9)}, {conversation_id: id(9)}, {generation: 2},
    {input_message_id: id(9)}, {input_event_id: id(9)}, {predecessor_window_id: id(9)},
    {opened_at_ms: 1001}, {work_deadline_ms: 871001}, {expires_at_ms: 901001},
    ...Object.keys(opening.limits).map(key => ({limits: {...opening.limits, [key]: opening.limits[key] + 1}}))]) {
    await assert.rejects(check(async () => ({...opening, state: 'closed', ...changed})),
      /stopped_window_identity_or_budget_changed/);
  }
});

test('missing, opening, reconciliation and unknown states refuse immediately', async () => {
  for (const value of [null, undefined, ...['opening', 'reconciliation_required', 'unknown']
    .map(state => ({...opening, state}))]) {
    let reads = 0;
    await assert.rejects(check(async () => { reads++; return value; }));
    assert.equal(reads, 1);
  }
});

test('a nonterminal window expires without another action or restarted deadline', async () => {
  for (const state of ['active', 'retiring']) {
    let reads = 0;
    await assert.rejects(check(async () => { reads++; return {...opening, state}; }, {timeoutMs: 20}),
      {code: 'timeout'});
    assert.equal(reads, 1);
  }
});

test('a closed reply arriving after the absolute deadline cannot pass', async () => {
  let settled = false;
  await assert.rejects(check(async () => {
    await delay(40); settled = true; return {...opening, state: 'closed'};
  }, {timeoutMs: 10}), {code: 'timeout'});
  await delay(50); assert.equal(settled, true);
});

test('abort during a pending read prevents late success and further reads', async () => {
  const abort = new AbortController(); let reads = 0;
  await assert.rejects(check(async () => {
    reads++; abort.abort(); return {...opening, state: 'closed'};
  }, {signal: abort.signal}), {name: 'AbortError'});
  assert.equal(reads, 1);
});

test('retiring cannot regress to active and unavailable reads are not retried', async () => {
  let reads = 0;
  await assert.rejects(check(async () => ({...opening, state: ++reads === 1 ? 'retiring' : 'active'})),
    {code: 'not_completed'});
  assert.equal(reads, 2);
  reads = 0;
  await assert.rejects(check(async () => { reads++; throw Error('owner_observation_unavailable'); }),
    /owner_observation_unavailable/);
  assert.equal(reads, 1);
});
