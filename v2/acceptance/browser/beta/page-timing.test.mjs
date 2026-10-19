import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {nearestRankP95, sampleProtectedReadiness} from './page-timing.mjs';

const origin = 'https://example.invalid';
const conversation = '00000000-0000-4000-8000-000000000001';
const beta = {schema_version: 1, conversation_id: conversation, provider: 'codex', role: 'deep',
  controls: {stop: true, steer: true, accept: true}, window: null,
  limits: {duration_ms: 900000, attempts: 32, bytes: 67108864,
    cleanup_ms: 30000, cleanup_attempts: 4, cleanup_bytes: 1048576}};

function fixture(options = {}) {
  const controller = new AbortController(), cache = [], navigations = [], reads = [];
  const page = {
    url: () => origin,
    async setCacheEnabled(enabled) { cache.push(enabled); },
    async reload(config) {
      navigations.push({cache: cache.at(-1), config});
      if (options.abortOnReload) controller.abort();
      if (options.refuseReload) throw Error('synthetic_navigation_refusal');
      return {url: () => options.foreign ? 'https://foreign.invalid' : origin};
    },
    async waitForSelector(selector, config) {
      assert.equal(selector, '#composer'); assert.equal(config.visible, true);
    },
    async evaluate(fn, ...args) {
      return vm.runInNewContext(`(${fn.toString()})(...args)`, {
        args, location: {origin}, requestAnimationFrame: callback => callback(),
        AbortSignal, TextDecoder, Uint8Array,
        fetch: async (path, config) => {
          assert.equal(config.credentials, 'same-origin'); assert.equal(config.redirect, 'error');
          reads.push(path);
          assert(['/api/v2/browser/session', '/api/v2/beta'].includes(path));
          return new Response(JSON.stringify(path.endsWith('/session') ?
            {global_conversation_id: conversation} : beta), {status: 200});
        },
      });
    },
  };
  return {page, controller, cache, navigations, reads,
    input: {page, conversation, origin, signal: controller.signal, verifyLease: async () => true}};
}

test('nearest-rank p95 is explicit, finite and does not mutate sample order', () => {
  const values = [10, 2, 8, 1, 7, 3, 9, 4, 6, 5];
  assert.equal(nearestRankP95(values), 10);
  assert.deepEqual(values, [10, 2, 8, 1, 7, 3, 9, 4, 6, 5]);
  assert.equal(nearestRankP95(Array.from({length: 20}, (_, i) => i + 1)), 19);
  for (const bad of [[], [NaN], [Infinity], [-1], Array(21).fill(1)]) {
    assert.throws(() => nearestRankP95(bad));
  }
});

test('exactly one cache-disabled and ten normal authenticated reloads stay separate', async () => {
  const item = fixture();
  const report = await sampleProtectedReadiness(item.input);
  assert.deepEqual(item.cache, [false, true]);
  assert.equal(item.navigations.length, 11);
  assert.deepEqual(item.navigations.map(value => value.cache), [false, ...Array(10).fill(true)]);
  assert(item.navigations.every(value => value.config.waitUntil === 'domcontentloaded'));
  assert.equal(item.reads.length, 22);
  assert.equal(report.navigations, 11); assert.equal(report.provider_execution, false);
  assert.equal(report.cache_disabled.n, 1); assert.equal(report.cache_disabled.p95_ms, undefined);
  assert.equal(report.cache_disabled.new_connection_claimed, false);
  assert.equal(report.warm.n, 10);
  assert.equal(report.warm.p95_ms, nearestRankP95(report.warm.samples_ms));
});

test('navigation failure or abort restores page cache and cannot begin another sample', async () => {
  for (const options of [{abortOnReload: true}, {refuseReload: true}, {foreign: true}]) {
    const item = fixture(options);
    await assert.rejects(sampleProtectedReadiness(item.input));
    assert.equal(item.navigations.length, 1); assert.deepEqual(item.cache, [false, true]);
  }
});

test('lease revocation after cache toggle refuses before actual navigation', async () => {
  const item = fixture(); let checks = 0;
  await assert.rejects(sampleProtectedReadiness({...item.input, verifyLease: async () => ++checks === 1}),
    {code: 'revoked'});
  assert.equal(item.navigations.length, 0); assert.deepEqual(item.cache, [false, true]);
});

test('an already aborted phase cannot change cache or navigate', async () => {
  const item = fixture(); item.controller.abort();
  await assert.rejects(sampleProtectedReadiness(item.input));
  assert.deepEqual(item.cache, []); assert.deepEqual(item.navigations, []);
});
