import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationRequest} from '../src/conversation_request.mjs';
const read = {method:'GET',after:'9007199254740993',body:null};
test('directory cursor remains exact raw decimal and reads use the owner cookie only',async()=>{
 const result=await conversationRequest(read,async(path,o)=>{
  assert.equal(path,'/api/v2/conversations?after=9007199254740993&limit=50');
  assert.equal(o.credentials,'same-origin');assert.equal(o.redirect,'error');assert.equal(o.cache,'no-store');assert.deepEqual(o.headers,{});
  return new Response('{"next_cursor":9007199254740994}');
 });assert.equal(result.text,'{"next_cursor":9007199254740994}');
});
test('create sends one exact intent and uncertain retry does not change it',async()=>{
 const input={method:'POST',csrf:'synthetic',body:'{"client_request_id":"same-intent","name":"Notes"}'};
 for(let i=0;i<2;i++)assert.deepEqual(await conversationRequest(input,async(path,o)=>{
  assert.equal(path,'/api/v2/conversations');assert.equal(o.body,input.body);assert.deepEqual(o.headers,{'Content-Type':'application/json','x-orkestr-csrf':'synthetic'});
  return new Response('untrusted detail',{status:503});
 }),{status:503,text:''});
});
test('unsafe cursor, unbounded body and unsupported operation refuse before network',async()=>{
 for(const input of [{...read,after:'1&owner=other'},{...read,after:'9223372036854775808'},{...read,after:'-1'},{...read,after:'01'},{...read,after:1},{...read,body:'{}'},{method:'DELETE'},{method:'POST',body:'{}'},{method:'POST',csrf:'x',body:'x'.repeat(2049)}])
  await assert.rejects(conversationRequest(input,()=>assert.fail('network')));
});
test('bounded UTF8 replies and read-count failures cancel their reader',async()=>{
 for(const size of [0,65537]){
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(size));},cancel(){cancelled=true;}});
  await assert.rejects(conversationRequest(read,async()=>new Response(body)),/budget|large/);assert(cancelled);
 }
 await assert.rejects(conversationRequest(read,async()=>new Response(new Uint8Array([255]))));
});
test('owner cancellation reaches a pending directory request',async()=>{
 const controller=new AbortController();
 await assert.rejects(conversationRequest({...read,signal:controller.signal},async(_,o)=>new Promise((_,reject)=>{
  o.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});queueMicrotask(()=>controller.abort());
 })),/cancelled/);
});
