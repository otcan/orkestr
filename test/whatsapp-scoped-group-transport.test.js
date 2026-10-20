import assert from 'node:assert/strict';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';

function fixture(t,send) {
 const now=Date.now(),own='15550000001@c.us',group='120000000001@g.us';
 const config={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}]};
 const p=createScopedGroupTransport({config,token:'test-token',base:{},dbPath:':memory:',now:()=>now});
 t.after(()=>p.close());
 const client={info:{wid:{_serialized:own}},sendMessage:send || (async()=>({id:{_serialized:'agent-1'}}))};
 const message={id:{_serialized:'owner-1'},fromMe:true,to:group,body:'hello',timestamp:now/1000};
 return {p,client,message,group,config};
}
test('only fresh owner messages in the configured groups are admitted once',async t=>{
 const {p,client,message}=fixture(t);
 for(const patch of [{fromMe:false},{to:'120000000002@g.us'},{timestamp:0},{body:''},{id:{_serialized:'summary:fake'}}])
  assert.equal(await p.observe(client,{...message,...patch}),false);
 assert.equal(await p.observe(client,message),true);
 assert.equal(await p.observe(client,message),false);
});
test('captionless WhatsApp images are admitted for attachment publication', async t => {
 const {p,client,message}=fixture(t);
 const media={...message,id:{_serialized:'owner-image-1'},body:'',hasMedia:true,
   downloadMedia:async()=>({data:Buffer.from('fake-image').toString('base64'),mimetype:'image/png',filename:'sample.png'})};
 assert.equal(await p.observe(client,media),true);
 assert.equal(await p.observe(client,media),false,'provider replay stays idempotent');
});
test('replies require the original group and parent and remain idempotent',async t=>{
 let calls=0;const {p,client,message,group}=fixture(t,async()=>{calls++;return {id:{_serialized:'agent-1'}};});
 await assert.rejects(p.sendText(client,group,'reply','main',{requestId:'r1',parentId:'missing'}),/parent_required/);
 await p.observe(client,message);
 await assert.rejects(p.sendText(client,'120000000002@g.us','reply','main',{requestId:'r1',parentId:'owner-1'}),/scope_denied/);
 const request={requestId:'r1',parentId:'owner-1'};
 assert.deepEqual((await p.sendText(client,group,'reply','main',request)).ids,['agent-1']);
 assert.equal((await p.sendText(client,group,'reply','main',request)).duplicate,true);
 assert.equal(calls,1);
 await assert.rejects(p.sendText(client,group,'different','main',request),/conflict/);
 assert.equal(await p.observe(client,{...message,id:{_serialized:'agent-1'},body:'reply'}),false);
});
test('uncertain provider outcome blocks replay and later sends',async t=>{
 let calls=0;const {p,client,message,group}=fixture(t,async()=>{calls++;throw new Error('provider timeout');});
 await p.observe(client,message);
 for(const requestId of ['r1','r1','r2'])await assert.rejects(p.sendText(client,group,'reply','main',{requestId,parentId:'owner-1'}),/delivery_uncertain/);
 assert.equal(calls,1);
 await assert.rejects(p.observe(client,{...message,id:{_serialized:'owner-2'}}),/delivery_uncertain/);
});
test('an echo arriving before the send receipt is suppressed after settlement',async t=>{
 let p,client,echo;const f=fixture(t,async()=>{
  echo=p.observe(client,{...f.message,id:{_serialized:'agent-1'},body:'reply'});
  return {id:{_serialized:'agent-1'}};
 });({p,client}=f);await p.observe(client,f.message);
 await p.sendText(client,f.group,'reply','main',{requestId:'r1',parentId:'owner-1'});
 assert.equal(await echo,false);
});
test('account drift and unauthorized HTTP operations fail closed',async t=>{
 const {p,client,message,group}=fixture(t);client.info.wid._serialized='15550000002@c.us';
 await assert.rejects(p.observe(client,message),/account_mismatch/);
 const check=(method,path,authorization,body={})=>{
  let code=200,passed=false;const res={status:n=>{code=n;return res;},json:()=>{}};
  p.middleware({method,path,query:{},body,get:()=>authorization},res,()=>{passed=true;});return {code,passed};
 };
 assert.equal(check('GET','/health','Bearer wrong').code,401);
 assert.equal(check('GET','/health','test-token').code,401);
 assert.equal(check('POST','/api/groups','Bearer test-token').code,403);
 assert.equal(check('GET',`/api/chats/${group}/meta`,'Bearer test-token').passed,true);
 assert.equal(check('POST','/send-text','Bearer test-token',{to:group,text:'unsolicited',accountId:'main'}).code,403);
});
