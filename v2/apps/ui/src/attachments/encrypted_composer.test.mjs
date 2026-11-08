import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeDescribe} from './encrypted_composer.mjs';
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
  for(const p of updates){assert.equal(p.file_name,file.name);assert.equal(p.file_index,1);assert.equal(p.file_count,1);assert.deepEqual(Object.keys(p).sort(),['completed_bytes','file_count','file_index','file_name','phase','total_bytes']);}
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
