// Synthetic DOM with the exact HeldInputsView element structure. No browser.
import assert from 'node:assert/strict';
import vm from 'node:vm';

const fields = [['Saved message', 'message_id'], ['Source event', 'source_event_id'],
  ['Input sequence', 'scope_sequence'], ['Stop boundary run', 'boundary_run_id'],
  ['Stop boundary event', 'boundary_event_id'], ['Held through input sequence', 'through_scope_sequence']];

export function productHeldRow(held, text) {
  // Independent fixture of saved_preview: consume 180 scalar values, then
  // append an ellipsis only if one further scalar exists.
  const iterator = text[Symbol.iterator](); let preview = '';
  for (let count = 0; count < 180; count++) {
    const next = iterator.next(); if (next.done) break; preview += next.value;
  }
  if (!iterator.next().done) preview += '…';
  return {...held, preview};
}

export function evaluateHeld(predicate, args, {origin, rows, panels = 1}) {
  const nodes = rows.map(row => {
    const children = fields.flatMap(([label, key]) =>
      [{tagName: 'DT', textContent: label}, {tagName: 'DD', textContent: String(row[key])}]);
    const paragraphs = [
      'Held by Stop; not automatically replayed', row.preview,
      'Preview from loaded conversation messages. Saved time unavailable.',
      'Resume unavailable: releasing held input is not supported yet.',
      'Cancel unavailable: cancelling held input is not supported yet. The input remains saved.',
    ].map(textContent => ({textContent}));
    return {textContent: [...paragraphs, ...children].map(node => node.textContent).join(''), querySelectorAll(selector) {
      if (selector === ':scope > details > dl') return [{children}];
      if (selector === ':scope > p') return paragraphs;
      assert.fail('unexpected_row_selector');
    }};
  });
  const panel = {textContent: nodes.map(node => node.textContent).join(''), querySelectorAll(selector) {
    assert.equal(selector, ':scope > ol > li'); return nodes;
  }};
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'section[aria-label="Held input"]'); return Array(panels).fill(panel);
    },
    querySelector(selector) { assert.equal(selector, 'section[aria-label="Held input"]'); return panels ? panel : null; },
  };
  return vm.runInNewContext(`(${predicate.toString()})(...args)`, {document, location: {origin}, args}, {timeout: 1000});
}
