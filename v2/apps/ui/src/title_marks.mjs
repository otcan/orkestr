// Marks in front of the browser tab's title (ORK-804). Their state lives on
// the document, so every copy of this module sees the same marks, and a title
// the page sets meanwhile keeps its marks in front. Since writes apply on
// their own (ORK-810) the only mark is the connected folder.
const KEY = Symbol.for('orkestr.title-marks');
// Outermost first; marks with the same text are shown once.
const MARKS = [
  // This tab serves a local folder.
  ['folder', '● '],
];

/** Turn the mark `name` (folder) on or off. */
export function setTitleMark(document, name, on) {
  if (!MARKS.some(([mark]) => mark === name)) throw Error('Unknown title mark');
  const state = document[KEY] ??= {marks: new Set(), applied: ''};
  const current = document.title || '';
  // Only the prefix this module applied is replaced: a title the page set
  // since then is the new base.
  const base = state.applied && current.startsWith(state.applied) ? current.slice(state.applied.length) : current;
  if (on) state.marks.add(name); else state.marks.delete(name);
  state.applied = [...new Set(MARKS.filter(([mark]) => state.marks.has(mark)).map(([, text]) => text))].join('');
  if (state.applied + base !== current) document.title = state.applied + base;
}
