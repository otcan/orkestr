import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedBytes} from './attachment-saved-bytes.mjs';
function fixture({corrupt=false,absent=true}={}) {
 const expected=Buffer.from('synthetic');const calls=[];
 const receipt={run:'run',download:'download',byteLength:expected.length,sha256:createHash('sha256').update(expected).digest('hex'),contextEpoch:'owned-context'};
 return {expected,calls,adapter:{
  async beginDownloads(){calls.push('armed');return {run:'run'};},
  async dispatch(method,args){calls.push(method);assert.equal(args.run,'run');
   if(method==='awaitDownload')return {...receipt,filename:'copy.bin',completionReceipt:receipt};
   if(method==='readDownload')return {bytes:corrupt?Buffer.from('corrupted'):expected,completionReceipt:receipt};
   return {deleted:true,absenceConfirmed:absent,deletionReceipt:{...receipt,deletionId:'deleted'}};
  }
 }};
}
test('recorder precedes click; exact bytes and deletion receipts required',async()=>{
 const f=fixture();await savedBytes({...f,filename:'copy.bin',click:async()=>f.calls.push('click')});
 assert.deepEqual(f.calls,['armed','click','awaitDownload','readDownload','deleteDownload']);
});
test('corrupt bytes fail while exact-owned deletion still attempted',async()=>{
 const f=fixture({corrupt:true});await assert.rejects(savedBytes({...f,filename:'copy.bin',click:async()=>{}}));assert.equal(f.calls.at(-1),'deleteDownload');
});
test('absence uncertainty refuses success',async()=>{
 const f=fixture({absent:false});await assert.rejects(savedBytes({...f,filename:'copy.bin',click:async()=>{}}));
});
