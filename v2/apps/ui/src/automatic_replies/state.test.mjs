import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PermissionState,permissionLabel,connectionNotice} from './state.mjs';
const conversation='00000000-0000-4000-8000-000000000001', route='00000000-0000-4000-8000-000000000002';
const page=(enabled=false,revision=0)=>({conversation_id:conversation,observed_at_ms:1,routes:[{route_id:route,route_generation:1,permission_revision:revision,enabled}],next_after:null});
const setup=()=>{const state=new PermissionState();state.select(conversation);return state;};
test('empty page is valid, never a grant',()=>{const s=setup();assert(s.apply(s.request(),{...page(),routes:[]}));assert.throws(()=>s.prepare(route,true,'key'));assert.match(connectionNotice,/does not indicate/);assert.equal(permissionLabel(false),'Automatic replies paused');});
test('sample time cannot change same-revision permission',()=>{const s=setup();s.apply(s.request(),page());assert.throws(()=>s.apply(s.request(),{...page(true),observed_at_ms:999999}));assert.equal(s.prepare(route,true,'key').expected_permission_revision,0);});
test('reordered responses cannot overwrite newer request',()=>{const s=setup(),old=s.request(),fresh=s.request();s.apply(fresh,page(true,2));assert.equal(s.apply(old,page(false,1)),false);});
test('page application atomic on malformed cursor and later route',()=>{const s=setup();s.apply(s.request(),page());assert.throws(()=>s.apply(s.request(),{...page(true,1),next_after:conversation}));assert.equal(s.prepare(route,true,'key').expected_permission_revision,0);});
test('uncertain retry freezes exact tuple despite edited choice',()=>{const s=setup();s.apply(s.request(),page());const request=s.prepare(route,true,'first');s.finish(s.request(),false);assert.equal(s.prepare(route,false,'other'),request);assert(Object.isFrozen(request));});
test('auth/selection change clears pending and fences callbacks',()=>{const s=setup(),ticket=s.request();s.apply(ticket,page());s.prepare(route,true,'key');s.select(undefined);assert.equal(s.pending(),undefined);assert.equal(s.apply(ticket,page()),false);assert.equal(s.finish(ticket,true),false);});
test('definitive conflict requires fresh status before new decision',()=>{const s=setup();s.apply(s.request(),page());s.prepare(route,true,'key');s.finish(s.request(),true);assert.throws(()=>s.prepare(route,true,'new'));s.apply(s.request(),page(false,3));assert.equal(s.prepare(route,true,'new').expected_permission_revision,3);});
test('scope, extra fields, backward state and exclusive cursor refuse',()=>{const s=setup();s.apply(s.request(),page(true,3));assert.throws(()=>s.apply(s.request(),page(false,2)));assert.throws(()=>s.apply(s.request(),{...page(),conversation_id:route}));assert.throws(()=>s.apply(s.request(),{...page(),authority:true}));assert.throws(()=>s.apply(s.request(route),page()));});
test('cumulative identity cache refuses page257 atomically',()=>{
 const s=setup();let cursor=null;
 for(let i=0;i<8;i++){
  const routes=Array.from({length:32},(_,n)=>({route_id:'00000000-0000-4000-8000-'+(i*32+n+2).toString(16).padStart(12,'0'),route_generation:1,permission_revision:0,enabled:false}));
  s.apply(s.request(cursor),{...page(),routes,next_after:routes.at(-1).route_id});cursor=routes.at(-1).route_id;
 }
 const extra={route_id:'00000000-0000-4000-8000-000000001000',route_generation:1,permission_revision:0,enabled:false};
 assert.throws(()=>s.apply(s.request(cursor),{...page(),routes:[extra]}),/history limit/);
 assert.throws(()=>s.prepare(extra.route_id,true,'key'));assert.equal(s.prepare(route,true,'original').expected_permission_revision,0);
});
