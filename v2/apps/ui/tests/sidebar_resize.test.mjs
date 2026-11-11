import test from 'node:test';
import assert from 'node:assert/strict';
import {MIN, MAX, STEP, KEY, clampWidth, keyWidth, maxWidth, installResize} from '../src/sidebar_resize.mjs';

function element() {
  const listeners = {}, attributes = {};
  return {
    dataset: {}, attributes, listeners,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, fn) => { (listeners[name] ??= []).push(fn); },
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    fire(name, event = {}) { for (const fn of [...(listeners[name] ?? [])]) fn({preventDefault() { event.prevented = true; }, ...event}); return event; },
  };
}
function fixture({stored = null, blocked = false, viewport = 1440, width = 315} = {}) {
  const handle = element(), saved = new Map(stored === null ? [] : [[KEY, stored]]);
  const style = new Map();
  const sidebar = {getBoundingClientRect: () => ({width: style.has('--sidebar-width') ? parseInt(style.get('--sidebar-width')) : width})};
  const workspace = {dataset: {}, style: {setProperty: (k, v) => style.set(k, v), removeProperty: k => style.delete(k)}, querySelector: () => sidebar};
  const localStorage = {getItem: k => saved.has(k) ? saved.get(k) : null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k)};
  const env = {innerWidth: viewport, get localStorage() { if (blocked) throw new Error('SecurityError'); return localStorage; }};
  return {handle, workspace, style, saved, env};
}

test('widths stay within fixed bounds and 45% of the window', () => {
  assert.equal(clampWidth(100, 1440), MIN);
  assert.equal(clampWidth(9000, 1920), MAX);
  assert.equal(maxWidth(900), 405);
  assert.equal(clampWidth(470, 900), 405, 'a narrow desktop keeps room for the conversation');
  assert.equal(maxWidth(400), MIN, 'never below the minimum');
  for (const bad of [null, undefined, '', 'wide', NaN, Infinity]) assert.equal(clampWidth(bad, 1440), null, String(bad));
  assert.equal(keyWidth(300, 'ArrowRight', 1440), 300 + STEP);
  assert.equal(keyWidth(300, 'ArrowLeft', 1440), 300 - STEP);
  assert.equal(keyWidth(MIN, 'ArrowLeft', 1440), MIN);
  assert.equal(keyWidth(300, 'Home', 1440), MIN);
  assert.equal(keyWidth(300, 'End', 1440), MAX);
  assert.equal(keyWidth(300, 'Enter', 1440), null);
});

test('the splitter is labelled, keyboard operable and remembered per viewer', () => {
  const f = fixture();
  installResize(f.handle, f.workspace, f.env);
  assert.deepEqual([f.handle.attributes['aria-valuemin'], f.handle.attributes['aria-valuemax'], f.handle.attributes['aria-valuenow']], [String(MIN), String(MAX), '315']);
  const event = f.handle.fire('keydown', {key: 'ArrowRight'});
  assert.equal(event.prevented, true);
  assert.equal(f.style.get('--sidebar-width'), `${315 + STEP}px`);
  assert.equal(f.saved.get(KEY), String(315 + STEP));
  assert.equal(f.handle.attributes['aria-valuenow'], String(315 + STEP));
  const ignored = f.handle.fire('keydown', {key: 'Tab'});
  assert.equal(ignored.prevented, undefined, 'Tab still moves focus');
  f.handle.fire('keydown', {key: 'End'});
  assert.equal(f.style.get('--sidebar-width'), `${MAX}px`);
  assert.equal(installResize(f.handle, f.workspace, f.env), null, 'installs once');
});

test('dragging is bounded and saved once, on release', () => {
  const f = fixture();
  installResize(f.handle, f.workspace, f.env);
  f.handle.fire('pointerdown', {button: 0, clientX: 315, pointerId: 1});
  assert.equal(f.workspace.dataset.resizing, 'true');
  f.handle.fire('pointermove', {clientX: 2000});
  assert.equal(f.style.get('--sidebar-width'), `${MAX}px`);
  assert.equal(f.saved.has(KEY), false, 'no storage write per pixel');
  f.handle.fire('pointermove', {clientX: 0});
  assert.equal(f.style.get('--sidebar-width'), `${MIN}px`);
  f.handle.fire('pointerup', {clientX: 0});
  assert.equal(f.saved.get(KEY), String(MIN));
  assert.equal(f.workspace.dataset.resizing, undefined);
  assert.equal((f.handle.listeners.pointermove ?? []).length, 0, 'drag listeners are removed');
  f.handle.fire('dblclick');
  assert.equal(f.style.has('--sidebar-width'), false);
  assert.equal(f.saved.has(KEY), false, 'double-click restores the default');
});

test('a hostile stored width is clamped and blocked storage is harmless', () => {
  const big = fixture({stored: '99999'});
  installResize(big.handle, big.workspace, big.env);
  assert.equal(big.style.get('--sidebar-width'), `${MAX}px`);
  const junk = fixture({stored: 'calc(100vw)'});
  installResize(junk.handle, junk.workspace, junk.env);
  assert.equal(junk.style.has('--sidebar-width'), false, 'non-numbers never reach CSS');
  const blocked = fixture({blocked: true});
  installResize(blocked.handle, blocked.workspace, blocked.env);
  blocked.handle.fire('keydown', {key: 'ArrowLeft'});
  assert.equal(blocked.style.get('--sidebar-width'), `${315 - STEP}px`);
});
