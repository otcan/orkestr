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
 assert.deepEqual(seen, [`/api/v2/conversation-status?ids=${a},${b}`, `/api/v2/conversations/${a}/execution`, `/api/v2/conversations/${a}/window/queue`, `/api/v2/conversations/${b}/execution`, `/api/v2/conversations/${b}/window/queue`]);
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
test('one batch request answers the whole list when the server has it', async () => {
 const seen = [];
 const result = await conversationStatusRequest({conversations:[a, b]}, async (path, o) => {
  seen.push(path); assert.equal(o.method, 'GET'); assert.deepEqual(o.headers, {});
  return new Response(JSON.stringify({rows:[
   {id:a, execution:{status:200, body:{phase:'running'}}, queue:{status:404, body:{code:'beta_unconfigured'}}},
   {id:b, execution:{status:204, body:null}, queue:{status:200, body:{active:1}}},
  ]}));
 });
 assert.deepEqual(seen, [`/api/v2/conversation-status?ids=${a},${b}`]);
 assert.deepEqual(result, [
  {id:a, execution:{status:200, text:'{"phase":"running"}'}, queue:{status:404, text:''}},
  {id:b, execution:{status:204, text:''}, queue:{status:200, text:'{"active":1}'}},
 ]);
});
test('a batch for other conversations is ignored; expiry ends the round at once', async () => {
 let reads = 0;
 const mismatched = await conversationStatusRequest({conversations:[a]}, async path => {
  reads++;
  return path.startsWith('/api/v2/conversation-status') ? new Response(JSON.stringify({rows:[{id:b, execution:{status:200, body:{}}, queue:{status:200, body:{}}}]})) : new Response(null, {status:204});
 });
 assert.equal(reads, 3);
 assert.deepEqual(mismatched, [{id:a, execution:{status:204, text:''}, queue:{status:204, text:''}}]);
 const expired = await conversationStatusRequest({conversations:[a]}, async () => new Response('{}', {status:401}));
 assert.deepEqual(expired, [{id:a, execution:{status:401, text:''}, queue:{status:401, text:''}}]);
});
