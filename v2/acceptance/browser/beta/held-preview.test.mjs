import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heldPreviewObservation, heldPreviewRendered} from './held-preview.mjs';
import {evaluateHeld, productHeldRow} from './held-preview-fixture.mjs';
import {id, stoppedWindowFixture} from './stopped-window-fixture.mjs';

const origin = 'https://example.invalid';
const held = {message_id: id(101), source_event_id: id(201), scope_sequence: 2n,
  reason: 'stop_boundary', boundary_run_id: id(20), boundary_event_id: id(40), through_scope_sequence: 2n};
const longText = '😀e\u0301'.repeat(81) + '終!'; // 245 scalars, including supplementary and combining characters.
const observe = text => heldPreviewObservation({origin, text, held});
const render = (text, rows = [productHeldRow(held, text)], extra = {}) =>
  evaluateHeld(heldPreviewRendered, [observe(text)], {origin, rows, ...extra});

test('real chat keeps the full long Unicode input and verifies its bounded held preview before further input', async () => {
  const fixture = stoppedWindowFixture(['closed'], {heldText: longText});
  const report = await fixture.run(); fixture.checked();
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.actions, {messages: 4, stop: 1, acceptance: 2, steering: 1});
  assert.equal(report.checks.find(check => check.name === 'held_input').held_preview_visible, true);
  assert.equal(fixture.events.filter(event => event === 'held:preview').length, 1);
  assert(fixture.events.indexOf('held:preview') < fixture.events.lastIndexOf('message'));
});

test('preview uses the exact Rust scalar boundary and does not truncate by UTF-16 or grapheme count', () => {
  for (const text of ['short input', '😀'.repeat(180), '😀'.repeat(181), longText]) {
    assert.equal(render(text), true);
    assert.equal(observe(text).preview, productHeldRow(held, text).preview);
  }
  assert.equal(observe('😀'.repeat(180)).preview.endsWith('…'), false);
  assert.equal(observe('😀'.repeat(181)).preview, '😀'.repeat(180) + '…');
  assert.equal([...observe(longText).preview].length, 181);
  assert.equal(render(longText, [{...held, preview: longText.slice(0, 180) + '…'}]), false);
});

test('preview in a different message row or copied section text cannot prove the admitted hold', () => {
  assert.equal(render(longText, [productHeldRow({...held, message_id: id(999)}, longText)]), false);
  assert.equal(render(longText, [productHeldRow(held, 'wrong preview'),
    productHeldRow({...held, message_id: id(999)}, longText)]), false);
  assert.equal(render(longText, [productHeldRow(held, longText), productHeldRow(held, longText)]), false);
  assert.equal(render(longText, undefined, {panels: 2}), false);
});

test('matching preview and message still require every source and Stop boundary value', () => {
  for (const [key, value] of [['source_event_id', id(999)], ['scope_sequence', 3n],
    ['boundary_run_id', id(999)], ['boundary_event_id', id(999)], ['through_scope_sequence', 3n]]) {
    assert.equal(render(longText, [productHeldRow({...held, [key]: value}, longText)]), false, key);
  }
  assert.equal(render(longText, [productHeldRow(held, longText.slice(1))]), false);
  assert.equal(render(longText, [productHeldRow(held, longText.slice(0, 100))]), false);
});

test('foreign origin refuses even an otherwise matching held row', () => {
  assert.throws(() => render(longText, undefined, {origin: 'https://other.invalid'}), /unexpected_origin/);
});

test('real chat refuses a different held DOM row before any post-Stop mutation', async () => {
  const fixture = stoppedWindowFixture(['closed'], {heldText: longText,
    heldRows: [productHeldRow({...held, message_id: id(999)}, longText)]});
  const report = await fixture.run(); fixture.checked();
  assert.equal(report.status, 'failed'); assert.equal(report.failure.phase, 'held_input');
  assert.deepEqual(report.actions, {messages: 2, stop: 1, acceptance: 0, steering: 1});
  assert.equal(report.cleanup.case_work, 'joined');
});
