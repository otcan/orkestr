import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationStatusRequest} from '../src/conversation_status_request.mjs';
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
test('reads execution then queue per conversation with cookie-only GETs', async () => {
 const seen = [];
 const result = await conversationStatusRequest({conversations:[a, b]}, async (path, o) => {
  seen.push(path); assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'same-origin'); assert.deepEqual(o.headers, {}); assert.equal(o.redirect, 'error');
  return path.endsWith('/execution') && path.includes(a) ? new Response('{"phase":"running"}') : new Response(null, {status:204});
 });
 assert.deepEqual(seen, [`/api/v2/conversations/${a}/execution`, `/api/v2/conversations/${a}/window/queue`, `/api/v2/conversations/${b}/execution`, `/api/v2/conversations/${b}/window/queue`]);
 assert.deepEqual(result[0], {id:a, execution:{status:200, text:'{"phase":"running"}'}, queue:{status:204, text:''}});
});
test('one failing read degrades to unknown instead of failing the list', async () => {
 const result = await conversationStatusRequest({conversations:[a]}, async path => { if (path.endsWith('/execution')) throw Error('offline'); return new Response('x'.repeat(70000)); });
 assert.deepEqual(result, [{id:a, execution:{status:0, text:''}, queue:{status:0, text:''}}]);
});
test('invalid lists refuse before network', async () => {
 for (const conversations of [null, [a, a], ['../x'], ['AAAAAAAA-0000-4000-8000-000000000001'], Array.from({length:51}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)])
  await assert.rejects(conversationStatusRequest({conversations}, () => assert.fail('network')));
});
test('owner cancellation aborts the round', async () => {
 const controller = new AbortController();
 await assert.rejects(conversationStatusRequest({conversations:[a], signal:controller.signal}, async (_, o) => new Promise((_, reject) => {
  o.signal.addEventListener('abort', () => reject(Error('cancelled')), {once:true}); queueMicrotask(() => controller.abort());
 })), /cancelled/);
});
