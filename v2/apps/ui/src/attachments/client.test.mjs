import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createAttachmentClient} from './client.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const hash=b=>webcrypto.subtle.digest('SHA-256',b);
const json=v=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
async function fixture(){
 const bytes=new Uint8Array([1,2,3]);
 const ref={reference_id:id(4),message_id:null,filename:'copy.bin',media_type:'application/octet-stream',byte_length:3,sha256:Buffer.from(await hash(bytes)).toString('hex'),state:'available'};
 const manifest={schema_version:1,manifest_id:id(5),owner_id:id(1),conversation_id:id(2),references:[ref]};
 let sequence=100,live=true,handler;
 const calls=[];
 const client=createAttachmentClient({conversation:id(2),csrf:'synthetic-csrf',current:()=>live,hash,random:()=>id(sequence++),fetcher:async(path,options)=>{
  calls.push({path,options});return handler(path,options);
 }});
 return {client,bytes,ref,manifest,calls,setHandler:h=>handler=h,expire:()=>live=false,
 page:()=>({owner_id:id(1),conversation_id:id(2),after_id:null,next_after_id:null,manifests:[]})};
}
test('authenticated empty discovery supplies upload target; frozen lost-response retry is identical',async()=>{
 const f=await fixture();let attempts=0;
 f.setHandler((path,o)=>{
  if(o.method==='GET')return json(f.page());
  if(++attempts===1)throw new Error('response lost');
  const b=JSON.parse(o.body);return json({import_id:id(90),source_manifest_id:b.source.manifest.manifest_id,manifest:b.target_manifest,mapping:b.mapping});
 });
 await f.client.list();
 await f.client.upload({name:'copy.bin',type:'application/octet-stream',size:3,arrayBuffer:async()=>f.bytes.buffer});
 await assert.rejects(f.client.commit(),/response lost/);
 const frozen=f.client.pending().body;assert.equal(frozen.target_manifest.owner_id,id(1));assert.equal(frozen.target_manifest.references[0].message_id,null);
 await f.client.commit();const posts=f.calls.filter(c=>c.options.method==='POST');assert.equal(posts[0].options.body,posts[1].options.body);
 assert.equal(posts[0].options.credentials,'same-origin');assert.equal(posts[0].options.headers['x-orkestr-csrf'],'synthetic-csrf');assert.equal(f.client.pending(),null);
});
test('foreign discovery and malformed cursors cannot establish upload authority',async()=>{
 const f=await fixture();f.setHandler(()=>json({...f.page(),conversation_id:id(9)}));await assert.rejects(f.client.list(),/scope/);
 await assert.rejects(f.client.upload({name:'x',size:0,arrayBuffer:async()=>new ArrayBuffer(0)}),/Refresh/);
 f.setHandler(()=>json({...f.page(),next_after_id:id(8)}));await assert.rejects(f.client.list(),/cursor/);
});
test('download verifies exact bytes and revalidates tombstone after raw response',async()=>{
 const f=await fixture();let reads=0;
 f.setHandler(path=>path.includes('/attachments/')?new Response(f.bytes,{headers:{'Content-Length':'3','Content-Type':f.ref.media_type,'X-Content-Type-Options':'nosniff'}}):json(++reads===1?f.manifest:{...f.manifest,references:[{...f.ref,state:'removed'}]}));
 // Establish only server-returned owner before opening a collection.
 const original=f.page();f.setHandler(path=>path.includes('?')?json(original):path.includes('/attachments/')?new Response(f.bytes,{headers:{'Content-Length':'3','Content-Type':f.ref.media_type,'X-Content-Type-Options':'nosniff'}}):json(++reads===1?f.manifest:{...f.manifest,references:[{...f.ref,state:'removed'}]}));
 await f.client.list();await assert.rejects(f.client.download(f.manifest,id(4)),/removed/);assert.equal(reads,2);
});
test('inert and removed references never request bytes',async()=>{
 for(const state of ['removed','inert']){
  const f=await fixture();f.setHandler(path=>path.includes('?')?json(f.page()):json({...f.manifest,references:[{...f.ref,state}]}));await f.client.list();
  await assert.rejects(f.client.download(f.manifest,id(4)),/removed|reference only/);
  assert.equal(f.calls.some(c=>c.path.includes('/attachments/')),false);
 }
});
test('logout during delayed response discards canonical result and aborts owned fetch',async()=>{
 const f=await fixture();let release;f.setHandler(()=>new Promise(resolve=>release=resolve));const promise=f.client.list();
 f.client.close();release(json(f.page()));await assert.rejects(promise,/selection changed/);assert.equal(f.calls[0].options.signal.aborted,true);
});
test('removal freezes original key and invalidates a pending verified download',async()=>{
 const f=await fixture();let finishRaw,removeAttempts=0;
 f.setHandler((path,o)=>{
  if(path.includes('?'))return json(f.page());
  if(o.method==='DELETE'){if(++removeAttempts===1)throw new Error('uncertain');return json({manifest_id:id(5),reference_id:id(4),removed:true});}
  if(path.includes('/attachments/'))return new Promise(resolve=>finishRaw=()=>resolve(new Response(f.bytes,{headers:{'Content-Length':'3','Content-Type':f.ref.media_type,'X-Content-Type-Options':'nosniff'}})));
  return json(f.manifest);
 });
 await f.client.list();const download=f.client.download(f.manifest,id(4));while(!finishRaw)await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.client.remove(f.manifest,id(4)),/uncertain/);finishRaw();await assert.rejects(download,/scope|selection/);
 await f.client.commit();const deletes=f.calls.filter(c=>c.options.method==='DELETE');assert.equal(deletes[0].options.body,deletes[1].options.body);
});
