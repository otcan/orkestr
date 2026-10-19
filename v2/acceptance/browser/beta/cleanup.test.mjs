import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Cleanup, detachOwned} from './cleanup.mjs';

test('every owned cleanup is attempted after a failed join; unknown is retained', async () => {
  const cleanup = new Cleanup(), called = [];
  cleanup.add('owned_context', async () => { called.push('context'); throw Error('private content'); });
  cleanup.add('download_helper', async () => { called.push('helper'); return true; });
  cleanup.add('desktop_lease', async () => { called.push('lease'); return true; });
  const receipt = await cleanup.close();
  assert.equal(receipt.complete, false);
  assert.deepEqual(called, ['context', 'helper', 'lease']);
  assert.deepEqual(receipt.results.map(item => item.state), ['unknown', 'closed', 'closed']);
  assert(!JSON.stringify(receipt).includes('private content'));
});

test('a timed out operation is not credited when it later resolves', async () => {
  let release;
  const cleanup = new Cleanup();
  cleanup.add('owned_context', () => new Promise(resolve => { release = resolve; }), 5);
  cleanup.add('runtime_configuration', async () => true);
  const receipt = await cleanup.close();
  release(true);
  await Promise.resolve();
  assert.equal(receipt.complete, false);
  assert.equal(receipt.results[0].state, 'unknown');
  assert.equal(receipt.results[1].state, 'closed');
  await assert.rejects(cleanup.close(), {code: 'invalid_action'});
});

test('only exact owned detached true skips detach, and live failures remain failures', async () => {
  let called = 0;
  assert.equal(await detachOwned({detached: true, detach() { called++; throw Error('must not run'); }}), true);
  assert.equal(called, 0);
  await assert.rejects(detachOwned({detached: false, async detach() { called++; throw Error('failed'); }}));
  assert.equal(called, 1);
  const cleanup = new Cleanup();
  assert.throws(() => cleanup.add('shared_browser', () => true), {code: 'invalid_action'});
  assert.throws(() => cleanup.add('always_on_service', () => true), {code: 'invalid_action'});
});

test('undefined or optimistic cleanup result is not proof of closed resources', async () => {
  const cleanup = new Cleanup();
  cleanup.add('owned_context', async () => undefined);
  cleanup.add('download_helper', async () => ({complete: true}));
  assert.equal((await cleanup.close()).complete, false);
});
