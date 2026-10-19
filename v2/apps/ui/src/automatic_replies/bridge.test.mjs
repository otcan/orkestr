import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const conversation='00000000-0000-4000-8000-000000000001',route='00000000-0000-4000-8000-000000000002';
const page={conversation_id:conversation,observed_at_ms:1,routes:[{route_id:route,route_generation:1,permission_revision:0,enabled:false}],next_after:null};
const source=(await Promise.all(['state.mjs','client.mjs','bridge.js'].map(p=>fs.readFile(new URL(p,import.meta.url),'utf8')))).join('\n').replace("import {PermissionState} from './state.mjs';",'').replaceAll('export ','');
async function harness(fetchImpl){
 let receiver;const queued=[{conversation,csrf:'synthetic',fetchImpl}],results=[],waiters=[];
 const dioxus={recv:()=>queued.length?Promise.resolve(queued.shift()):new Promise(r=>receiver=r),send:async v=>{results.push(v);waiters.shift()?.();}};
 const done=new (Object.getPrototypeOf(async function(){}).constructor)('dioxus','fetch',source)(dioxus,fetchImpl);
 return{send:action=>{if(receiver){const r=receiver;receiver=null;r(action);}else queued.push(action);},next:async()=>{if(!results.length)await new Promise(r=>waiters.push(r));return results.shift();},done};
}
test('bridge refreshes current policy after historical receipt',async()=>{
 let reads=0;const h=await harness(async(_,o)=>o.method==='GET'?new Response(JSON.stringify({...page,routes:[{...page.routes[0],enabled:++reads>1,permission_revision:reads>1?1:0}]})):new Response(JSON.stringify({conversation_id:conversation,route_id:route,route_generation:1,permission_revision:1,enabled:true,request_key:JSON.parse(o.body).request_key})));
 await h.next();h.send({kind:'decide',route,enabled:true});const result=await h.next();assert.equal(reads,2);assert.equal(result.page.routes[0].enabled,true);assert.match(result.notice,/Current permissions refreshed/);h.send({stop:true});await h.done;
});
test('receipt followed by failed refresh never displays old policy as current',async()=>{
 let reads=0;const h=await harness(async(_,o)=>{if(o.method==='GET')return ++reads===1?new Response(JSON.stringify(page)):new Response('',{status:503});return new Response(JSON.stringify({conversation_id:conversation,route_id:route,route_generation:1,permission_revision:1,enabled:true,request_key:JSON.parse(o.body).request_key}));});
 await h.next();h.send({kind:'decide',route,enabled:true});const result=await h.next();assert.equal(result.page,null);assert.equal(result.pending,false);assert.equal(result.status,503);h.send({stop:true});await h.done;
});
