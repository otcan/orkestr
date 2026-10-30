import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/beta_request.js',import.meta.url),'utf8');
const {betaRequest}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const conversation='00000000-0000-4000-8000-000000000001';
const read={route:'beta',method:'GET',body:null};
test('selected conversation discovery preserves exact scope without admitting work',async()=>{
 await betaRequest({...read,conversation},async(path,o)=>{assert.equal(path,`/api/v2/beta?conversation_id=${conversation}`);assert.equal(o.method,'GET');assert.equal(o.body,undefined);return new Response('{}');});
 for(const value of [conversation+'?owner=x','../other','']) await assert.rejects(betaRequest({...read,conversation:value},()=>assert.fail('fetch')));
});
test('capability and window reads use only agreed relative cookie routes without authority headers',async()=>{
 for(const input of [read,{...read,route:'window',conversation}]){
  const result=await betaRequest(input,async(path,options)=>{
   assert.equal(path,input.route==='beta'?'/api/v2/beta':`/api/v2/conversations/${conversation}/window`);
   assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.deepEqual(options.headers,{});assert.equal(options.body,undefined);
   return new Response('{"generation":18446744073709551615}');
  });assert.equal(result.text,'{"generation":18446744073709551615}');
 }
});
test('uncertain admission retry retains exact raw tuple and full u64, with cookie CSRF only',async()=>{
 const body='{"expected_generation":18446744073709551615,"request_key":"synthetic-retry"}';
 const input={route:'window',method:'POST',conversation,csrf:'synthetic-csrf',body};
 for(let attempt=0;attempt<2;attempt++){
  const r=await betaRequest(input,async(_,o)=>{assert.equal(o.body,body);assert.equal(o.headers['x-orkestr-csrf'],input.csrf);assert.equal(o.headers.Authorization,undefined);return new Response(null,{status:503});});
  assert.deepEqual(r,{status:503,text:''});
 }
});
test('invalid routes, missing CSRF, oversized body and GET writes refuse before network',async()=>{
 for(const input of [{...read,route:'worker'},{...read,method:'POST'},{...read,body:'{}'},{...read,route:'window',conversation:conversation+'?owner=x'},{route:'window',method:'POST',conversation,body:'{}'},{route:'window',method:'POST',conversation,csrf:'x',body:'x'.repeat(8193)}]) await assert.rejects(betaRequest(input,()=>assert.fail('fetch')));
});
test('409/auth/refusal preserve outcome only and never expose untrusted response text',async()=>{
 for(const status of [400,401,403,404,409,422,503])assert.deepEqual(await betaRequest(read,async()=>new Response('<unsafe>',{status})),{status,text:''});
});
test('response byte/read caps refuse floods and cancel readers',async()=>{
 for(const flood of ['bytes','empty']){
  let cancelled=false,count=0;
  const body=new ReadableStream({pull(c){count++;c.enqueue(new Uint8Array(flood==='bytes'?65537:0));},cancel(){cancelled=true;}});
  await assert.rejects(betaRequest(read,async()=>new Response(body)),/too large|budget exceeded/);assert(cancelled);assert(count<=1026);
 }
});
test('owner/logout cancellation aborts hung request rather than creating an admission result',async()=>{
 const controller=new AbortController();const pending=betaRequest({...read,signal:controller.signal},async(_,o)=>new Promise((_,reject)=>{o.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});queueMicrotask(()=>controller.abort());}));
 await assert.rejects(pending,/aborted/);
});
test('queue read uses its fixed route, GET only, and 202 queued receipts keep their body',async()=>{
 const r=await betaRequest({route:'window_queue',method:'GET',conversation,body:null},async(path,o)=>{assert.equal(path,`/api/v2/conversations/${conversation}/window/queue`);assert.equal(o.method,'GET');return new Response('{"entries":[]}');});
 assert.equal(r.text,'{"entries":[]}');
 for(const input of [{route:'window_queue',method:'POST',conversation,csrf:'x',body:'{}'},{route:'window_queue',method:'GET',conversation:'../x',body:null},{route:'window_queue',method:'GET',body:null}]) await assert.rejects(betaRequest(input,()=>assert.fail('fetch')));
 const queued=await betaRequest({route:'window',method:'POST',conversation,csrf:'c',body:'{"request_key":"q"}'},async()=>new Response('{"state":"queued"}',{status:202}));
 assert.deepEqual(queued,{status:202,text:'{"state":"queued"}'});
});
test('a window refusal of a restricted thread surfaces only its fixed code',async()=>{
 const conversation='00000000-0000-4000-8000-000000000001',post={route:'window',method:'POST',conversation,csrf:'c',body:'{"request_key":"q"}'};
 assert.deepEqual(await betaRequest(post,async()=>new Response('{"code":"restricted_conversation","message":"<unsafe>"}',{status:409})),{status:409,text:'',code:'restricted_conversation'});
 assert.deepEqual(await betaRequest(post,async()=>new Response('{"code":"window_conflict","message":"<unsafe>"}',{status:409})),{status:409,text:''});
});
test('unconfigured discovery surfaces only its fixed code',async()=>{
 const read={route:'beta',method:'GET',body:null};
 assert.deepEqual(await betaRequest(read,async()=>new Response('{"code":"beta_unconfigured","message":"<unsafe>"}',{status:404})),{status:404,text:'',code:'beta_unconfigured'});
 assert.deepEqual(await betaRequest(read,async()=>new Response('{"code":"other","message":"<unsafe>"}',{status:404})),{status:404,text:''});
 assert.deepEqual(await betaRequest(read,async()=>new Response('not json',{status:404})),{status:404,text:''});
});
