import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/request.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const execute = new AsyncFunction('dioxus', 'fetch', code);
const base = {method:'POST',path:'/api/v2/session',body:{username:'synthetic-user',password:'synthetic-password'},token:'',bootstrap:''};

test('credentials travel only in JSON, without browser cookies or caching', async () => {
    const input = {...base,bootstrap:'synthetic-bootstrap'};
    const result = await execute({recv:async()=>input},async(path, options)=>{
        assert.equal(path,'/api/v2/session');
        assert.equal(options.credentials,'omit');
        assert.equal(options.cache,'no-store');
        assert.equal(options.headers['x-orkestr-bootstrap'],'synthetic-bootstrap');
        assert.equal(options.headers.Authorization,undefined);
        assert.deepEqual(JSON.parse(options.body),input.body);
        assert.ok(options.signal instanceof AbortSignal);
        return new Response('{"token":"synthetic-session"}',{status:200});
    });
    assert.equal(result.body.token,'synthetic-session');
});

test('authenticated GET uses bearer header and omits JSON body',async()=>{
    await execute({recv:async()=>({...base,method:'GET',path:'/api/v2/projects',body:null,token:'synthetic-session'})},async(path,options)=>{
        assert.equal(path.includes('synthetic-session'),false);
        assert.equal(options.headers.Authorization,'Bearer synthetic-session');
        assert.equal(options.body,undefined);
        assert.equal(options.headers['x-orkestr-bootstrap'],undefined);
        return new Response('{"projects":[],"next_cursor":null}');
    });
});

test('non-API URLs fail before fetch',async()=>{
    for(const path of ['https://example.invalid/api/v2/session','//example.invalid/api/v2/session','/api/v1/session']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('HTTP expiry survives malformed body without reflecting server markup',async()=>{
    const result = await execute({recv:async()=>base},async()=>new Response('<html>synthetic-error</html>',{status:401}));
    assert.deepEqual(result,{status:401,body:{code:'invalid_response',message:'Unexpected server response'}});
});

test('oversized response cancels reader before accumulating the entire body',async()=>{
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8*1024*1024+1)); },
        cancel() { cancelled = true; }
    }));
    await assert.rejects(execute({recv:async()=>base},async()=>response),/Response exceeds client limit/);
    assert.equal(cancelled,true);
});

test('JSON split across UTF-8 chunks decodes correctly',async()=>{
    const bytes = new TextEncoder().encode('{"text":"日本語"}');
    const response = new Response(new ReadableStream({
        start(controller) { for(const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); }
    }));
    assert.deepEqual((await execute({recv:async()=>base},async()=>response)).body,{text:'日本語'});
});
