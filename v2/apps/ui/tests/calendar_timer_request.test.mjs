import {readFile} from 'node:fs/promises';import test from 'node:test';import assert from 'node:assert/strict';
const load=async(name)=>new(Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch',await readFile(new URL('../src/'+name,import.meta.url),'utf8'));
const execute=await load('calendar_timer_request.js');
const clock=await load('timer_clock.js');
const id='00000000-0000-4000-8000-000000000001';
function channel(input){let first=true,stop;return{recv:()=>first?(first=false,Promise.resolve(input)):new Promise(r=>stop=r),stop:()=>stop()};}
const ok=(extra)=>({csrf:'synthetic',body:{until_ms:1},...extra});
test('only the fixed calendar timer routes and methods are fetched',async()=>{
 for(const [method,path] of [['POST','/api/v2/timers/calendar'],['POST','/api/v2/timers/calendar/preview'],['POST',`/api/v2/timers/${id}/schedule`],['POST',`/api/v2/timers/${id}/pause`],['PUT',`/api/v2/timers/${id}/policy`],['POST',`/api/v2/conversations/${id}/timer-pause`]]){
  const result=await execute(channel(ok({method,path})),async(p,o)=>{assert.equal(p,path);assert.equal(o.method,method);assert.equal(o.credentials,'same-origin');assert.equal(o.headers['x-orkestr-csrf'],'synthetic');return new Response('{"ok":true}');});
  assert.equal(result.status,200);
 }
});
test('guessed routes, wrong methods, missing csrf and client authority never fetch',async()=>{
 for(const input of [{method:'GET',path:'/api/v2/timers/calendar'},{method:'PUT',path:'/api/v2/timers/calendar'},{method:'POST',path:`/api/v2/timers/${id}/policy`},{method:'POST',path:`/api/v2/timers/${id}/control`},{method:'POST',path:`/api/v2/timers/${id}/pause?now=1`},{method:'POST',path:'https://example.invalid/api/v2/timers/calendar'},{method:'POST',path:'/api/v2/timers/calendar',csrf:''},{method:'POST',path:'/api/v2/timers/calendar',body:{due_ms:1}},{method:'POST',path:'/api/v2/timers/calendar',body:{claim_id:'x'}},{method:'POST',path:'/api/v2/timers/calendar',body:[1]}])
  await assert.rejects(execute(channel(ok(input)),()=>assert.fail('no fetch')));
});
test('refusals keep their status and bounded message; large bodies are refused',async()=>{
 for(const status of [400,401,403,404,409,503]){const r=await execute(channel(ok({method:'POST',path:'/api/v2/timers/calendar'})),async()=>new Response(JSON.stringify({message:'m'.repeat(500)}),{status}));assert.equal(r.status,status);assert.equal(r.body,null);assert.equal(r.message.length,200);}
 const r=await execute(channel(ok({method:'POST',path:'/api/v2/timers/calendar'})),async()=>new Response('private',{status:409}));assert.equal(r.message,null);
 await assert.rejects(execute(channel(ok({method:'POST',path:'/api/v2/timers/calendar'})),async()=>new Response('x'.repeat(65537))),/exceeds limit/);
});
test('unmount aborts an in-flight request',async()=>{const ch=channel(ok({method:'POST',path:'/api/v2/timers/calendar'}));let signal;const run=execute(ch,async(_,o)=>{signal=o.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));});while(!signal)await new Promise(r=>setImmediate(r));ch.stop();await assert.rejects(run,/aborted/);});
test('clock helper parses local datetimes and offers bounded presets',async()=>{
 assert.ok(Math.abs(await clock(channel({op:'now'}))-Date.now())<2000);
 assert.equal(await clock(channel({op:'parse',value:'2026-10-22T09:00'})),new Date('2026-10-22T09:00').getTime());
 assert.equal(await clock(channel({op:'parse',value:'garbage'})),null);
 const hour=await clock(channel({op:'preset',value:'hour'}));assert.ok(hour>Date.now()+3590000&&hour<Date.now()+3610000);
 const tomorrow=new Date(await clock(channel({op:'preset',value:'tomorrow'})));assert.equal(tomorrow.getHours(),9);assert.ok(tomorrow>new Date());
 assert.equal(await clock(channel({op:'preset',value:'forever'})),4102444800000);
 assert.equal(await clock(channel({op:'preset',value:'bogus'})),null);
});
