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
