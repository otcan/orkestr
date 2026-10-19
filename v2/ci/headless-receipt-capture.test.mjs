import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installIntakeCapture} from './headless-receipt-capture.mjs';
const path='/api/v2/conversations/synthetic/messages';
async function complete(target){
 for(let i=0;i<100;i++){
  if(['complete','failed'].includes(target.__orkestrCIReceipt.state))return target.__orkestrCIReceipt;
  await new Promise(resolve=>setTimeout(resolve,1));
 }
 assert.fail('Capture did not finish');
}
test('actual request and response are unchanged while clone captures receipt without CDP',async()=>{
 let calls=0;const response=new Response('{"status":"accepted","sequence":1}',{status:202});
 const original=async(resource,options)=>{calls++;assert.equal(resource,path);assert.equal(options.body,'exact frozen request');return response;};
 const target={fetch:original};installIntakeCapture(path,target);
 const actual=await target.fetch(path,{method:'POST',body:'exact frozen request'});
 assert.equal(actual,response);assert.equal(await actual.text(),'{"status":"accepted","sequence":1}');
 assert.deepEqual(await complete(target),{state:'complete',status:202,body:{status:'accepted',sequence:1}});
 assert.equal(calls,1);assert.equal(target.fetch,original);
});
test('unrelated fetch is not captured',async()=>{
 const target={fetch:async()=>new Response('{}')};installIntakeCapture(path,target);
 await target.fetch('/api/v2/browser/session',{method:'GET'});assert.equal(target.__orkestrCIReceipt.state,'waiting');
});
for(const [name,body] of [['malformed','not JSON'],['oversized','x'.repeat(8193)]])
 test(`${name} actual receipt fails closed without changing original body`,async()=>{
 const target={fetch:async()=>new Response(body,{status:202})};installIntakeCapture(path,target);
 assert.equal(await (await target.fetch(path,{method:'POST'})).text(),body);
 assert.equal((await complete(target)).state,'failed');
 });
test('network rejection remains rejection and marks capture failed',async()=>{
 const target={fetch:async()=>{throw new Error('synthetic offline');}};installIntakeCapture(path,target);
 await assert.rejects(target.fetch(path,{method:'POST'}),/offline/);assert.equal((await complete(target)).state,'failed');
});
