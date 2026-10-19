import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {referenceFor,verifyBytes,ATTACHMENT_MAX_READS} from './integrity.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function fixture(bytes = new TextEncoder().encode('abc')) {
 const ref={reference_id:id(4),message_id:null,filename:'saved.txt',media_type:'text/plain',byte_length:bytes.length,sha256:await hash(bytes),state:'available'};
 const manifest={schema_version:1,manifest_id:id(1),owner_id:id(2),conversation_id:id(3),references:[ref]};
 const scope={manifest_id:id(1),owner_id:id(2),conversation_id:id(3)};
 let cancelled=0,read=0;
 const reader={async read(){return read++?{done:true}:{done:false,value:bytes};},async cancel(){cancelled++;}};
 return {manifest,scope,referenceId:id(4),reader,current:()=>true,digest:bytes=>webcrypto.subtle.digest('SHA-256',bytes),cancelled:()=>cancelled};
}
test('valid raw and empty bytes verify; reader always closes',async()=>{
 for(const bytes of [new Uint8Array(),new Uint8Array([0,255,128]),new TextEncoder().encode('abc')]){
 const x=await fixture(bytes);const result=await verifyBytes(x);assert.equal(result.state,'verified');assert.deepEqual(result.bytes,bytes);assert.equal(x.cancelled(),1);}
});
test('corruption and truncation never yield verified bytes',async()=>{
 for(const kind of ['digest','length']){const x=await fixture();x.manifest.references[0][kind==='digest'?'sha256':'byte_length']=kind==='digest'?'0'.repeat(64):4;await assert.rejects(verifyBytes(x),/mismatch/);assert.equal(x.cancelled(),1);}
});
test('oversized chunk is refused before hashing',async()=>{
 const x=await fixture();x.reader.read=async()=>({done:false,value:new Uint8Array(4)});x.digest=()=>assert.fail('must not hash');await assert.rejects(verifyBytes(x),/length/);assert.equal(x.cancelled(),1);
});
test('removed metadata is preserved but bytes are refused',async()=>{
 const x=await fixture();x.manifest.references[0].state='removed';await assert.rejects(verifyBytes(x),/removed/);x.reader=null;assert.deepEqual(await verifyBytes(x),{state:'removed',filename:'saved.txt',byte_length:3});
});
test('foreign owner/conversation/manifest and missing reference refused',async()=>{
 for(const key of ['owner_id','conversation_id','manifest_id']){const x=await fixture();x.scope[key]=id(9);await assert.rejects(verifyBytes(x),/scope/);assert.equal(x.cancelled(),1);}
 const x=await fixture();x.referenceId=id(9);await assert.rejects(verifyBytes(x),/missing/);
});
test('canonical metadata limits and duplicate identities fail closed',async()=>{
 const mutations=[r=>r.filename='../x',r=>r.filename='é'.repeat(128),r=>r.media_type='text/plain; charset=utf8',r=>r.sha256='A'.repeat(64),r=>r.byte_length=16777217,r=>r.extra=true];
 for(const change of mutations){const x=await fixture();change(x.manifest.references[0]);assert.throws(()=>referenceFor(x.manifest,x.scope,x.referenceId),/invalid/);}
 const x=await fixture();x.manifest.references.push({...x.manifest.references[0]});assert.throws(()=>referenceFor(x.manifest,x.scope,x.referenceId),/duplicate/);
});
test('logout during delayed read discards bytes and cancels reader',async()=>{
 const x=await fixture();let active=true;x.current=()=>active;x.reader.read=async()=>{active=false;return {done:false,value:new Uint8Array([1])};};await assert.rejects(verifyBytes(x),/scope/);assert.equal(x.cancelled(),1);
});
test('navigation during digest discards completed hash result',async()=>{
 const x=await fixture();let active=true;x.current=()=>active;x.digest=async bytes=>{const hash=await webcrypto.subtle.digest('SHA-256',bytes);active=false;return hash;};await assert.rejects(verifyBytes(x),/scope/);assert.equal(x.cancelled(),1);
});
test('aggregate cap and reference count apply even to unselected entries',async()=>{
 const x=await fixture();x.manifest.references.push({...x.manifest.references[0],reference_id:id(5),byte_length:16777216});assert.throws(()=>referenceFor(x.manifest,x.scope,x.referenceId),/limit/);
 const y=await fixture();y.manifest.references=Array.from({length:129},(_,i)=>({...y.manifest.references[0],reference_id:id(i+10)}));assert.throws(()=>referenceFor(y.manifest,y.scope,y.referenceId),/invalid/);
});
test('16MiB available boundary remains supported',async()=>{
 const x=await fixture(new Uint8Array(16777216));assert.equal((await verifyBytes(x)).bytes.length,16777216);assert.equal(x.cancelled(),1);
});

test('empty chunk flood is refused within a fixed read budget even for zero declared bytes',async()=>{
 for(const bytes of [new Uint8Array(),new Uint8Array([1])]){
  const x=await fixture(bytes);let reads=0;
  x.reader.read=async()=>{reads++;return {done:false,value:new Uint8Array()};};
  x.digest=()=>assert.fail('flood must never reach hashing');
  await assert.rejects(verifyBytes(x),/read budget exceeded/);
  assert.equal(reads,ATTACHMENT_MAX_READS);assert.equal(x.cancelled(),1);
 }
});
test('one-byte chunk flood is refused instead of retaining millions of chunk objects',async()=>{
 const x=await fixture(new Uint8Array(16777216));let reads=0;
 x.reader.read=async()=>{reads++;return {done:false,value:new Uint8Array([0])};};
 x.digest=()=>assert.fail('flood must never reach hashing');
 await assert.rejects(verifyBytes(x),/read budget exceeded/);
 assert.equal(reads,ATTACHMENT_MAX_READS);assert.equal(x.cancelled(),1);
});
test('ordinary multi-chunk input copies bytes without retaining mutable chunk references',async()=>{
 const x=await fixture(new Uint8Array([1,2,3]));let index=0;const chunk=new Uint8Array(1);
 x.reader.read=async()=>{if(index===3)return {done:true};chunk[0]=++index;return {done:false,value:chunk};};
 assert.deepEqual((await verifyBytes(x)).bytes,new Uint8Array([1,2,3]));assert.equal(x.cancelled(),1);
});
