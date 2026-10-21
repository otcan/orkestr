import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/request.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const execute = new AsyncFunction('dioxus', 'fetch', code);
const base = {method:'POST',path:'/api/v2/browser/session',body:{username:'synthetic-user',password:'synthetic-password'},csrf:'',bootstrap:''};

test('login credentials use JSON and same-origin cookies without caching', async () => {
    const input = {...base,bootstrap:'synthetic-bootstrap'};
    const result = await execute({recv:async()=>input},async(path, options)=>{
        assert.equal(path,'/api/v2/browser/session');
        assert.equal(options.credentials,'same-origin');
        assert.equal(options.cache,'no-store');
        assert.equal(options.headers['x-orkestr-bootstrap'],'synthetic-bootstrap');
        assert.equal(options.headers.Authorization,undefined);
        assert.deepEqual(JSON.parse(options.body),input.body);
        assert.ok(options.signal instanceof AbortSignal);
        return new Response('{"csrf_token":"synthetic-csrf","global_conversation_id":"synthetic-scope"}',{status:200});
    });
    assert.equal(result.body.csrf_token,'synthetic-csrf');
    assert.equal(result.body.token,undefined);
});

test('authenticated GET uses cookies without CSRF or Authorization headers',async()=>{
    await execute({recv:async()=>({...base,method:'GET',path:'/api/v2/projects',body:null,csrf:'synthetic-csrf'})},async(path,options)=>{
        assert.equal(path.includes('synthetic-session'),false);
        assert.equal(options.headers.Authorization,undefined);
        assert.equal(options.headers['x-orkestr-csrf'],undefined);
        assert.equal(options.body,undefined);
        assert.equal(options.headers['x-orkestr-bootstrap'],undefined);
        return new Response('{"projects":[],"next_cursor":null}');
    });
});

test('non-API URLs fail before fetch',async()=>{
    for(const path of ['https://example.invalid/api/v2/browser/session','//example.invalid/api/v2/browser/session','/api/v1/session','/api/v2/../../session','/api/v2/%2e%2e/session','/api/v2/browser/session#token','/api/v2/unknown','/api/v2/projects?token=synthetic']) {
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


test('canonical snapshot pagination remains a relative API request',async()=>{
    const path = '/api/v2/conversations/00000000-0000-4000-8000-000000000003?after=7&limit=100';
    const result = await execute({recv:async()=>({...base,method:'GET',path,body:null})},async(actual)=>{
        assert.equal(actual,path);
        return new Response('{"messages":[]}');
    });
    assert.deepEqual(result.body,{messages:[]});
});


test('cookie writes carry CSRF header without Authorization or token URLs',async()=>{
    await execute({recv:async()=>({...base,path:'/api/v2/projects',csrf:'synthetic-csrf'})},async(path,options)=>{
        assert.equal(path,'/api/v2/projects');
        assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');
        assert.equal(options.headers.Authorization,undefined);
        assert.equal(options.credentials,'same-origin');
        return new Response('{}');
    });
});

test('session resume and logout handle HttpOnly cookie authority and empty 204',async()=>{
    await execute({recv:async()=>({...base,method:'GET',body:null})},async(path,options)=>{
        assert.equal(path,'/api/v2/browser/session');
        assert.equal(options.headers['x-orkestr-csrf'],undefined);
        assert.equal(options.credentials,'same-origin');
        return new Response('{"csrf_token":"synthetic-csrf","global_conversation_id":"synthetic-scope"}');
    });
    const result = await execute({recv:async()=>({...base,method:'DELETE',body:null,csrf:'synthetic-csrf'})},async(path,options)=>{
        assert.equal(path,'/api/v2/browser/session');
        assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');
        assert.equal(options.headers.Authorization,undefined);
        return new Response(null,{status:204});
    });
    assert.deepEqual(result,{status:204,body:null});
});

test('browser bridge rejects both machine login routes before fetch',async()=>{
    for (const path of ['/api/v2/session','/api/v2/machine/session']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('machine login must not run')),/Invalid API path/);
    }
});

test('legacy bearer input cannot add Authorization or forge browser-managed headers',async()=>{
    await execute({recv:async()=>({...base,token:'synthetic-legacy-token',headers:{Authorization:'Bearer synthetic',Origin:'https://example.invalid',Cookie:'synthetic'}})},async(_,options)=>{
        for (const header of ['Authorization','Origin','Host','Cookie']) assert.equal(options.headers[header],undefined);
        assert.equal(options.credentials,'same-origin');
        return new Response('{}');
    });
});

test('rejected or uncertain logout cannot become a successful bridge result',async()=>{
    const input = {...base,method:'DELETE',body:null,csrf:'synthetic-stale-csrf'};
    const result = await execute({recv:async()=>input},async()=>new Response('{"code":"csrf_rejected","message":"Rejected"}',{status:403}));
    assert.equal(result.status,403);
    assert.equal(result.body.code,'csrf_rejected');
    await assert.rejects(execute({recv:async()=>input},async()=>{throw new Error('synthetic connection lost');}),/connection lost/);
});

test('sidebar, read marks and linked V1 history are the only new paths',async()=>{
    for(const path of ['/api/v2/sidebar','/api/v2/sidebar/read','/api/v2/v1-threads/worker-synthetic-1/messages','/api/v2/v1-threads/synthetic/messages?before=12','/api/v2/v1-links/thr_AAAAAAAAAAAAAAAAAAAAAQ?instance=ins_AAAAAAAAAAAAAAAAAAAAAA','/api/v2/whatsapp-chats']) {
        await execute({recv:async()=>({...base,method:'GET',path,body:null})},async(seen)=>{assert.equal(seen,path);return new Response('{}');});
    }
    for(const path of ['/api/v2/v1-threads/../messages','/api/v2/v1-threads/a/b/messages','/api/v2/v1-threads/a%2Fb/messages','/api/v2/v1-threads/a/messages?before=-1','/api/v2/sidebar?x=1','/api/v2/sidebar/other','/api/v2/v1-links/thr_short?instance=ins_AAAAAAAAAAAAAAAAAAAAAA','/api/v2/v1-links/thr_AAAAAAAAAAAAAAAAAAAAAQ','/api/v2/v1-links/../x','/api/v2/whatsapp-chats/x','/api/v2/whatsapp-chats?x=1']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});
