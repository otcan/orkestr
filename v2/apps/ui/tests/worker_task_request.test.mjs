import {readFile} from 'node:fs/promises';import test from 'node:test';import assert from 'node:assert/strict';
const code=await readFile(new URL('../src/worker_task_request.js',import.meta.url),'utf8');
const execute=new(Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch',code);
const base='/api/v2/conversations/00000000-0000-4000-8000-000000000001/worker-tasks';
const task='00000000-0000-4000-8000-000000000003';
function channel(input){let first=true,stop;return{recv:()=>first?(first=false,Promise.resolve(input)):new Promise(r=>{stop=r;}),stop:()=>stop()};}
test('task create and owner hold/removal use only cookie+CSRF without manual Origin',async()=>{
 for(const [method,path,body,status] of [['POST',base,{instructions:'Independent instructions'},200],['POST',base+'/'+task+'/hold',{},204],['DELETE',base+'/'+task+'/payload',{},204]]){
 const input={method,path,body,csrf:'synthetic-csrf'};let signal;
 const result=await execute(channel(input),async(url,options)=>{assert.equal(url,path);assert.equal(options.credentials,'same-origin');assert.equal(options.method,method);assert.equal(options.headers['x-orkestr-csrf'],input.csrf);assert.equal(options.headers.Origin,undefined);assert.equal(options.headers.Authorization,undefined);signal=options.signal;assert.equal(options.body,method==='DELETE'?undefined:JSON.stringify(body));return status===200?new Response('{"schema_version":1}',{status}):new Response(null,{status});});
 assert.equal(result.status,status);assert.ok(signal.aborted);
 }
});
test('task request rejects foreign paths, guessed controls, missing CSRF and nonempty hold',async()=>{
 for(const input of [{method:'POST',path:'https://example.invalid'+base,csrf:'x'},{method:'POST',path:base+'/'+task+'/resume',csrf:'x'},{method:'DELETE',path:base,csrf:'x'},{method:'POST',path:base,csrf:''},{method:'POST',path:base+'/'+task+'/hold',csrf:'x',body:{parent_run_id:task}}]){
 await assert.rejects(execute(channel(input),()=>assert.fail('no fetch')));
 }
});
test('task status refusals are preserved and oversized receipts fail closed',async()=>{
 for(const status of [401,403,409,503]){const result=await execute(channel({method:'POST',path:base,csrf:'x',body:{}}),async()=>new Response('private error',{status}));assert.deepEqual(result,{status,body:null});}
 await assert.rejects(execute(channel({method:'POST',path:base,csrf:'x',body:{}}),async()=>new Response('x'.repeat(65537))),/exceeds limit/);
});
test('disposed task request aborts pending network work',async()=>{
 const ch=channel({method:'POST',path:base,csrf:'x',body:{}});let signal;
 const run=execute(ch,async(_,options)=>{signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));});
 while(!signal)await new Promise(r=>setImmediate(r));ch.stop();await assert.rejects(run,/aborted/);assert.ok(signal.aborted);
});
