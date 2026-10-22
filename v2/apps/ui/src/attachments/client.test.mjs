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
test('open and export refuse a different same-owner collection',async()=>{
 const f=await fixture();f.setHandler(path=>path.includes('?')?json(f.page()):path.endsWith('/export')?json({manifest:{...f.manifest,manifest_id:id(99)},contents:[]}):json({...f.manifest,manifest_id:id(99)}));
 await f.client.list();await assert.rejects(f.client.open(id(5)),/identity/);await assert.rejects(f.client.exportCopy(f.manifest),/identity/);
});
test('valid two-manifest inert page exceeding 1 MiB is readable without dropping refs',async()=>{
 const f=await fixture();
 const make=n=>({...f.manifest,manifest_id:id(n),references:Array.from({length:128},(_,i)=>({...f.ref,reference_id:id(1000+i),state:'inert',filename:'f'.repeat(4096),media_type:'m'.repeat(1024),sha256:'s'.repeat(128)}))});
 const manifests=[make(10),make(11)];const page={...f.page(),manifests};assert(Buffer.byteLength(JSON.stringify(page))>1024*1024);
 f.setHandler(()=>json(page));const actual=await f.client.list();assert.equal(actual.manifests.length,2);assert.equal(actual.manifests[1].references.length,128);
});
test('escape-heavy valid single manifest and import receipt exceed 1 MiB safely',async()=>{
 const f=await fixture();const manifest={...f.manifest,references:Array.from({length:128},(_,i)=>({...f.ref,reference_id:id(1000+i),state:'inert',filename:'\u0001'.repeat(4096),media_type:'\u0002'.repeat(1024),sha256:'\u0003'.repeat(128)}))};
 assert(Buffer.byteLength(JSON.stringify(manifest))>1024*1024);
 f.setHandler((path,o)=>o.method==='POST'?json({import_id:id(90),source_manifest_id:JSON.parse(o.body).source.manifest.manifest_id,manifest:JSON.parse(o.body).target_manifest,mapping:JSON.parse(o.body).mapping}):path.includes('?')?json(f.page()):json(manifest));
 await f.client.list();assert.equal((await f.client.open(id(5))).references.length,128);
 await f.client.prepareCopy({manifest,contents:[]});assert.equal((await f.client.commit()).manifest.references.length,128);
});
test('route-specific metadata bounds reject oversized bodies and cancel readers',async()=>{
 const {ATTACHMENT_MANIFEST_JSON_LIMIT:single,ATTACHMENT_PAGE_JSON_LIMIT:page}=await import('./client.mjs');
 for(const [kind,limit] of [['open',single],['list',page]]){
  const f=await fixture();let cancelled=false;
  f.setHandler(()=>json(f.page()));await f.client.list();
  f.setHandler(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(limit+1));},cancel(){cancelled=true;}})));
  await assert.rejects(kind==='open'?f.client.open(id(5)):f.client.list(),/response too large/);
  assert.equal(cancelled,true);
 }
});
test('sealed download and export are opened locally and verified against the manifest',async()=>{
 const sealed=new Uint8Array([97,103,101,0,1]);const opened=[];
 const make=(bytes)=>{let live=true;const calls=[];let handler;
  const client=createAttachmentClient({conversation:id(2),csrf:'synthetic-csrf',current:()=>live,hash,random:()=>id(200),
   open:async c=>{opened.push([...c]);return {filename:'ignored',mimetype:'x/y',bytes};},fetcher:async(p,o)=>{calls.push(p);return handler(p,o);}});
  return {client,calls,setHandler:h=>handler=h};};
 const base=await fixture();
 const age=()=>new Response(sealed,{headers:{'Content-Type':'application/age','X-Content-Type-Options':'nosniff','Content-Length':'5'}});
 const routes=f=>f.setHandler(path=>path.includes('?')?json(base.page()):path.includes('/attachments/')?age():path.endsWith('/export')?json({manifest:base.manifest,contents:[{reference_id:id(4),format:'age-x25519-v1',bytes:[...sealed],recipient_fingerprints:['SHA256:00']}]}):json(base.manifest));
 const good=make(base.bytes);routes(good);await good.client.list();
 const verified=await good.client.download(base.manifest,id(4));
 assert.deepEqual([verified.state,verified.filename,[...verified.bytes]],['verified','copy.bin',[1,2,3]]);
 assert.deepEqual(opened[0],[...sealed]);
 const bundle=await good.client.exportCopy(base.manifest);
 assert.deepEqual(bundle.contents,[{reference_id:id(4),bytes:[1,2,3]}]);
 // Plaintext that does not match the manifest digest is refused.
 const bad=make(new Uint8Array([9,9,9]));routes(bad);await bad.client.list();
 await assert.rejects(bad.client.download(base.manifest,id(4)),/digest mismatch/);
 await assert.rejects(bad.client.exportCopy(base.manifest),/digest mismatch/);
 // Without an opener the sealed bytes are never treated as the file.
 const none=createAttachmentClient({conversation:id(2),csrf:'synthetic-csrf',current:()=>true,hash,fetcher:async p=>p.includes('?')?json(base.page()):p.includes('/attachments/')?age():json(base.manifest)});
 await none.list();await assert.rejects(none.download(base.manifest,id(4)),/decryption unavailable/);
});
