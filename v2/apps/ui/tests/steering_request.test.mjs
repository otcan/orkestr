import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code=await readFile(new URL('../src/steering_request.js',import.meta.url),'utf8');
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch','setTimeout','clearTimeout',code);
const input={method:'POST',path:'/api/v2/conversations/00000000-0000-4000-8000-000000000003/steer',csrf:'synthetic-csrf',body:{run_id:'00000000-0000-4000-8000-000000000005',expected_revision:10,request_key:'stop:original'}};
function bridge(value=input){let n=0,cancel;return {recv:()=>++n===1?Promise.resolve(value):new Promise(r=>cancel=r),cancel:()=>cancel?.()};}
const timers={set:()=>1,clear:()=>{}};
test('Steering uses exact cookie CSRF POST and retains request body without bearer or token URL',async()=>{
 const b=bridge();let cleared=false;
 const result=await execute(b,async(path,options)=>{
  assert.equal(path,input.path);assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
  assert.equal(options.headers['x-orkestr-csrf'],input.csrf);assert.equal(options.headers.Authorization,undefined);assert.deepEqual(JSON.parse(options.body),input.body);
  return new Response('{"outcome":"requested_unknown"}',{status:200});
 },timers.set,()=>cleared=true);
 assert.equal(result.body.outcome,'requested_unknown');assert.ok(cleared);
});
test('Steering rejects foreign paths, invalid methods and missing CSRF before fetch',async()=>{
 for(const value of [{...input,path:'https://example.invalid'+input.path},{...input,method:'GET'},{...input,path:input.path+'?token=x'},{...input,csrf:''}]) {
  await assert.rejects(execute(bridge(value),()=>assert.fail('fetch'),timers.set,timers.clear),/Steering unavailable/);
 }
});
test('Steering errors never parse raw server HTML or synthesize cancellation',async()=>{
 for(const status of [400,401,403,404,409,503]) {
  const result=await execute(bridge(),async()=>new Response('<h1>untrusted</h1>',{status}),timers.set,timers.clear);
  assert.deepEqual(result,{status,body:null});
 }
});
test('hung Steering is aborted on teardown or timeout and remains an unknown outcome',async()=>{
 for(const mode of ['drop','timeout']) {
  const b=bridge();let timeout,cleared=false;
  const result=execute(b,async(_,options)=>new Promise((_,reject)=>{
   options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
   queueMicrotask(()=>mode==='drop'?b.cancel():timeout());
  }),fn=>{timeout=fn;return 1;},()=>cleared=true);
  await assert.rejects(result,/aborted/);assert.ok(cleared);
 }
});
test('oversized or malformed Steering receipt fails closed and cancels response reader',async()=>{
 let cancelled=false;
 await assert.rejects(execute(bridge(),async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}})),timers.set,timers.clear),/exceeds limit/);
 assert.ok(cancelled);
 await assert.rejects(execute(bridge(),async()=>new Response('invalid-json'),timers.set,timers.clear),SyntaxError);
});

test('private status read is fixed same-origin GET with no request body',async()=>{
 const value={...input,method:'GET',path:input.path.replace('/steer','/steering/original:key')};
 const result=await execute(bridge(value),async(path,options)=>{
  assert.equal(path,value.path);assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.body,undefined);
  return new Response('{"state":"delivery_unknown"}');
 },timers.set,timers.clear);
 assert.equal(result.body.state,'delivery_unknown');
});
