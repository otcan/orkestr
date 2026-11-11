// Synthetic API peer for the real browser composer. Not production acceptance.
// Ciphertext crosses HTTP; only this test server decrypts its generated fixtures.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {Decrypter, Encrypter, generateX25519Identity, identityToRecipient} from 'age-encryption';

const OWNER='00000000-0000-4000-8000-000000000001';
const CHUNK=1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async req=>{const chunks=[];for await(const part of req)chunks.push(part);return Buffer.concat(chunks);};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};

export async function encryptedUploadMock(state) {
  const identity=await generateX25519Identity(),recipient=await identityToRecipient(identity);
  const uploads=new Map(), keys=new Map();
  return async(req,res,path)=>{
    const route=/^\/api\/v2\/conversations\/([0-9a-f-]{36})\/encrypted-uploads(?:\/([0-9a-f-]{36})(?:\/(complete|attachment|chunks\/([0-9]+)))?)?$/.exec(path);
    const keyRoute=/^\/api\/v2\/attachment-keys(?:\/([0-9a-f-]{36})\/verify|\/policy)?$/.exec(path);
    if(path==='/api/v2/browser/security') {json(res,200,{password_rotation_ready:false});return true;}
    if(!route&&!keyRoute)return false;
    try {
      if(req.method!=='GET')assert.equal(req.headers['x-orkestr-csrf'],'synthetic-csrf');
      if(keyRoute) {
        const status=()=>({keys:[...keys.values()].map(({proof,...key})=>key),required:true,ready:[...keys.values()].some(k=>k.status==='active')});
        if(req.method==='GET'||path.endsWith('/policy')){json(res,200,status());return true;}
        const input=JSON.parse(await read(req));
        if(keyRoute[1]) {
          const key=keys.get(keyRoute[1]);assert.equal(input.proof,key.proof);key.status='active';
          json(res,200,key);return true;
        }
        const id=randomUUID(),proof=`synthetic-enrollment-${id}`,encrypter=new Encrypter();
        encrypter.addRecipient(input.recipient);
        const key={id,recipient:input.recipient,fingerprint:`SHA256:${hash(input.recipient).slice(0,32)}`,status:'pending_verification',proof};
        keys.set(id,key);
        json(res,200,{...key,challenge:{ciphertext_base64:Buffer.from(await encrypter.encrypt(new TextEncoder().encode(proof))).toString('base64')}});
        return true;
      }
      const [,conversation,id,operation,indexText]=route;
      assert.ok(state.messages[conversation]);
      if(!id) {
        const file=JSON.parse(await read(req));
        assert.ok(file.plaintext_size>0&&file.plaintext_size<=1_000_000_000);
        const old=uploads.get(file.upload_id);
        if(old)assert.deepEqual(old.status.file,file);
        const entry=old??{data:new Map(),status:{format:'age-x25519-chunks-v1',file,owner_id:OWNER,conversation_id:conversation,recipients:[recipient,...[...keys.values()].filter(k=>k.status==='active').map(k=>k.recipient)],ingest_recipient:recipient,chunk_bytes:CHUNK,chunks:[],complete:false}};
        uploads.set(file.upload_id,entry);json(res,200,entry.status);return true;
      }
      // Like the server: an unknown (or discarded) upload is not found.
      if(!uploads.has(id)){json(res,404,{error:'not_found'});return true;}
      const entry=uploads.get(id);assert.equal(entry.status.conversation_id,conversation);
      if(!operation&&req.method==='DELETE'){
        uploads.delete(id);(state.discardedUploads??=[]).push(id);
        res.writeHead(204,{'cache-control':'no-store'});res.end();return true;
      }
      if(operation?.startsWith('chunks/')) {
        const index=Number(indexText);
        if(req.method==='GET'){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(entry.data.get(index));return true;}
        (state.chunkPuts??=[]).push({upload_id:id,index});
        if(state.holdEncryptedChunk===index) {
          // Keep this transfer open until the browser aborts it (Cancel). Drain
          // the body: an unread socket is paused and its close goes unseen.
          req.resume();
          await new Promise(resolve=>res.on('close',resolve));
          (state.abortedChunkPuts??=[]).push({upload_id:id,index});
          return true;
        }
        const bytes=await read(req),digest=hash(bytes);
        assert.equal(req.headers['content-type'],'application/octet-stream');
        assert.equal(req.headers['x-orkestr-ciphertext-sha256'],digest);
        assert.ok(bytes.length<=CHUNK+65536&&bytes.toString('ascii',0,22).startsWith('age-encryption.org/v1'));
        if(entry.data.has(index))assert.deepEqual(entry.data.get(index),bytes);
        else {entry.data.set(index,bytes);entry.status.chunks.push({index,ciphertext_size:bytes.length,ciphertext_sha256:digest});entry.status.chunks.sort((a,b)=>a.index-b.index);}
        json(res,200,entry.status.chunks.find(c=>c.index===index));return true;
      }
      if(operation==='complete') {
        assert.deepEqual(JSON.parse(await read(req)),entry.status.chunks);
        assert.equal(entry.status.chunks.length,Math.ceil(entry.status.file.plaintext_size/CHUNK));
        entry.status.complete=true;json(res,200,entry.status);return true;
      }
      if(operation==='attachment') {
        assert.ok(entry.status.complete);
        if(state.holdEncryptedAttachment===true) await new Promise(resolve=>{state.releaseEncryptedAttachment=resolve;});
        const parts=[];
        for(const receipt of entry.status.chunks) {
          const decrypter=new Decrypter();decrypter.addIdentity(identity);
          const plain=Buffer.from(await decrypter.decrypt(entry.data.get(receipt.index)));
          const first=plain.indexOf(10),second=plain.indexOf(10,first+1),length=Number(plain.toString('ascii',first+1,second));
          assert.equal(plain.toString('ascii',0,first),'ORKESTR-ATTACHMENT-CHUNK/1');
          const descriptor=JSON.parse(plain.subarray(second+1,second+1+length)),bytes=plain.subarray(second+1+length),{plaintext_sha256,...binding}=descriptor;
          const file=entry.status.file;
          assert.deepEqual(binding,{upload_id:id,owner_id:OWNER,conversation_id:conversation,filename:file.filename,media_type:file.media_type,plaintext_size:file.plaintext_size,index:receipt.index,chunk_size:Math.min(CHUNK,file.plaintext_size-receipt.index*CHUNK)});
          assert.equal(hash(bytes),plaintext_sha256);parts.push(bytes);
        }
        const file=entry.status.file,bytes=Buffer.concat(parts);assert.equal(bytes.length,file.plaintext_size);
        if(!entry.receipt) {
          // Only synthetic tiny fixture files are retained here, for browser assertions.
          state.uploads.push({target:conversation,encrypted:true,upload_id:id,files:[{filename:file.filename,media_type:file.media_type,content_base64:bytes.toString('base64')} ]});
          entry.receipt={manifest_id:id,attachments:[{attachment_id:id,filename:file.filename,media_type:file.media_type,byte_length:bytes.length}],note:`[File attached in the Orkestr app, encrypted upload ${id}: ${file.filename} (${file.media_type}, ${bytes.length} bytes), SHA-256 ${hash(bytes)}, local file /synthetic/attachments/${id}]`};
        }
        json(res,200,entry.receipt);return true;
      }
      json(res,200,entry.status);return true;
    }catch(error){json(res,400,{message:`Synthetic encrypted protocol rejected: ${error.message}`});return true;}
  };
}
