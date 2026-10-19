import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPermissionClient} from './client.mjs';
const conversation='00000000-0000-4000-8000-000000000001',route='00000000-0000-4000-8000-000000000002';
const page={conversation_id:conversation,observed_at_ms:1,routes:[{route_id:route,route_generation:1,permission_revision:0,enabled:false}],next_after:null};
const json=value=>new Response(JSON.stringify(value));
const receipt=body=>({conversation_id:conversation,route_id:route,route_generation:1,permission_revision:1,enabled:body.enabled,request_key:body.request_key});
test('relative cookie read and CSRF-only write; receipt requires fresh read',async()=>{
 const calls=[];const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:async(url,o)=>{calls.push({url,...o});return json(o.method==='GET'?page:receipt(JSON.parse(o.body)));}});
 await c.read();await c.decide(route,true,'key');assert.match(calls[0].url,/automatic-reply-permissions\?limit=16$/);assert.equal(calls[0].credentials,'same-origin');assert.equal(calls[0].headers['x-orkestr-csrf'],undefined);assert.equal(calls[1].headers['x-orkestr-csrf'],'synthetic');assert.equal(calls[1].headers.Authorization,undefined);await assert.rejects(c.decide(route,false,'next'));c.close();
});
test('lost committed response retains original body across changed user choice',async()=>{
 const bodies=[];const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:async(_,o)=>{if(o.method==='GET')return json(page);bodies.push(o.body);if(bodies.length===1)throw new TypeError('synthetic response lost');return json(receipt(JSON.parse(o.body)));}});
 await c.read();await assert.rejects(c.decide(route,true,'first'));await c.decide(route,false,'changed');assert.equal(bodies[0],bodies[1]);assert.equal(c.pending(),undefined);c.close();
});
test('401 is refusal, not an empty page',async()=>{const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:async()=>new Response('',{status:401})});await assert.rejects(c.read(),e=>e.status===401);c.close();});
test('logout fences a delayed response even if fetch ignores abort',async()=>{let release;const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:()=>new Promise(r=>release=r)});const p=c.read();c.close();release(json(page));await assert.rejects(p,/selection changed/);});
test('oversize and empty-chunk floods are bounded and cancelled',async()=>{
 for(const flood of [false,true]){let reads=0,cancelled=false;const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:async()=>({ok:true,body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(flood?0:65537)};},cancel:async()=>{cancelled=true;},releaseLock(){}})}})});await assert.rejects(c.read(),/limit/);assert(reads<=256);assert(cancelled);c.close();}
});
test('conflict drops original tuple and requires explicit refresh',async()=>{const c=createPermissionClient({conversation,csrf:'synthetic',fetchImpl:async(_,o)=>o.method==='GET'?json(page):new Response('',{status:409})});await c.read();await assert.rejects(c.decide(route,true,'key'),e=>e.status===409);assert.equal(c.pending(),undefined);await assert.rejects(c.decide(route,true,'new'),/Refresh/);c.close();});
