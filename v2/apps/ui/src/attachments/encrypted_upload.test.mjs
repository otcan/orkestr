import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,randomBytes,createHash} from 'node:crypto';
import {Encrypter} from 'age-encryption';
import {AGE_IDENTITY_KEY,ageGenerateIdentity,ageIdentityToRecipient,ageDecrypt} from './age.mjs';
import {encryptedUploadClient,validateUploadFile,UPLOAD_MAX_BYTES,UPLOAD_CHUNK_BYTES,UPLOAD_CIPHER_MAX} from './encrypted_upload.mjs';
const subtle=webcrypto.subtle,random=b=>webcrypto.getRandomValues(b);
const conversation='00000000-0000-4000-8000-000000000001',owner='00000000-0000-4000-8000-000000000002',id='00000000-0000-4000-8000-000000000003';
const digest=b=>createHash('sha256').update(b).digest('hex');

test('maintained age-encryption library interoperates with the existing browser decryptor',async()=>{
  const identity=ageGenerateIdentity(random),recipient=await ageIdentityToRecipient(identity,subtle);
  const encrypter=new Encrypter();encrypter.addRecipient(recipient);
  const data=randomBytes(65537),cipher=await encrypter.encrypt(data);
  assert.deepEqual(Buffer.from(await ageDecrypt(identity,cipher,subtle)),data);
});

async function fixture(size=UPLOAD_CHUNK_BYTES+7){
  const identity=ageGenerateIdentity(random),recipient=await ageIdentityToRecipient(identity,subtle),chunks=new Map();
  const storage={getItem:k=>k===AGE_IDENTITY_KEY?identity:null};
  let status=null,attempts=0,interrupt=false,corrupt=false,maxBody=0;
  const fetcher=async(path,options)=>{
    assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
    if(options.method!=='GET')assert.equal(options.headers['x-orkestr-csrf'],'synthetic-csrf');
    const part=path.split('/').at(-1);
    const reply=v=>new Response(JSON.stringify(v),{status:200});
    if(options.method==='POST'&&part==='encrypted-uploads'){
      const file=JSON.parse(options.body);if(status){assert.deepEqual(status.file,file);}else status={format:'age-x25519-chunks-v1',file,owner_id:owner,conversation_id:conversation,recipients:[recipient],ingest_recipient:recipient,chunk_bytes:UPLOAD_CHUNK_BYTES,chunks:[],complete:false};
      return reply(status);
    }
    if(options.method==='POST'&&part==='complete'){
      assert.deepEqual(JSON.parse(options.body),status.chunks);status.complete=true;return reply(status);
    }
    if(options.method==='POST'&&part==='attachment'){
      assert.equal(status.complete,true);return reply({manifest_id:status.file.upload_id,attachments:[{attachment_id:status.file.upload_id,filename:status.file.filename,media_type:status.file.media_type,byte_length:status.file.plaintext_size}],note:'Verified local provider file'});
    }
    const index=Number(part);
    if(options.method==='PUT'){
      maxBody=Math.max(maxBody,options.body.length);assert.ok(options.body.length<=UPLOAD_CIPHER_MAX);assert.equal(options.headers['Content-Type'],'application/octet-stream');
      const bytes=Buffer.from(options.body);assert.ok(bytes.subarray(0,22).toString().startsWith('age-encryption.org/v1'));
      assert.equal(options.headers['x-orkestr-ciphertext-sha256'],digest(bytes));
      if(index===1&&interrupt)throw new Error('Network interrupted');
      const receipt={index,ciphertext_size:bytes.length,ciphertext_sha256:digest(bytes)};
      if(chunks.has(index))assert.deepEqual(chunks.get(index),bytes);else{chunks.set(index,bytes);status.chunks.push(receipt);}
      // Lost response after durable commit: retry must use identical ciphertext.
      if(index===0&&attempts++===0)throw new Error('Response lost');
      return reply(receipt);
    }
    const bytes=Buffer.from(chunks.get(index));if(corrupt)bytes[bytes.length-1]^=1;return new Response(bytes);
  };
  let largestSlice=0,readCount=0;
  const data=Buffer.alloc(size,42);
  const file={name:'file.bin',type:'application/octet-stream',size,
    arrayBuffer(){assert.fail('Whole-file read is forbidden');},
    slice(start,end){largestSlice=Math.max(largestSlice,end-start);readCount++;return{async arrayBuffer(){return Uint8Array.from(data.subarray(start,end)).buffer;}};}};
  const client=encryptedUploadClient({conversation,csrf:'synthetic-csrf',fetcher,subtle,storage,random});
  return{client,file,data,chunks,get status(){return status;},get maxBody(){return maxBody;},get largestSlice(){return largestSlice;},get readCount(){return readCount;},interrupt:v=>interrupt=v,corrupt:()=>corrupt=true};
}

test('interruption resumes after reselect, ciphertext PUT retries, downloads bounded verified plaintext',async()=>{
  const f=await fixture();f.interrupt(true);
  await assert.rejects(f.client.upload(f.file,id),/Network interrupted/);
  assert.equal(f.chunks.size,1);assert.equal(f.status.complete,false);
  f.interrupt(false);const status=await f.client.upload(f.file,id);
  assert.equal(status.complete,true);assert.equal(f.chunks.size,2);
  assert.equal((await f.client.attach(status)).attachments[0].byte_length,f.file.size);
  let total=0,writes=0;
  await f.client.download(status,{async write(bytes){writes++;assert.ok(bytes.length<=UPLOAD_CHUNK_BYTES);assert.deepEqual(Buffer.from(bytes),f.data.subarray(total,total+bytes.length));total+=bytes.length;},async close(){assert.equal(total,f.file.size);}});
  assert.equal(writes,2);assert.equal(f.largestSlice,UPLOAD_CHUNK_BYTES);assert.ok(f.maxBody<=UPLOAD_CIPHER_MAX);
});

test('corruption, selected-file mismatch, cross-conversation and cross-owner framing fail closed',async()=>{
  const f=await fixture(100);const status=await f.client.upload(f.file,id);
  f.data[0]^=1;await assert.rejects(f.client.upload(f.file,id),/differs/);f.data[0]^=1;
  for(const field of ['owner_id','conversation_id']){
    const changed=structuredClone(status);changed[field]='00000000-0000-4000-8000-000000000099';
    await assert.rejects(f.client.download(changed,{write(){assert.fail('Unverified plaintext write');}}),/identity mismatch|another file/);
  }
  f.corrupt();let aborted=false;
  await assert.rejects(f.client.download(status,{write(){assert.fail('Corrupt plaintext write');},abort(){aborted=true;}}),/checksum/);
  assert.equal(aborted,true);
});

test('decimal1GB is per file and limit+1 rejected before any read or request',async()=>{
  const file={name:'large.bin',type:'application/octet-stream',size:UPLOAD_MAX_BYTES};
  assert.equal(validateUploadFile(file,id).plaintext_size,1_000_000_000);
  file.size++;assert.throws(()=>validateUploadFile(file,id),/1,000,000,000/);
  const client=encryptedUploadClient({conversation,csrf:'synthetic',subtle,fetcher(){assert.fail('Request made for oversized file');}});
  await assert.rejects(client.upload(file,id),/1,000,000,000/);
});

test('cancelled upload/preparation does not issue a request or retry aborts',async()=>{
  const controller=new AbortController();controller.abort();let requests=0;
  const client=encryptedUploadClient({conversation,csrf:'synthetic',subtle,fetcher(){requests++;assert.fail('Cancelled request sent');}});
  await assert.rejects(client.upload({name:'file',type:'text/plain',size:3},id,{signal:controller.signal}),{name:'AbortError'});
  const f=await fixture(3);const status=await f.client.upload(f.file,id);
  await assert.rejects(client.attach(status,{signal:controller.signal}),{name:'AbortError'});assert.equal(requests,0);
});
