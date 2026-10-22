import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../src/outbox_store.mjs', import.meta.url), 'utf8');
const {loadOutbox, storeOutbox, waitOutbox} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const prefix = 'orkestr.v2.outbox.00000000-0000-4000-8000-00000000000a.';
function memory() {
  const map = new Map();
  return {map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
}

test('items are stored one entry per key and read back only under the owner prefix', () => {
  const storage = memory();
  assert.ok(storeOutbox(prefix, [['k-1', '{"a":1}'], ['k-2', '{"b":2}']], storage));
  storage.setItem('orkestr.v2.outbox.00000000-0000-4000-8000-00000000000b.k-3', '{}');
  storage.setItem('unrelated', 'x');
  assert.deepEqual(loadOutbox(prefix, storage).sort(), ['{"a":1}', '{"b":2}']);
  assert.ok(storeOutbox(prefix, [['k-1', null]], storage));
  assert.deepEqual(loadOutbox(prefix, storage), ['{"b":2}']);
  // Composer messages use `web:<uuid>` request keys; they persist too.
  assert.ok(storeOutbox(prefix, [['web:00000000-0000-4000-8000-000000000001', '{"c":3}']], storage));
  assert.deepEqual(loadOutbox(prefix, storage).sort(), ['{"b":2}', '{"c":3}']);
});

test('bad prefixes, keys and failing storage never throw', () => {
  const storage = memory();
  assert.deepEqual(loadOutbox('orkestr.v2.page.x', storage), []);
  assert.equal(storeOutbox('../', [['k', 'v']], storage), false);
  assert.equal(storeOutbox(prefix, [['../k', 'v']], storage), false);
  const broken = {get length() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); }};
  assert.deepEqual(loadOutbox(prefix, broken), []);
  assert.equal(storeOutbox(prefix, [['k', 'v'], ['j', null]], broken), false);
  assert.deepEqual(loadOutbox(prefix, undefined), []);
});

test('the driver wakes on timeout, reconnect, visibility and a new send', async () => {
  const target = new EventTarget();
  target.document = new EventTarget();
  target.document.visibilityState = 'hidden';
  assert.equal(await waitOutbox(10, target), 'timeout');
  let pending = waitOutbox(5000, target);
  target.dispatchEvent(new Event('online'));
  assert.equal(await pending, 'online');
  pending = waitOutbox(5000, target);
  target.dispatchEvent(new Event('orkestr-outbox'));
  assert.equal(await pending, 'kick');
  pending = waitOutbox(5000, target);
  target.document.dispatchEvent(new Event('visibilitychange'));
  target.document.visibilityState = 'visible';
  target.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await pending, 'visible');
});
