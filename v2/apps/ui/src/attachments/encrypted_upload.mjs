// Native V2 resumable ciphertext transport. No full File.arrayBuffer(), base64
// or plaintext HTTP. An explicit authenticated attachment step verifies and
// materializes the service-readable file before issuing a composer receipt.
import {Encrypter} from 'age-encryption';
import {ageOpenSealed} from './age.mjs';
export const UPLOAD_MAX_BYTES = 1_000_000_000;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const UPLOAD_CIPHER_MAX = UPLOAD_CHUNK_BYTES + 64 * 1024;
const MAGIC = 'ORKESTR-ATTACHMENT-CHUNK/1';
const FORMAT = 'age-x25519-chunks-v1';
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,'0')).join('');
const hash = async (bytes, subtle) => hex(await subtle.digest('SHA-256',bytes));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const chunkSize = (file,index) => Math.min(UPLOAD_CHUNK_BYTES,file.plaintext_size-index*UPLOAD_CHUNK_BYTES);
const fail = message => { throw new Error(message); };

export function validateUploadFile(file, uploadId) {
  if (!uuid(uploadId) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > UPLOAD_MAX_BYTES) fail('A file must contain 1 to 1,000,000,000 bytes.');
  const filename = String(file.name || 'file').split(/[\\/]/).pop();
  if (!filename.trim() || new TextEncoder().encode(filename).length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) fail('Invalid filename.');
  const media = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(file.type) && file.type.length <= 201 ? file.type : 'application/octet-stream';
  return {upload_id:uploadId, filename, media_type:media, plaintext_size:file.size};
}

function binding(status,index) {
  return {upload_id:status.file.upload_id, owner_id:status.owner_id, conversation_id:status.conversation_id, filename:status.file.filename, media_type:status.file.media_type, plaintext_size:status.file.plaintext_size, index, chunk_size:chunkSize(status.file,index)};
}

function validateStatus(status, descriptor, conversation) {
  if (!status || status.format !== FORMAT || !same(status.file,descriptor) || status.conversation_id !== conversation || !uuid(status.owner_id) || status.chunk_bytes !== UPLOAD_CHUNK_BYTES || !Array.isArray(status.recipients) || !status.recipients.length || status.recipients.length > 65 || !Array.isArray(status.chunks) || typeof status.complete !== 'boolean') fail('Encrypted upload identity mismatch.');
  let previous=-1;
  for (const c of status.chunks) {
    if (!Number.isSafeInteger(c.index) || c.index <= previous || c.index >= Math.ceil(descriptor.plaintext_size/UPLOAD_CHUNK_BYTES) || !Number.isSafeInteger(c.ciphertext_size) || c.ciphertext_size <= chunkSize(descriptor,c.index) || c.ciphertext_size > UPLOAD_CIPHER_MAX || !/^[0-9a-f]{64}$/.test(c.ciphertext_sha256)) fail('Invalid encrypted chunk manifest.');
    previous=c.index;
  }
  if (status.complete && status.chunks.length !== Math.ceil(descriptor.plaintext_size/UPLOAD_CHUNK_BYTES)) fail('Incomplete encrypted file.');
  return status;
}

async function readBounded(response, max) {
  if (!response.body?.getReader) fail('Streaming browser response required.');
  const reader=response.body.getReader(), parts=[];let total=0;
  try { for (;;) { const {value,done}=await reader.read();if(done)break; total+=value.length;if(total>max)fail('Encrypted response exceeds chunk limit.');parts.push(value); } }
  finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  const out=new Uint8Array(total);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
}

async function frame(status,index,bytes,subtle) {
  const header=new TextEncoder().encode(JSON.stringify({...binding(status,index),plaintext_sha256:await hash(bytes,subtle)}));
  const prefix=new TextEncoder().encode(`${MAGIC}\n${header.length}\n`), out=new Uint8Array(prefix.length+header.length+bytes.length);
  out.set(prefix);out.set(header,prefix.length);out.set(bytes,prefix.length+header.length);return out;
}

async function openChunk(status,receipt,ciphertext,options) {
  const {subtle}=options;
  if(ciphertext.length!==receipt.ciphertext_size || await hash(ciphertext,subtle)!==receipt.ciphertext_sha256)fail('Encrypted chunk checksum mismatch.');
  const plain=await ageOpenSealed(ciphertext,options), a=plain.indexOf(10),b=plain.indexOf(10,a+1),text=new TextDecoder('utf-8',{fatal:true});
  if(a<0||b<0||text.decode(plain.subarray(0,a))!==MAGIC)fail('Invalid encrypted chunk framing.');
  const length=text.decode(plain.subarray(a+1,b));if(!/^[1-9][0-9]{0,3}$/.test(length))fail('Invalid encrypted chunk header.');
  const end=b+1+Number(length);if(end>plain.length)fail('Truncated encrypted chunk header.');
  const metadata=JSON.parse(text.decode(plain.subarray(b+1,end))),checksum=metadata.plaintext_sha256;delete metadata.plaintext_sha256;
  if(!same(metadata,binding(status,receipt.index)))fail('Encrypted chunk belongs to another file, owner, conversation or position.');
  const content=plain.subarray(end);
  if(content.length!==chunkSize(status.file,receipt.index)||await hash(content,subtle)!==checksum)fail('Plaintext chunk integrity mismatch.');
  return content;
}

export function encryptedUploadClient({conversation,csrf,fetcher=fetch,subtle=crypto.subtle,storage=globalThis.localStorage,random}={}) {
  if(!uuid(conversation)||!csrf)fail('Conversation and browser authorization required.');
  const root=`/api/v2/conversations/${conversation}/encrypted-uploads`;
  const request=async(method,path,body,raw=false,digest='',signal)=>{
    signal?.throwIfAborted();
    const response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',...(signal?{signal}:{}),headers:{...(method==='GET'?{}:{'x-orkestr-csrf':csrf} ),...(body?{'Content-Type':raw?'application/octet-stream':'application/json'}:{}),...(digest?{'x-orkestr-ciphertext-sha256':digest}:{})},...(body?{body:raw?body:JSON.stringify(body)}:{})});
    if(!response.ok)fail(`Encrypted upload failed (${response.status}); reselect the file to resume.`);
    const binaryResponse=raw&&method==='GET',bytes=await readBounded(response,binaryResponse?UPLOAD_CIPHER_MAX:192*1024);
    return binaryResponse?bytes:JSON.parse(new TextDecoder().decode(bytes));
  };
  const read=async(status,receipt,signal)=>openChunk(status,receipt,await request('GET',`${root}/${status.file.upload_id}/chunks/${receipt.index}`,null,true,'',signal),{subtle,storage});
  return {
    async attach(status,{signal}={}) {
      validateStatus(status,status.file,conversation);
      if(!status.complete||!status.ingest_recipient||!status.recipients.includes(status.ingest_recipient))fail('This encrypted file cannot be prepared for the assistant on this server.');
      const receipt=await request('POST',`${root}/${status.file.upload_id}/attachment`,{},false,'',signal),file=receipt?.attachments?.[0];
      if(receipt?.manifest_id!==status.file.upload_id||receipt.attachments?.length!==1||file.attachment_id!==status.file.upload_id||file.filename!==status.file.filename||file.media_type!==status.file.media_type||file.byte_length!==status.file.plaintext_size||typeof receipt.note!=='string'||!receipt.note)fail('Attachment preparation receipt mismatch.');
      return receipt;
    },
    // Persist uploadId in the caller's owner/session-scoped UI state. On resume
    // the owner reselects the File; committed chunks are decrypted and compared
    // to it before skipping. Uncertain PUTs can safely retry the same ciphertext.
    async upload(file,uploadId,{progress=()=>{},phase=()=>{},signal,requireIngest=false}={}) {
      const descriptor=validateUploadFile(file,uploadId);
      phase('preparing');
      let status=validateStatus(await request('POST',root,descriptor,false,'',signal),descriptor,conversation);
      if(requireIngest&&(!status.ingest_recipient||!status.recipients.includes(status.ingest_recipient)))fail('Encrypted attachment preparation is not configured on this server.');
      const pinned={owner:status.owner_id,recipients:[...status.recipients]};
      const receipts=[];
      for(let index=0;index<Math.ceil(file.size/UPLOAD_CHUNK_BYTES);index++) {
        signal?.throwIfAborted();
        const offset=index*UPLOAD_CHUNK_BYTES,bytes=new Uint8Array(await file.slice(offset,offset+chunkSize(descriptor,index)).arrayBuffer());
        if(bytes.length!==chunkSize(descriptor,index))fail('File changed while uploading.');
        let receipt=status.chunks.find(c=>c.index===index);
        if(receipt) {
          phase('checking');
          const existing=await read(status,receipt,signal);
          if(await hash(bytes,subtle)!==await hash(existing,subtle))fail('Selected file differs from the interrupted upload.');
        } else {
          phase('encrypting');
          const encrypter=new Encrypter();for(const recipient of status.recipients)encrypter.addRecipient(recipient);
          const ciphertext=await encrypter.encrypt(await frame(status,index,bytes,subtle)),digest=await hash(ciphertext,subtle);
          if(ciphertext.length>UPLOAD_CIPHER_MAX)fail('Encrypted chunk exceeds transport limit.');
          phase('uploading');
          let error;
          for(let attempt=0;attempt<3;attempt++) {
            try {receipt=await request('PUT',`${root}/${uploadId}/chunks/${index}`,ciphertext,true,digest,signal);break;}catch(e){if(signal?.aborted)throw e;error=e;}
          }
          if(!receipt)throw error;
          if(!same(receipt,{index,ciphertext_size:ciphertext.length,ciphertext_sha256:digest}))fail('Chunk receipt mismatch.');
        }
        receipts.push(receipt);progress(Math.min(file.size,offset+bytes.length),file.size);
      }
      phase('finalizing');
      status=validateStatus(await request('POST',`${root}/${uploadId}/complete`,receipts,false,'',signal),descriptor,conversation);
      if(!status.complete||status.owner_id!==pinned.owner||!same(status.recipients,pinned.recipients)||!same(status.chunks,receipts))fail('Encrypted upload completion mismatch.');
      return status;
    },
    // sink must support bounded writes (e.g. FileSystemWritableFileStream).
    // Never accumulate the plaintext file in an array or Blob.
    async download(status,sink,{signal}={}) {
      validateStatus(status,status.file,conversation);
      if(!status.complete)fail('File upload is not complete.');
      try {for(const receipt of status.chunks){signal?.throwIfAborted();await sink.write(await read(status,receipt,signal));}await sink.close();}
      catch(error){await sink.abort?.(error);throw error;}
    },
  };
}
