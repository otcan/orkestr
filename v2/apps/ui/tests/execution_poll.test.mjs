import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/execution_poll.js', import.meta.url), 'utf8');
const execute = new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch',code);
const path='/api/v2/conversations/00000000-0000-4000-8000-000000000003/execution';
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
    const run=execute(ch,async()=>new Response('x'.repeat(65537)));
    while(!ch.messages.length) await new Promise(resolve=>setImmediate(resolve));
    ch.stop(); await run;
    assert.equal(ch.messages[0].kind,'failure');
    assert.equal(ch.messages[0].body,undefined);
});

test('status rejects foreign and control routes before fetching',async()=>{
    for(const path of ['https://example.invalid/api/v2/conversations/id/execution','/api/v2/conversations/00000000-0000-4000-8000-000000000003/stop']) {
        await assert.rejects(execute({recv:async()=>({path})},()=>assert.fail('no fetch')),/Invalid status path/);
    }
});

test('host resources uses the exact authenticated aggregate read path',async()=>{
    let first=true, stop;
    const messages=[];
    const run=execute({recv:()=>first?(first=false,Promise.resolve({path:'/api/v2/resources'})):new Promise(resolve=>{stop=resolve;}),send:m=>messages.push(m)},async(path,options)=>{
        assert.equal(path,'/api/v2/resources'); assert.equal(options.credentials,'same-origin');
        assert.equal(options.method,'GET'); assert.equal(options.headers,undefined);
        return new Response('{"scope":"host","sample_sequence":1}');
    });
    while(!messages.length) await new Promise(resolve=>setImmediate(resolve));
    stop(); await run;
    assert.equal(messages[0].body.scope,'host');
    assert.ok(messages[0].now<=performance.now());
});
