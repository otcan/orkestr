import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {encryptedUploadMock} from './headless-encrypted-uploads.mjs';
import {encryptedUploadClient} from '../apps/ui/src/attachments/encrypted_upload.mjs';

test('headless peer receives encrypted chunks and verifies bytes before composer receipt', async()=>{
  const conversation='00000000-0000-4000-8000-00000000000a';
  const state={messages:{[conversation]:[]},uploads:[]};
  const handle=await encryptedUploadMock(state);
  const server=createServer(async(req,res)=>{
    if(!await handle(req,res,new URL(req.url,'http://example.invalid').pathname)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const client=encryptedUploadClient({conversation,csrf:'synthetic-csrf',storage:null,
      fetcher:(path,options)=>fetch(origin+path,options)});
    const file=new File(['synthetic browser file'],'fixture.txt',{type:'text/plain'});
    const status=await client.upload(file,'00000000-0000-4000-8000-000000000123',{requireIngest:true});
    assert.equal(state.uploads.length,0,'ciphertext completion alone is not a provider receipt');
    const receipt=await client.attach(status);
    assert.equal(receipt.attachments[0].byte_length,file.size);
    assert.equal(state.uploads.length,1);
    assert.equal(state.uploads[0].encrypted,true);
    assert.equal(Buffer.from(state.uploads[0].files[0].content_base64,'base64').toString(),'synthetic browser file');
    await client.attach(status);
    assert.equal(state.uploads.length,1,'receipt retry does not duplicate the file');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('headless peer discards a cancelled upload: its chunks are gone and it cannot be resumed',async()=>{
  const conversation='00000000-0000-4000-8000-00000000000b',id='00000000-0000-4000-8000-000000000456';
  const state={messages:{[conversation]:[]},uploads:[]};
  const handle=await encryptedUploadMock(state);
  const server=createServer(async(req,res)=>{
    if(!await handle(req,res,new URL(req.url,'http://example.invalid').pathname)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const client=encryptedUploadClient({conversation,csrf:'synthetic-csrf',storage:null,
      fetcher:(path,options)=>fetch(origin+path,options)});
    await client.upload(new File(['synthetic partial file'],'partial.txt',{type:'text/plain'}),id,{requireIngest:true});
    assert.equal(state.chunkPuts.length,1);
    await client.discard(id);
    assert.deepEqual(state.discardedUploads,[id]);
    await assert.rejects(client.status(id),/unavailable \(404\)/);
    const chunk=await fetch(`${origin}/api/v2/conversations/${conversation}/encrypted-uploads/${id}/chunks/0`);
    assert.equal(chunk.status,404,'no ciphertext remains readable');
    await client.discard(id);
    assert.deepEqual(state.discardedUploads,[id],'a second discard finds nothing to delete');
    assert.equal(state.uploads.length,0,'never an attachment receipt');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('a held chunk sees the browser abort it; the cancelled upload is then discarded',async()=>{
  const conversation='00000000-0000-4000-8000-00000000000c',id='00000000-0000-4000-8000-000000000789';
  const state={messages:{[conversation]:[]},uploads:[],holdEncryptedChunk:1};
  const handle=await encryptedUploadMock(state);
  const server=createServer(async(req,res)=>{
    if(!await handle(req,res,new URL(req.url,'http://example.invalid').pathname)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const until=async(check,what)=>{for(let i=0;i<400&&!check();i++)await new Promise(r=>setTimeout(r,25));assert.ok(check(),what);};
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const client=encryptedUploadClient({conversation,csrf:'synthetic-csrf',storage:null,
      fetcher:(path,options)=>fetch(origin+path,options)});
    const controller=new AbortController();
    const upload=client.upload(new File([new Uint8Array(2*1024*1024+5)],'held.bin'),id,{requireIngest:true,signal:controller.signal});
    await until(()=>state.chunkPuts?.some(p=>p.index===1),'the second chunk is in flight');
    controller.abort();
    await assert.rejects(upload,{name:'AbortError'});
    await until(()=>state.abortedChunkPuts?.some(p=>p.upload_id===id),'the server sees the transfer end');
    await client.discard(id);
    assert.deepEqual(state.chunkPuts.map(p=>p.index),[0,1],'nothing after the aborted chunk');
    assert.deepEqual(state.discardedUploads,[id]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
