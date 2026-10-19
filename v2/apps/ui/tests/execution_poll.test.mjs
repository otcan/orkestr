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


test('exact-run status permits only the registered single UUID query and owner cookie read',async()=>{
    const exact=path+'?run_id=00000000-0000-4000-8000-000000000005';
    let first=true,cancel;
    const messages=[];
    const run=execute({recv:()=>first?(first=false,Promise.resolve({path:exact})):new Promise(resolve=>{cancel=resolve;}),send:m=>messages.push(m)},async(url,options)=>{
        assert.equal(url,exact);assert.equal(options.credentials,'same-origin');assert.equal(options.headers,undefined);
        return new Response(null,{status:404});
    });
    while(!messages.length)await new Promise(resolve=>setImmediate(resolve));
    cancel();await run;assert.equal(messages[0].status,404);
    for(const query of ['?run_id=invalid','?run_id=00000000-0000-4000-8000-000000000005&owner=other','?run_id=00000000-0000-4000-8000-000000000005&run_id=00000000-0000-4000-8000-000000000006']) {
        await assert.rejects(execute({recv:async()=>({path:path+query})},()=>assert.fail('no fetch')),/Invalid status path/);
    }
});

test('Worker discovery uses bounded canonical keyset read without authority headers',async()=>{
    const base=path.replace('/execution','/workers');
    for(const query of ['?limit=25','?after=00000000-0000-4000-8000-000000000010&limit=25']) {
        const target=base+query;let first=true,cancel;const messages=[];
        const run=execute({recv:()=>first?(first=false,Promise.resolve({path:target})):new Promise(resolve=>{cancel=resolve;}),send:m=>messages.push(m)},async(url,options)=>{
            assert.equal(url,target);assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers,undefined);assert.equal(options.method,'GET');
            return new Response('{"workers":[],"next_after":null}');
        });
        while(!messages.length) await new Promise(resolve=>setImmediate(resolve));
        cancel();await run;assert.deepEqual(messages[0].body.workers,[]);
    }
    for(const query of ['', '?limit=101','?after=invalid&limit=25','?limit=25&owner=other','?after=00000000-0000-4000-8000-000000000010&limit=25&limit=25']) {
        await assert.rejects(execute({recv:async()=>({path:base+query})},()=>assert.fail('no fetch')),/Invalid status path/);
    }
});

test('held input uses canonical exclusive inbox cursor and never sends mutation authority',async()=>{
    const base=path.replace('/execution','/held-inputs');
    for(const cursor of ['0','8','9223372036854775807']) {
        const target=base+'?after_sequence='+cursor+'&limit=50';let first=true,cancel;const messages=[];
        const run=execute({recv:()=>first?(first=false,Promise.resolve({path:target})):new Promise(resolve=>{cancel=resolve;}),send:m=>messages.push(m)},async(url,options)=>{
            assert.equal(url,target);assert.equal(options.credentials,'same-origin');assert.equal(options.method,'GET');assert.equal(options.headers,undefined);
            return new Response('{"held":[],"eligible_input_available":false}');
        });
        while(!messages.length) await new Promise(resolve=>setImmediate(resolve));cancel();await run;assert.deepEqual(messages[0].body.held,[]);
    }
    for(const query of ['?after_sequence=-1&limit=50','?after_sequence=0&limit=101','?after_sequence=0&limit=50&resume=true','?after_sequence=0&after_sequence=1&limit=50']) {
        await assert.rejects(execute({recv:async()=>({path:base+query})},()=>assert.fail('no fetch')),/Invalid status path/);
    }
});

test('worker task history accepts only canonical exact-parent query and cookie read', async()=>{
    const base='/api/v2/conversations/00000000-0000-4000-8000-000000000001/worker-tasks';
    const parent='00000000-0000-4000-8000-000000000002';
    for (const path of [base,`${base}?parent_run_id=${parent}&limit=32`,`${base}?parent_run_id=${parent}&parent_run_id=${parent}`]) {
        await assert.rejects(execute({recv:async()=>({path})},()=>assert.fail('no fetch')),/Invalid status path/);
    }
    let first=true,stop; const messages=[]; let signal;
    const path=`${base}?parent_run_id=${parent}`;
    const run=execute({recv:()=>first?(first=false,Promise.resolve({path})):new Promise(resolve=>{stop=resolve;}),send:m=>messages.push(m)},async(url,options)=>{
        assert.equal(url,path);assert.equal(options.credentials,'same-origin');assert.equal(options.headers,undefined);
        signal=options.signal;return new Response(JSON.stringify({schema_version:1,can_create:false,tasks:[]}));
    });
    while(!messages.length)await new Promise(resolve=>setImmediate(resolve));
    stop();await run;assert.equal(messages[0].body.can_create,false);assert.ok(signal.aborted);
});

test('timer GET is exact and refuses query or guessed discovery',async()=>{const timer='/api/v2/timers/00000000-0000-4000-8000-000000000001';for(const path of [timer+'?now=1','/api/v2/timers',timer+'/tick'])await assert.rejects(execute({recv:async()=>({path})},()=>assert.fail('no fetch')));let first=true,stop;const messages=[];const ch={recv:()=>first?(first=false,Promise.resolve({path:timer})):new Promise(r=>stop=r),send:m=>messages.push(m)};const run=execute(ch,async(url,o)=>{assert.equal(url,timer);assert.equal(o.credentials,'same-origin');return new Response('{"state":"paused"}');});while(!messages.length)await new Promise(r=>setImmediate(r));stop();await run;assert.equal(messages[0].body.state,'paused');});

test('Fast status uses its own cookie route, including exact-run lookup and absence',async()=>{
    for (const suffix of ['', '?run_id=00000000-0000-4000-8000-000000000004']) {
        const fast=path.replace('/execution','/fast/execution')+suffix;
        let first=true, stop; const messages=[];
        const run=execute({recv:()=>first?(first=false,Promise.resolve({path:fast})):new Promise(resolve=>{stop=resolve;}),send:m=>messages.push(m)},async(url,options)=>{
            assert.equal(url,fast); assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers,undefined); return new Response(null,{status:204});
        });
        while(!messages.length) await new Promise(resolve=>setImmediate(resolve));
        stop(); await run; assert.equal(messages[0].status,204);
    }
});
