import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../src/memory_request.js',import.meta.url),'utf8');
const {memoryRequest}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const input={route:'decisions',method:'POST',csrf:'synthetic',body:'{"expected_revision":9007199254740993}'};
test('exact integer body and response remain text with cookie/CSRF and no redirects',async()=>{
 const result=await memoryRequest(input,async(path,opts)=>{
  assert.equal(path,'/api/v2/memory/decisions');assert.equal(opts.body,input.body);assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'same-origin');assert.equal(opts.headers['x-orkestr-csrf'],'synthetic');assert(!opts.headers.Authorization);
  return new Response('{"revision":9007199254740993}');
 });assert.equal(result.text,'{"revision":9007199254740993}');
});
test('invalid route and missing consent header refuse before fetch',async()=>{
 let called=false;const fetcher=()=>{called=true;};
 await assert.rejects(memoryRequest({...input,route:'../settings'},fetcher));await assert.rejects(memoryRequest({...input,csrf:''},fetcher));assert(!called);
});
test('query response may exceed ordinary bound but overcap response refuses and cancels',async()=>{
 const text=' '.repeat(65537);const reply=await memoryRequest({...input,route:'query'},async()=>new Response(text));assert.equal(reply.text.length,65537);
 let cancelled=false;const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}});
 await assert.rejects(memoryRequest(input,async()=>new Response(stream)),/too large/);assert(cancelled);
});
test('empty chunk flood has finite work and cancellation',async()=>{
 let cancelled=false;const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled=true;}});
 await assert.rejects(memoryRequest(input,async()=>new Response(stream)),/read budget/);assert(cancelled);
});
test('owner cancellation propagates to owned fetch controller',async()=>{
 const controller=new AbortController();const promise=memoryRequest({...input,signal:controller.signal},async(_,opts)=>new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
 controller.abort();await assert.rejects(promise,/aborted/);
});
