import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code=await readFile(new URL('../src/payload_request.js',import.meta.url),'utf8');
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch','setTimeout','clearTimeout',code);
const path='/api/v2/conversations/00000000-0000-4000-8000-000000000003/payloads/00000000-0000-4000-8000-000000000004';
const bridge=input=>{let n=0;return {recv:()=>++n===1?Promise.resolve(input):new Promise(()=>{})};};
const timer=()=>1,clear=()=>{};
test('payload GET uses cookie only and tombstone remains null, DELETE sends CSRF and accepts 204',async()=>{
 for(const method of ['GET','DELETE']) {
  const result=await execute(bridge({path,method,csrf:'synthetic-csrf'}),async(url,options)=>{
   assert.equal(url,path);assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['x-orkestr-csrf'],method==='DELETE'?'synthetic-csrf':undefined);
   return method==='DELETE'?new Response(null,{status:204}):new Response('{"text":null}');
  },timer,clear);
  assert.deepEqual(result,method==='DELETE'?{status:204,body:null}:{status:200,body:{text:null}});
 }
});
test('payload routes refuse foreign/query/control paths and removal without CSRF',async()=>{
 for(const input of [{path:'https://example.invalid'+path,method:'GET'},{path:path+'?owner=x',method:'GET'},{path:path.replace('/payloads/','/stop/'),method:'GET'},{path,method:'POST'},{path,method:'DELETE'}]) await assert.rejects(execute(bridge(input),()=>assert.fail('fetch'),timer,clear),/Output unavailable/);
});
test('payload errors expose no raw HTML; bounded text decoder refuses oversize',async()=>{
 for(const status of [401,403,404,503]) assert.deepEqual(await execute(bridge({path,method:'GET'}),async()=>new Response('<h1>private error</h1>',{status}),timer,clear),{status,body:null});
 let cancelled=false;await assert.rejects(execute(bridge({path,method:'GET'}),async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}})),timer,clear),/exceeds limit/);assert.ok(cancelled);
});
