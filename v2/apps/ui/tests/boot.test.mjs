// Synthetic HTTP wiring only: no DOM, Dioxus runtime or browser cookie jar.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const requestCode = await readFile(new URL('../src/request.js', import.meta.url), 'utf8');
const execute = new (Object.getPrototypeOf(async function() {}).constructor)('dioxus','fetch',requestCode);

test('synthetic same-origin HTML/module/WASM and relative session transport',async()=>{
    const wasm = Buffer.from([0,97,115,109,1,0,0,0]); // Empty valid module, not the UI binary.
    const server = createServer((request,response)=>{
        response.setHeader('X-Content-Type-Options','nosniff');
        response.setHeader('Cache-Control','no-store');
        const assets = {
            '/':['text/html','<!doctype html><script type="module" src="/app.js"></script>'],
            '/app.js':['text/javascript','export const wasmPath = "/app.wasm";'],
            '/app.wasm':['application/wasm',wasm],
            '/api/v2/browser/session':['application/json',JSON.stringify({csrf_token:'synthetic-csrf',global_conversation_id:'synthetic-scope'})],
        };
        const asset = assets[request.url];
        if (!asset) { response.writeHead(404,{'Content-Type':'application/json'}); response.end('{"code":"not_found"}'); return; }
        response.writeHead(200,{'Content-Type':asset[0]}); response.end(asset[1]);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(47139,'127.0.0.1',resolve);});
    const origin = 'http://127.0.0.1:47139';
    try {
        const index = await fetch(origin+'/');
        assert.match(await index.text(),/src="\/app.js"/);
        const module = await fetch(origin+'/app.js');
        assert.match(await module.text(),/app.wasm/);
        const binary = await fetch(origin+'/app.wasm');
        assert.equal(binary.headers.get('content-type'),'application/wasm');
        assert.equal(binary.headers.get('x-content-type-options'),'nosniff');
        await WebAssembly.instantiateStreaming(binary);
        const result = await execute({recv:async()=>({method:'GET',path:'/api/v2/browser/session',body:null,csrf:'',bootstrap:''})},(path,options)=>{
            assert.equal(options.credentials,'same-origin');
            assert.equal(options.headers.Authorization,undefined);
            const url = new URL(path,origin);
            assert.equal(url.origin,origin);
            return fetch(url,options);
        });
        assert.equal(result.body.csrf_token,'synthetic-csrf');
        const missing = await fetch(origin+'/api/v2/missing');
        assert.equal(missing.status,404);
        assert.equal(missing.headers.get('content-type'),'application/json');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
    }
});
