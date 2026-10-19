import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {clickReady, timedNavigation} from './readiness.mjs';

test('late hydration and a disabled setup control do not produce an early click', async () => {
  let buttons = [], clicks = 0, checked = 0;
  const execute = (fn, label) => vm.runInNewContext(`(${fn.toString()})(label)`,
    {document: {querySelectorAll: () => buttons}, label});
  const page = {
    async waitForFunction(fn, options, label) {
      assert.equal(options.timeout, 10_000);
      assert.equal(execute(fn, label), false); checked++;
      const button = {textContent: label, disabled: true, click() { clicks++; }};
      buttons = [button]; assert.equal(execute(fn, label), false); checked++;
      button.disabled = false; assert.equal(execute(fn, label), true); checked++;
    },
    evaluate: execute,
  };
  await clickReady(page, 'First-time setup');
  assert.equal(checked, 3); assert.equal(clicks, 1);
});

test('readiness is rechecked at the single action and never becomes a submit retry', async () => {
  let clicks = 0;
  const page = {
    async waitForFunction() {},
    async evaluate(fn, label) {
      return vm.runInNewContext(`(${fn.toString()})(label)`, {label,
        document: {querySelectorAll: () => [{textContent: label, disabled: true, click() { clicks++; }}]}});
    },
  };
  await assert.rejects(clickReady(page, 'Send'));
  await assert.rejects(clickReady(page, 'arbitrary destination'), {code: 'invalid_action'});
  assert.equal(clicks, 0);
});

test('normal timing contains no URL, content or credentials and waits for rendering', async () => {
  const steps = [];
  const page = {url: () => 'https://example.invalid/', async goto(url, options) {
    steps.push('navigate'); assert.equal(options.waitUntil, 'domcontentloaded'); return {url: () => url}; }};
  const timing = await timedNavigation(page, 'https://example.invalid/', async () => { steps.push('render'); });
  assert.deepEqual(steps, ['navigate', 'render']);
  assert.deepEqual(Object.keys(timing), ['render_ms']);
  assert(Number.isSafeInteger(timing.render_ms));
  await assert.rejects(timedNavigation(page, 'https://private:secret@example.invalid/'), {code: 'invalid_action'});
});
