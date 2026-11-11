import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cancelUpload,discardUpload,nativeDescribe,nativePaste} from './encrypted_composer.mjs';
const conversation='00000000-0000-4000-8000-000000000001';
const file={name:'large.bin',type:'application/octet-stream',size:1_000_000_000,lastModified:1};
test('native picker bridge sends verified receipts only and resumes persisted upload id',async()=>{
  const data=new Map(),drafts={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  let id,first=true;const receipt={manifest_id:'00000000-0000-4000-8000-000000000002',attachments:[{attachment_id:'file',filename:file.name,media_type:file.type,byte_length:file.size}],note:'Verified local file'};
  const client={async upload(f,uploadId,options){assert.equal(f,file);assert.equal(options.requireIngest,true);if(id)assert.equal(id,uploadId);id=uploadId;if(first){first=false;throw Error('Interrupted');}return{complete:true};},async attach(status){assert.equal(status.complete,true);return receipt;}};
  const describe=nativeDescribe({conversation,csrf:'synthetic'},{drafts,client});
  assert.equal((await describe([file])).error,'Interrupted');assert.equal(data.size,1);
  assert.deepEqual(await describe([file]),{receipts:[receipt]});assert.equal(data.size,0);
});
test('batch validation precedes transfers and storage failures do not block upload',async()=>{
  let uploaded=0;const client={async upload(){uploaded++;return{};},async attach(){return{verified:true};}};
  const drafts={getItem(){throw Error('Storage unavailable');},setItem(){throw Error('Storage unavailable');},removeItem(){throw Error('Storage unavailable');}};
  const describe=nativeDescribe({conversation,csrf:'synthetic'},{drafts,client});
  assert.match((await describe([file,{...file,size:1_000_000_001}])).error,/1,000,000,000/);assert.equal(uploaded,0);
  assert.deepEqual(await describe([file]),{receipts:[{verified:true}]});assert.equal(uploaded,1);
});
test('denied storage getters do not prevent native uploader initialization',async()=>{
  const names=['sessionStorage','localStorage'];
  const original=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  try{
    for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,get(){throw new DOMException('Denied','SecurityError');}});
    // Use the real default encrypted client: construction must not touch
    // inaccessible storage. Empty selection performs no network request.
    assert.deepEqual(await nativeDescribe({conversation,csrf:'synthetic'})([]),{receipts:[]});
  }finally{
    names.forEach((name,index)=>{if(original[index])Object.defineProperty(globalThis,name,original[index]);else delete globalThis[name];});
  }
});


test('live acknowledged progress precedes receipt and 100 percent transfer is not attachment readiness',async()=>{
  const updates=[];
  let finishUpload,finishAttach;
  const uploaded=new Promise(r=>finishUpload=r),attached=new Promise(r=>finishAttach=r);
  const client={async upload(f,id,options){options.phase('encrypting');options.phase('uploading');options.progress(500_000_000,f.size);await uploaded;options.progress(f.size,f.size);options.phase('finalizing');return {complete:true};},async attach(){await attached;return {verified:true};}};
  const describe=nativeDescribe({conversation,csrf:'synthetic'},{drafts:null,client,progress:p=>updates.push(p)});
  const pending=describe([file]);
  await new Promise(r=>setImmediate(r));
  assert.equal(updates.at(-1).completed_bytes,500_000_000);
  assert.equal(updates.at(-1).total_bytes,1_000_000_000);
  assert.equal(updates.some(p=>p.phase==='ready'),false);
  finishUpload();await new Promise(r=>setImmediate(r));
  assert.equal(updates.at(-1).phase,'preparing_attachment');
  assert.equal(updates.at(-1).completed_bytes,1_000_000_000);
  assert.equal(updates.some(p=>p.phase==='ready'),false,'receipt has not arrived');
  finishAttach();assert.deepEqual(await pending,{receipts:[{verified:true}]});
  assert.equal(updates.at(-1).phase,'ready');
  for(const p of updates){assert.equal(p.file_name,file.name);assert.equal(p.file_index,1);assert.equal(p.file_count,1);assert.deepEqual(Object.keys(p).sort(),['completed_bytes','file_count','file_index','file_name','phase','total_bytes','upload_id']);}
});

test('batch totals span files and partial failure preserves receipts and resume state',async()=>{
  const updates=[],files=[{...file,size:10},{...file,name:'next.bin',size:20}];
  const client={async upload(f,id,o){o.progress(f.size,f.size);if(f===files[1])throw Error('Interrupted');return{};},async attach(){return {verified:true};}};
  const result=await nativeDescribe({conversation,csrf:'synthetic'},{drafts:null,client,progress:p=>updates.push(p)})(files);
  assert.deepEqual(result,{receipts:[{verified:true}],error:'Interrupted'});
  assert.equal(updates.at(-1).phase,'failed');
  assert.equal(updates.at(-1).file_index,2);
  assert.equal(updates.at(-1).total_bytes,30);
  assert.equal(updates.some(p=>p.phase==='ready'),false);
  const previous=updates.filter(p=>p.phase==='file_ready');assert.equal(previous.length,1);assert.equal(previous[0].completed_bytes,10);
});

const UPLOAD_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tick=()=>new Promise(r=>setImmediate(r));

test('Cancel stops one file, discards it on the server and the rest of the batch attaches',async()=>{
  const updates=[],discarded=[],data=new Map();
  const drafts={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const files=[{...file,name:'cancel-me.bin',size:30},{...file,name:'keep.bin',size:10}];
  let signals=0;
  const client={
    async upload(f,id,o){
      assert.ok(o.signal instanceof AbortSignal,'each transfer can be aborted');signals++;
      o.progress(5,f.size);
      // A real transfer only ends by finishing or by its signal.
      if(f===files[0])await new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true}));
      return{id};
    },
    async attach(status,{signal}){assert.equal(signal.aborted,false);return{manifest_id:status.id};},
    async discard(id){discarded.push(id);},
  };
  const pending=nativeDescribe({conversation,csrf:'synthetic'},{drafts,client,progress:p=>updates.push(p)})(files);
  await tick();
  const first=updates.at(-1);
  assert.equal(first.file_name,'cancel-me.bin');assert.match(first.upload_id,UPLOAD_ID);
  assert.equal(data.size,1,'the transfer has a resume id until it is cancelled');
  assert.equal(cancelUpload(first.upload_id),true);
  const result=await pending;
  assert.equal(result.error,undefined,'a cancel is not an upload error');
  assert.equal(result.receipts.length,1);assert.notEqual(result.receipts[0].manifest_id,first.upload_id);
  assert.deepEqual(discarded,[first.upload_id],'only the cancelled upload is discarded');
  assert.equal(data.size,0,'no resume id is kept for the cancelled file');
  assert.equal(signals,2);
  const kept=updates.filter(p=>p.file_name==='keep.bin');
  assert.equal(kept.at(-1).phase,'ready');assert.notEqual(kept.at(-1).upload_id,first.upload_id);
  assert.equal(kept.at(-1).total_bytes,10,'the batch total no longer counts the cancelled file');
  assert.equal(kept.at(-1).completed_bytes,10);
  assert.equal(cancelUpload(first.upload_id),false,'nothing left to cancel');
  assert.equal(cancelUpload(kept.at(-1).upload_id),false,'a finished file is removed, not cancelled');
});

test('a Cancel racing the attachment receipt withholds it and a failed discard is not an error',async()=>{
  const discarded=[];let id;
  const client={async upload(f,uploadId){id=uploadId;return{};},
    async attach(){assert.equal(cancelUpload(id),true);return{manifest_id:id};},
    async discard(uploadId){discarded.push(uploadId);throw Error('Synthetic network loss');}};
  assert.deepEqual(await nativeDescribe({conversation,csrf:'synthetic'},{drafts:null,client})([file]),{receipts:[]});
  assert.deepEqual(discarded,[id],'tried once; the server expiry covers a lost discard');
});

test('Remove discards the upload on the server and its retained paste receipt is not reused',async()=>{
  const deleted=[];let uploads=0;
  const client={async upload(f,uploadId){uploads++;return{uploadId};},
    async attach(status){return{manifest_id:status.uploadId,attachments:[],note:'Synthetic note'};},
    async discard(uploadId){deleted.push(uploadId);}};
  const config={conversation,csrf:'synthetic'},element={value:'Synthetic long draft'},options={drafts:null,client,retainSuccess:true};
  const first=await nativePaste(config,element,options);
  assert.equal(await nativePaste(config,element,options),first,'an unchanged retry reuses the receipt');
  assert.equal(uploads,1);
  const removed=first.receipts[0].manifest_id;
  assert.equal(await discardUpload(config,removed,{client}),true);
  assert.deepEqual(deleted,[removed]);
  const again=await nativePaste(config,element,options);
  assert.equal(uploads,2,'a removed file is uploaded again, not reused');
  assert.notEqual(again.receipts[0].manifest_id,removed);
  assert.equal(await discardUpload(config,removed,{client:{async discard(){throw Error('Synthetic network loss');}}}),false);
});
