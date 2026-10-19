import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {loginOwner} from './ui.mjs';
import {clickReady} from './readiness.mjs';

const origin = 'https://example.invalid';
const credentials = {username: 'synthetic', password: 'synthetic-only'};

test('a foreign redirect refuses before either credential field is touched', async () => {
  let fills = 0, selectors = 0;
  const page = {goto: async () => ({url: () => 'https://foreign.invalid/'}),
    url: () => 'https://foreign.invalid/', waitForSelector: async () => { selectors++; },
    $eval: async () => { fills++; }};
  await assert.rejects(loginOwner({page, context: {cookies: async () => []}, origin, credentials}),
    {code: 'unexpected_origin'});
  assert.equal(fills, 0); assert.equal(selectors, 0);
});

test('navigation after readiness cannot enter a credential on the changed origin', async () => {
  let fills = 0;
  const page = {goto: async () => ({url: () => origin}), url: () => origin,
    waitForSelector: async () => {}, async $eval(selector, fn, argument) {
      const Input = function() {};
      Object.defineProperty(Input.prototype, 'value', {set() { fills++; }});
      return vm.runInNewContext(`(${fn.toString()})(node, argument)`, {
        node: {dispatchEvent() {}}, argument, location: {origin: 'https://foreign.invalid'},
        HTMLInputElement: Input, Event: class {},
      });
    }};
  await assert.rejects(loginOwner({page, context: {cookies: async () => []}, origin, credentials}),
    /unexpected_origin/);
  assert.equal(fills, 0);
});

test('navigation between enabled readiness and submit refuses the one-shot click', async () => {
  let clicks = 0;
  const page = {waitForFunction: async () => {}, async evaluate(fn, expected, requiredOrigin) {
    return vm.runInNewContext(`(${fn.toString()})(expected, requiredOrigin)`, {
      expected, requiredOrigin, location: {origin: 'https://foreign.invalid'},
      document: {querySelectorAll: () => [{textContent: 'Continue', disabled: false, click() { clicks++; }}]},
    });
  }};
  await assert.rejects(clickReady(page, 'Continue', origin), /unexpected_origin/);
  assert.equal(clicks, 0);
});
