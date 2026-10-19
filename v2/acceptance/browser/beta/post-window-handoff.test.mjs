import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postWindowPurpose, priorAccepted, nextWindowHandoff} from './post-window-handoff.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const receipt = n => ({conversation_id: id(1), run_id: id(n), completion_event_id: id(n + 1),
  acceptance_event_id: id(n + 2), outcome: 'succeeded'});
const first = {window_id: id(2), generation: 1, accepted: [receipt(10), receipt(20)], held: [{message_id: id(3)}]};

test('original continuity and separate restart require exactly two and three prior accepted results', () => {
  assert.equal(postWindowPurpose('post_continuity').priorAccepted, 2);
  assert.equal(postWindowPurpose('post_service_restart').priorAccepted, 3);
  assert.throws(() => postWindowPurpose('replay_any_phase'));
  assert.equal(priorAccepted(first, id(1), 'post_continuity').length, 2);
  assert.throws(() => priorAccepted(first, id(1), 'post_service_restart'));
});

test('fifth result exports exact new window and third acceptance without cleanup authority or content', () => {
  const next = nextWindowHandoff({predecessor: first, conversation: id(1), purpose: 'post_continuity',
    window: {window_id: id(4), predecessor_window_id: id(2), generation: 2n, conversation_id: id(1)},
    accepted: {...receipt(30), text: 'must not retain provider content', secret: 'must not retain'}});
  assert.deepEqual(next, {window_id: id(4), generation: 2,
    accepted: [receipt(10), receipt(20), receipt(30)], held: first.held});
  assert.notEqual(next.held, first.held); assert.equal(next.state, undefined);
  assert.equal(priorAccepted(next, id(1), 'post_service_restart').length, 3);
  assert.throws(() => priorAccepted(next, id(1), 'post_continuity'));
});

test('foreign, duplicate and failed prior acceptance cannot authorize the restart case', () => {
  for (const changed of [{...receipt(30), conversation_id: id(99)}, receipt(10),
    {...receipt(30), outcome: 'pending'}]) {
    assert.throws(() => priorAccepted({...first, accepted: [...first.accepted, changed]}, id(1), 'post_service_restart'));
  }
});

test('handoff refuses old-window reuse, wrong predecessor, generation overflow and duplicate result', () => {
  const data = {predecessor: first, conversation: id(1), purpose: 'post_continuity',
    window: {window_id: id(4), predecessor_window_id: id(2), generation: 2n, conversation_id: id(1)},
    accepted: receipt(30)};
  for (const changed of [{window_id: id(2)}, {predecessor_window_id: id(99)},
    {generation: 9007199254740992n}, {conversation_id: id(99)}]) {
    assert.throws(() => nextWindowHandoff({...data, window: {...data.window, ...changed}}));
  }
  assert.throws(() => nextWindowHandoff({...data, accepted: receipt(10)}));
});
