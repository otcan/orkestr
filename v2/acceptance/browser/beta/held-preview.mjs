import assert from 'node:assert/strict';

const FIELDS = [['Saved message', 'message_id'], ['Source event', 'source_event_id'],
  ['Input sequence', 'scope_sequence'], ['Stop boundary run', 'boundary_run_id'],
  ['Stop boundary event', 'boundary_event_id'], ['Held through input sequence', 'through_scope_sequence']];

// The caller first proves this row's owner/conversation, intake and Stop lineage
// with assertHeldInput. This is only the product's bounded display projection;
// the original fixed input and canonical provenance remain unchanged.
export function heldPreviewObservation({origin, text, held}) {
  assert.equal(new URL(origin).origin, origin);
  assert(typeof text === 'string' && text.trim() && text.isWellFormed() && Buffer.byteLength(text) <= 4096);
  const chars = [...text]; // Rust str::chars counts Unicode scalars, not UTF-16 units.
  const preview = chars.slice(0, 180).join('') + (chars.length > 180 ? '…' : '');
  return {origin, preview, provenance: FIELDS.map(([label, key]) => [label, String(held[key])])};
}

// Evaluated without module closures in the owned page. Match the exact rendered
// list row and all six provenance values, never arbitrary section text.
export function heldPreviewRendered({origin, preview, provenance}) {
  if (location.origin !== origin) throw Error('unexpected_origin');
  const panels = [...document.querySelectorAll('section[aria-label="Held input"]')];
  if (panels.length !== 1) return false;
  const rows = [...panels[0].querySelectorAll(':scope > ol > li')];
  if (rows.length > 100) return false;
  const matches = [];
  for (const row of rows) {
    const lists = [...row.querySelectorAll(':scope > details > dl')];
    if (lists.length !== 1) continue;
    const fields = [...lists[0].children];
    if (fields.length !== 12) continue;
    const values = [];
    for (let index = 0; index < fields.length; index += 2) {
      if (fields[index].tagName !== 'DT' || fields[index + 1].tagName !== 'DD') return false;
      values.push([fields[index].textContent.trim(), fields[index + 1].textContent.trim()]);
    }
    if (values[0][0] === provenance[0][0] && values[0][1] === provenance[0][1]) matches.push({row, values});
  }
  if (matches.length !== 1) return false;
  const {row, values} = matches[0];
  if (!values.every(([label, value], index) => label === provenance[index][0] && value === provenance[index][1])) return false;
  const paragraphs = [...row.querySelectorAll(':scope > p')];
  return paragraphs[1]?.textContent === preview &&
    paragraphs[2]?.textContent === 'Preview from loaded conversation messages. Saved time unavailable.';
}
