import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/payload_poll.js', import.meta.url), 'utf8');
const execute = new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch',code);
const path='/api/v2/conversations/00000000-0000-4000-8000-000000000003/payloads/00000000-0000-4000-8000-000000000004';
function channel() {
    let cancel, first=true;
    const messages=[];
    return {messages, stop:()=>cancel(), recv:()=>first?(first=false,Promise.resolve({path})):new Promise(resolve=>{cancel=resolve;}), send:m=>messages.push(m)};
}
test('status cookie GET distinguishes 200/204 and uses monotonic receipt; cancellation cleans up',async()=>{
    for (const status of [200,204,401]) {
        const ch=channel(); let signal;
        const run=execute(ch,async(url,options)=>{
            assert.equal(url,path); assert.equal(options.method,'GET');
            assert.equal(options.credentials,'same-origin'); assert.equal(options.cache,'no-store');
            assert.equal(options.headers,undefined); signal=options.signal;
            return status===200?new Response('{"schema_version":1}',{status}):new Response(null,{status});
        });
        while(!ch.messages.length) await new Promise(resolve=>setImmediate(resolve));
        ch.stop(); await run;
        assert.equal(ch.messages[0].status,status);
        assert.equal(ch.messages[0].kind,'response');
        assert.ok(ch.messages[0].now<=performance.now());
        assert.deepEqual(ch.messages[0].body,status===200?{schema_version:1}:null);
        assert.ok(signal.aborted);
    }
});
test('drop aborts hung fetch and suppresses late response',async()=>{
    const ch=channel(); let signal, release;
    const run=execute(ch,async(_,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});});
    while(!signal) await new Promise(resolve=>setImmediate(resolve));
    ch.stop(); await new Promise(resolve=>setImmediate(resolve));
    assert.ok(signal.aborted);
    release(new Response('{"schema_version":1}')); await run;
    assert.deepEqual(ch.messages,[]);
});
test('status response bound fails closed without exposing body',async()=>{
    const ch=channel();
    const run=execute(ch,async()=>new Response('x'.repeat(1048577)));
    while(!ch.messages.length) await new Promise(resolve=>setImmediate(resolve));
    ch.stop(); await run;
    assert.equal(ch.messages[0].kind,'failure');
    assert.equal(ch.messages[0].body,undefined);
});

test('status rejects foreign and control routes before fetching',async()=>{
    for(const path of ['https://example.invalid/api/v2/conversations/id/execution','/api/v2/conversations/00000000-0000-4000-8000-000000000003/stop']) {
        await assert.rejects(execute({recv:async()=>({path})},()=>assert.fail('no fetch')),/Invalid output path/);
    }
});

test('unchanged payload path is revalidated after bounded delay and delivers tombstone',async()=>{
 const runPoll=new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch','setTimeout','clearTimeout',code);
 const ch=channel();let reads=0;const delays=[];
 await runPoll(ch,async()=>{
  reads++;
  if(reads===2) setImmediate(()=>ch.stop());
  return new Response(JSON.stringify({text:reads===1?'synthetic output':null}));
 },(callback,ms)=>{delays.push(ms);return ms===5000?setTimeout(callback,0):null;},handle=>clearTimeout(handle));
 assert.equal(reads,2);
 assert.ok(delays.includes(5000));
 assert.deepEqual(ch.messages.filter(m=>m.kind==='response').map(m=>m.body.text),['synthetic output',null]);
});
