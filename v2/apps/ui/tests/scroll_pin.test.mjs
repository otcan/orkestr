import test from 'node:test';
import assert from 'node:assert/strict';
import { installPin, THRESHOLD } from '../src/scroll_pin.mjs';

function fakeEnv() {
  const observers = [];
  class Observer { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } }
  return { env: { MutationObserver: Observer, ResizeObserver: Observer }, fire: () => observers.forEach(o => !o.off && o.cb()) };
}
function fakeElement() {
  const listeners = {};
  return { dataset: {}, scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    addEventListener: (name, cb) => { listeners[name] = cb; }, scroll(top) { this.scrollTop = top; listeners.scroll(); } };
}

test('opens at the newest message and follows new ones while at the bottom', () => {
  const { env, fire } = fakeEnv(), el = fakeElement();
  const pin = installPin(el, env);
  assert.equal(el.scrollTop, 1000);
  assert.equal(el.dataset.pinned, 'true');
  el.scrollHeight = 1600; fire();
  assert.equal(el.scrollTop, 1600);
  assert.equal(installPin(el, env), null, 'installs once per element');
  pin.stop();
});

test('scrolling up releases the pin; returning or jumping restores it', () => {
  const { env, fire } = fakeEnv(), el = fakeElement();
  const pin = installPin(el, env);
  el.scroll(100);
  assert.equal(el.dataset.pinned, 'false');
  el.scrollHeight = 1800; fire();
  assert.equal(el.scrollTop, 100, 'new messages do not move a reader who scrolled up');
  el.scroll(el.scrollHeight - el.clientHeight - THRESHOLD + 1);
  assert.equal(el.dataset.pinned, 'true');
  el.scroll(0); pin.bottom();
  assert.equal(el.scrollTop, 1800);
  assert.ok(pin.pinned());
});
