import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/request.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const execute = new AsyncFunction('dioxus', 'fetch', code);
const base = {method:'POST',path:'/api/v2/browser/session',body:{username:'synthetic-user',password:'synthetic-password'},csrf:'',bootstrap:''};

test('local account setup uses a fixed same-origin path and preflight header without a bootstrap token', async () => {
    const path = '/api/v2/oss-setup/account';
    for (const method of ['GET', 'POST']) {
        await execute({recv:async()=>({...base,method,path,body:method==='GET'?null:base.body})},async(actual,options)=>{
            assert.equal(actual,path);
            assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers['x-orkestr-local-setup'],'1');
            assert.equal(options.headers['x-orkestr-bootstrap'],undefined);
            assert.equal(options.headers.Authorization,undefined);
            return Response.json({setup_required:true});
        });
    }
    for (const [method, rejected] of [['DELETE',path],['POST',path+'/..'],['GET',path+'?token=synthetic'],['POST','/api/v2/oss-setup/configure']]) {
        await assert.rejects(execute({recv:async()=>({...base,method,path:rejected})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('owner security APIs retain same-origin cookie and CSRF boundaries', async () => {
    for (const [method,path] of [['GET','/api/v2/browser/security'],['POST','/api/v2/browser/password'],['GET','/api/v2/browser/service-credentials'],['POST','/api/v2/browser/service-credentials'],['DELETE','/api/v2/browser/service-credentials/00000000-0000-4000-8000-000000000001']]) {
        await execute({recv:async()=>({...base,method,path,csrf:'synthetic-csrf',body:method==='POST'?{}:null})},async(actual,options)=>{
            assert.equal(actual,path);
            assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers.Authorization,undefined);
            assert.equal(options.headers['x-orkestr-csrf'],method==='GET'?undefined:'synthetic-csrf');
            return Response.json({ok:true});
        });
    }
    for (const path of ['/api/v2/machine/service-session','/api/v2/browser/security?redirect=https://example.invalid','/api/v2/browser/password/extra','/api/v2/browser/service-credentials/../password','/api/v2/browser/service-credentials/%2e%2e','//example.invalid/api/v2/browser/password']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('provider handoff and receipt keep scoped cookie paths and mutation CSRF', async () => {
    const root='/api/v2/conversations/00000000-0000-4000-8000-000000000001/provider-handoffs';
    for(const [method,path] of [['POST',root],['GET',root+'/synthetic:handoff']]) {
        await execute({recv:async()=>({...base,method,path,csrf:'synthetic-csrf',body:method==='POST'?{request_key:'synthetic:handoff'}:null})},async(actual,options)=>{
            assert.equal(actual,path);assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers['x-orkestr-csrf'],method==='POST'?'synthetic-csrf':undefined);
            assert.equal(options.headers.Authorization,undefined);return Response.json({ok:true});
        });
    }
    for(const path of [root+'/..',root+'/%2e%2e',root+'/synthetic?foreign=1'])
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
});

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
    for(const path of ['/api/v2/sidebar','/api/v2/sidebar?include_hidden=true','/api/v2/sidebar/read','/api/v2/v1-threads/worker-synthetic-1/messages','/api/v2/v1-threads/synthetic/messages?before=12','/api/v2/v1-links/thr_AAAAAAAAAAAAAAAAAAAAAQ?instance=ins_AAAAAAAAAAAAAAAAAAAAAA','/api/v2/whatsapp-chats']) {
        await execute({recv:async()=>({...base,method:'GET',path,body:null})},async(seen)=>{assert.equal(seen,path);return new Response('{}');});
    }
    for(const path of ['/api/v2/v1-threads/../messages','/api/v2/v1-threads/a/b/messages','/api/v2/v1-threads/a%2Fb/messages','/api/v2/v1-threads/a/messages?before=-1','/api/v2/sidebar?x=1','/api/v2/sidebar?include_hidden=1','/api/v2/sidebar/other','/api/v2/v1-links/thr_short?instance=ins_AAAAAAAAAAAAAAAAAAAAAA','/api/v2/v1-links/thr_AAAAAAAAAAAAAAAAAAAAAQ','/api/v2/v1-links/../x','/api/v2/whatsapp-chats/x','/api/v2/whatsapp-chats?x=1']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('message attachments and V1 uploads are allowed paths',async()=>{
    for(const path of ['/api/v2/conversations/00000000-0000-4000-8000-00000000000a/message-attachments','/api/v2/v1-threads/synthetic-group/uploads']) {
        await execute({recv:async()=>({...base,method:'POST',path,body:{},csrf:'synthetic-csrf'})},async(seen,options)=>{assert.equal(seen,path);assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');return new Response('{}');});
    }
    for(const path of ['/api/v2/v1-threads/../uploads','/api/v2/conversations/x/message-attachments','/api/v2/v1-threads/a/uploads?x=1']) {
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('conversation posts are read with one fixed page and never written from the browser bridge path list',async()=>{
    const path='/api/v2/conversations/00000000-0000-4000-8000-00000000000a/posts?limit=50';
    await execute({recv:async()=>({...base,method:'GET',path,body:null})},async(seen)=>{assert.equal(seen,path);return new Response('{}');});
    for(const bad of ['/api/v2/conversations/00000000-0000-4000-8000-00000000000a/posts','/api/v2/conversations/00000000-0000-4000-8000-00000000000a/posts?limit=51','/api/v2/conversations/00000000-0000-4000-8000-00000000000a/posts?pending=true&limit=50','/api/v2/conversations/x/posts?limit=50']) {
        await assert.rejects(execute({recv:async()=>({...base,path:bad})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});

test('GET polls revalidate with the last ETag and a 304 returns the kept body',async()=>{
    const path='/api/v2/sidebar';
    const get={...base,method:'GET',path,body:null};
    const first=await execute({recv:async()=>get},async(_,options)=>{
        assert.equal(options.headers['If-None-Match'],undefined);
        return new Response('{"entries":[1]}',{status:200,headers:{etag:'W/"synthetic-1"'}});
    });
    assert.deepEqual(first,{status:200,body:{entries:[1]}});
    const second=await execute({recv:async()=>get},async(_,options)=>{
        assert.equal(options.headers['If-None-Match'],'W/"synthetic-1"');
        assert.equal(options.cache,'no-store');
        return new Response(null,{status:304});
    });
    assert.deepEqual(second,{status:200,body:{entries:[1]}});
    // A failure forgets the kept body; writes never revalidate.
    await execute({recv:async()=>get},async()=>new Response('{"code":"x"}',{status:503}));
    await execute({recv:async()=>get},async(_,options)=>{
        assert.equal(options.headers['If-None-Match'],undefined);
        return new Response('{}');
    });
    await execute({recv:async()=>({...base,path:'/api/v2/sidebar/read',method:'PUT',body:{}})},async(_,options)=>{
        assert.equal(options.headers['If-None-Match'],undefined);
        return new Response('{}');
    });
});

test('owner desktop open uses a scoped cookie mutation and refuses unbound paths', async () => {
    const root='/api/v2/conversations/00000000-0000-4000-8000-000000000001/desktops';
    await execute({recv:async()=>({...base,method:'POST',path:root+'/example-desk/open',csrf:'synthetic-csrf',body:{}})},async(path,options)=>{
        assert.equal(path,root+'/example-desk/open');
        assert.equal(options.credentials,'same-origin');
        assert.equal(options.cache,'no-store');
        assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');
        assert.equal(options.headers.Authorization,undefined);
        return Response.json({url:'https://desktop.example.test/desktop-share/example?key=opaque',challenge_required:true});
    });
    for(const path of [root+'/../open',root+'/%2e%2e/open',root+'/example/open?redirect=1',root+'/example/share',root+'/example/open/extra'])
        await assert.rejects(execute({recv:async()=>({...base,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
});

test('global desk discovery and scoped lease actions use fixed cookie and CSRF paths',async()=>{
    const root='/api/v2/conversations/00000000-0000-4000-8000-000000000001/desktops/desk-a';
    for(const [method,path] of [['GET','/api/v2/desktops'],...['acquire','release','reset'].map(a=>['POST',root+'/'+a])]) {
        await execute({recv:async()=>({...base,method,path,csrf:'synthetic-csrf',body:method==='GET'?null:{confirm:true}})},async(actual,options)=>{
            assert.equal(actual,path);assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers['x-orkestr-csrf'],method==='POST'?'synthetic-csrf':undefined);
            assert.equal(options.headers.Authorization,undefined);return Response.json({ok:true});
        });
    }
    for(const [method,path] of [['POST','/api/v2/desktops'],['GET',root+'/reset'],['POST',root+'/cleanup'],['POST',root+'/../reset'],['GET','/api/v2/desktops?owner=other'],['POST',root+'/reset?force=true']])
        await assert.rejects(execute({recv:async()=>({...base,method,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
});

test('owner desk actions use only the fixed verbs with cookie and CSRF',async()=>{
    for(const action of ['start','stop','link']) {
        const path=`/api/v2/desktops/desk-a/${action}`;
        await execute({recv:async()=>({...base,method:'POST',path,csrf:'synthetic-csrf',body:{}})},async(actual,options)=>{
            assert.equal(actual,path);assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');
            assert.equal(options.headers.Authorization,undefined);return Response.json({ok:true});
        });
    }
    for(const [method,path] of [['GET','/api/v2/desktops/desk-a/start'],['POST','/api/v2/desktops/desk-a/restart'],['POST','/api/v2/desktops/desk-a/cleanup'],['POST','/api/v2/desktops/../start'],['POST','/api/v2/desktops/desk-a/stop?force=true'],['POST','/api/v2/desktops/desk-a/link/extra'],['POST','/api/v2/desktops/UPPER/stop']])
        await assert.rejects(execute({recv:async()=>({...base,method,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
});

test('build identity read is restricted to the exact same-origin health GET', async () => {
    await execute({recv:async()=>({...base,method:'GET',path:'/api/v2/health',body:null})}, async(path, options)=>{
        assert.equal(path,'/api/v2/health');
        assert.equal(options.credentials,'same-origin');
        assert.equal(options.cache,'no-store');
        return Response.json({status:'ok'});
    });
    for (const [method,path] of [['POST','/api/v2/health'],['GET','/api/v2/health?url=https://example.invalid'],['GET','/api/v2/health/extra']]) {
        await assert.rejects(execute({recv:async()=>({...base,method,path})},()=>assert.fail('fetch must not run')),/Invalid API path/);
    }
});
