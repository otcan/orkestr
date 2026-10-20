import test from 'node:test';
import assert from 'node:assert/strict';
import {liveMapRequest, LIVE_MAP_LIMIT} from '../src/live_map_request.mjs';
test('reads the live map with a cookie-only GET', async () => {
 const seen = [];
 const result = await liveMapRequest({}, async (path, o) => {
  seen.push(path); assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'same-origin'); assert.deepEqual(o.headers, {}); assert.equal(o.redirect, 'error');
  return new Response('{"schema_version":1}');
 });
 assert.deepEqual(seen, ['/api/v2/live-map']);
 assert.deepEqual(result, {status:200, text:'{"schema_version":1}'});
});
test('not configured and session expiry pass their status through', async () => {
 for (const status of [401, 404, 503]) assert.deepEqual(await liveMapRequest({}, async () => new Response('{}', {status})), {status, text:''});
});
test('oversized bodies and network failures degrade to unknown', async () => {
 assert.deepEqual(await liveMapRequest({}, async () => new Response('x'.repeat(LIVE_MAP_LIMIT + 1))), {status:0, text:''});
 assert.deepEqual(await liveMapRequest({}, async () => { throw Error('offline'); }), {status:0, text:''});
});
test('owner cancellation aborts the read', async () => {
 const controller = new AbortController();
 await assert.rejects(liveMapRequest({signal:controller.signal}, async (_, o) => new Promise((_, reject) => {
  o.signal.addEventListener('abort', () => reject(Error('cancelled')), {once:true}); queueMicrotask(() => controller.abort());
 })), /cancelled/);
});
