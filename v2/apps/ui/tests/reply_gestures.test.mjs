import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../src/reply_gestures.mjs', import.meta.url), 'utf8');
const {installReplyGestures, HOLD_MS} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// A minimal document: one replyable row with a Reply button and a text node.
function fixture() {
  const doc = new EventTarget();
  let clicks = 0;
  const button = {click: () => { clicks++; }, closest: s => (s.includes('button') ? button : null)};
  const row = {querySelector: () => button};
  const text = {closest: s => (s === '[data-replyable="true"]' ? row : null)};
  const timers = [];
  const env = {setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; }, navigator: {}};
  const touch = (type, target, x = 10, y = 10, touches = 1) => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', {value: target});
    event.touches = Array.from({length: touches}, () => ({clientX: x, clientY: y}));
    doc.dispatchEvent(event);
  };
  const fire = () => timers.forEach(t => t.fn?.());
  return {doc, env, text, button, touch, fire, timers, clicks: () => clicks};
}

test('a long press on a message presses its Reply button once', () => {
  const f = fixture();
  assert.equal(installReplyGestures(f.doc, f.env), true);
  assert.equal(installReplyGestures(f.doc, f.env), false, 'installs once');
  f.touch('touchstart', f.text);
  assert.equal(f.timers[0].ms, HOLD_MS);
  f.fire();
  assert.equal(f.clicks(), 1);
});

test('lifting early, moving, two fingers or touching a control never replies', () => {
  for (const run of [
    f => { f.touch('touchstart', f.text); f.touch('touchend', f.text); },
    f => { f.touch('touchstart', f.text); f.touch('touchmove', f.text, 40, 10); },
    f => { f.touch('touchstart', f.text, 10, 10, 2); },
    f => { f.touch('touchstart', f.button); },
  ]) {
    const f = fixture();
    installReplyGestures(f.doc, f.env);
    run(f);
    f.fire();
    assert.equal(f.clicks(), 0);
  }
});
