import test from 'node:test';
import assert from 'node:assert/strict';
import {archivedHistoryRequest} from '../src/archived_history_request.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const read = {conversation:id, after:'9007199254740993', limit:50};
test('archive reads are cookie-only GETs with an exact decimal cursor', async () => {
 const result = await archivedHistoryRequest(read, async (path, o) => {
  assert.equal(path, `/api/v2/conversations/${id}/archived-history?after=9007199254740993&limit=50`);
  assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'same-origin'); assert.equal(o.redirect, 'error');
  assert.equal(o.cache, 'no-store'); assert.deepEqual(o.headers, {}); assert.equal(o.body, undefined);
  return new Response('{"next_after":9007199254740994}');
 });
 assert.deepEqual(result, {status:200, text:'{"next_after":9007199254740994}'});
});
test('non-200 replies do not expose bodies', async () => {
 assert.deepEqual(await archivedHistoryRequest(read, async () => new Response('secret detail', {status:503})), {status:503, text:''});
});
test('oversized pages are reported for a smaller retry, never truncated', async () => {
 let cancelled = false;
 const body = new ReadableStream({pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; }});
 assert.deepEqual(await archivedHistoryRequest(read, async () => new Response(body)), {status:413, text:''});
 assert.ok(cancelled);
});
test('unsafe inputs refuse before network', async () => {
 for (const input of [{...read, conversation:'../x'}, {...read, after:'1&limit=100'}, {...read, after:'-1'}, {...read, after:'01'},
  {...read, after:'9223372036854775808'}, {...read, after:1}, {...read, limit:0}, {...read, limit:101}, {...read, limit:'50'}])
  await assert.rejects(archivedHistoryRequest(input, () => assert.fail('network')));
});
test('invalid UTF-8 fails and caller cancellation aborts', async () => {
 await assert.rejects(archivedHistoryRequest(read, async () => new Response(new Uint8Array([255]))));
 const controller = new AbortController();
 await assert.rejects(archivedHistoryRequest({...read, signal:controller.signal}, async (_, o) => new Promise((_, reject) => {
  o.signal.addEventListener('abort', () => reject(Error('cancelled')), {once:true}); queueMicrotask(() => controller.abort());
 })), /cancelled/);
});
