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
