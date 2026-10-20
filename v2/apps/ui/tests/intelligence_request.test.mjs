import test from 'node:test';
import assert from 'node:assert/strict';
import {intelligenceRequest} from '../src/intelligence_request.mjs';
const conversation='00000000-0000-4000-8000-000000000001';
test('capability reads use only the selected authenticated conversation',async()=>{
 const result=await intelligenceRequest({conversation},async(path,options)=>{
  assert.equal(path,`/api/v2/conversations/${conversation}/intelligence`);assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.body,undefined);return new Response('{"schema_version":1}');
 });assert.equal(result.text,'{"schema_version":1}');
});
test('invalid identity and unbounded replies refuse without retaining raw errors',async()=>{
 for(const id of ['../other','00000000-0000-0000-0000-000000000000'])await assert.rejects(intelligenceRequest({conversation:id},()=>assert.fail('network')));
 assert.deepEqual(await intelligenceRequest({conversation},async()=>new Response('untrusted error',{status:401})),{status:401,text:''});
 for(const size of [0,8193]){let cancelled=false;const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(size));},cancel(){cancelled=true;}});await assert.rejects(intelligenceRequest({conversation},async()=>new Response(body)));assert(cancelled);}
});
test('owner cancellation aborts the pending capability read',async()=>{
 const c=new AbortController();await assert.rejects(intelligenceRequest({conversation,signal:c.signal},async(_,o)=>new Promise((_,reject)=>{o.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});queueMicrotask(()=>c.abort());})),/cancelled/);
});
