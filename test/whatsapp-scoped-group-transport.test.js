import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
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
test('group input keeps the four-column shape earlier builds write positionally', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-group-migration-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'group.sqlite');
 const legacy=new DatabaseSync(dbPath);
 legacy.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
   INSERT INTO group_input VALUES('legacy-1','120000000001@g.us','legacy text','2026-01-01');`);
 legacy.close();
 const now=Date.now(),own='15550000001@c.us',group='120000000001@g.us';
 const config={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}],mediaDir:path.join(dir,'media')};
 const p=createScopedGroupTransport({config,token:'test-token',base:{},dbPath,now:()=>now});
 const client={info:{wid:{_serialized:own}}};
 const media={id:{_serialized:'owner-image-1'},fromMe:true,to:group,body:'',timestamp:now/1000,hasMedia:true,
   downloadMedia:async()=>({data:Buffer.from('fake-image').toString('base64'),mimetype:'image/png',filename:'sample.png'})};
 assert.equal(await p.observe(client,media),true);
 p.close();
 createScopedGroupTransport({config,token:'test-token',base:{},dbPath,now:()=>now}).close();
 const check=new DatabaseSync(dbPath);
 t.after(()=>check.close());
 assert.deepEqual(check.prepare('PRAGMA table_info(group_input)').all().map(c=>c.name),['id','chat_id','body','created_at']);
 // A rolled-back build inserts positionally; it must keep working.
 check.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('rollback-1',group,'older build','2026-01-02');
 const row=check.prepare('SELECT * FROM group_input_media WHERE id=?').get('owner-image-1');
 assert.equal(row.mimetype,'image/png');assert.equal(row.filename,'sample.png');assert.ok(fs.existsSync(row.path));
 assert.equal(check.prepare('SELECT body FROM group_input WHERE id=?').get('legacy-1').body,'legacy text');
});
test('journals migrated with media columns still accept new input', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-group-legacy-media-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'group.sqlite');
 const legacy=new DatabaseSync(dbPath);
 legacy.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,media_path TEXT,media_filename TEXT,media_mimetype TEXT,media_size INTEGER);`);
 legacy.close();
 const now=Date.now(),own='15550000001@c.us',group='120000000001@g.us';
 const p=createScopedGroupTransport({config:{ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}]},token:'test-token',base:{},dbPath,now:()=>now});
 t.after(()=>p.close());
 assert.equal(await p.observe({info:{wid:{_serialized:own}}},{id:{_serialized:'owner-1'},fromMe:true,to:group,body:'hello',timestamp:now/1000}),true);
});
test('a configuration this build rejects leaves the journal untouched', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-group-invalid-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'group.sqlite');
 const now=Date.now(),group='120000000001@g.us';
 const config={ownChatId:'15550000001@c.us',activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}],
   timerNotifications:{enabled:true,threadId:'thread-1',proofDbPath:path.join(dir,'proofs.sqlite'),since:new Date(now-1000).toISOString()},
   routeControl:{routeId:'route-1',dbPath:path.join(dir,'route.sqlite'),threadIds:['thread-other']}};
 assert.throws(()=>createScopedGroupTransport({config,token:'test-token',base:{},dbPath,now:()=>now}));
 assert.equal(fs.existsSync(dbPath),false);
 assert.equal(fs.existsSync(config.routeControl.dbPath),false);
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
test('a reply document is one more journaled send with the same parent, dedupe and conflict rules',async t=>{
 const calls=[];const {p,client,message,group}=fixture(t,async(to,content,options)=>{calls.push({to,content,options});return {id:{_serialized:`agent-${calls.length}`}};});
 const document={filename:'reply-0123456789.md',mimetype:'text/markdown',text:'# Full reply\n\nbody'};
 const media=m=>({media:m});
 await assert.rejects(p.sendDocument(client,group,document,'main',{requestId:'d1',parentId:'missing'},media),/parent_required/);
 await p.observe(client,message);
 for(const bad of [{...document,filename:'../x.md'},{...document,mimetype:'text/html'},{...document,text:' '}])
  await assert.rejects(p.sendDocument(client,group,bad,'main',{requestId:'d1',parentId:'owner-1'},media),/scope_denied/);
 await assert.rejects(p.sendDocument(client,group,document,'main',{requestId:'d1',parentId:'owner-1'}),/scope_denied/);
 const request={requestId:'d1',parentId:'owner-1'};
 assert.deepEqual((await p.sendDocument(client,group,document,'main',request,media)).ids,['agent-1']);
 assert.equal((await p.sendDocument(client,group,document,'main',request,media)).duplicate,true);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].options,{sendSeen:false,sendMediaAsDocument:true});
 assert.equal(calls[0].content.media.filename,'reply-0123456789.md');
 assert.equal(Buffer.from(calls[0].content.media.data,'base64').toString('utf8'),document.text);
 await assert.rejects(p.sendDocument(client,group,{...document,text:'other'},'main',request,media),/conflict/);
 await assert.rejects(p.sendText(client,group,'text','main',request),/conflict/);
 assert.equal(await p.observe(client,{...message,id:{_serialized:'agent-1'},body:'',hasMedia:true}),false,'the document echo is not input');
});
test('an uncertain document send blocks replay and later sends',async t=>{
 let calls=0;const {p,client,message,group}=fixture(t,async()=>{calls++;throw new Error('provider timeout');});
 await p.observe(client,message);
 const document={filename:'reply-0123456789.md',mimetype:'text/markdown',text:'full'};
 await assert.rejects(p.sendDocument(client,group,document,'main',{requestId:'d1',parentId:'owner-1'},m=>m),/delivery_uncertain/);
 await assert.rejects(p.sendText(client,group,'reply','main',{requestId:'r2',parentId:'owner-1'}),/delivery_uncertain/);
 assert.equal(calls,1);
});
function lookupFixture(t,{messages,send}) {
 const now=Date.now(),own='15550000001@c.us',group='120000000001@g.us';
 const config={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}]};
 const p=createScopedGroupTransport({config,token:'test-token',base:{},dbPath:':memory:',now:()=>now,sendLookupDelayMs:1});
 t.after(()=>p.close());
 const state={lookups:0};
 const client={info:{wid:{_serialized:own}},sendMessage:send,
  getChatById:async()=>({fetchMessages:async()=>{state.lookups++;return messages(now);}})};
 return {p,client,group,now,state,message:{id:{_serialized:'owner-1'},fromMe:true,to:group,body:'hello',timestamp:now/1000}};
}
test('a send that returns no message model is confirmed by one exact, acked own message in the group',async t=>{
 const text='x'.repeat(19978);
 const f=lookupFixture(t,{send:async()=>undefined,messages:now=>[
  {id:{_serialized:'older'},fromMe:true,type:'chat',body:text,timestamp:(now-60000)/1000,ack:2},
  {id:{_serialized:'theirs'},fromMe:false,type:'chat',body:text,timestamp:now/1000,ack:2},
  {id:{_serialized:'sent-long'},fromMe:true,type:'chat',body:text,timestamp:now/1000,ack:1}]});
 await f.p.observe(f.client,f.message);
 assert.deepEqual(await f.p.sendText(f.client,f.group,text,'main',{requestId:'r1',parentId:'owner-1'}),{ok:true,ids:['sent-long']});
 assert.equal((await f.p.sendText(f.client,f.group,text,'main',{requestId:'r1',parentId:'owner-1'})).duplicate,true);
 assert.equal(f.p.blocked(),false);
});
test('a thrown send is confirmed by lookup; a reply document is matched by its file name',async t=>{
 const document={filename:'reply-0123456789.md',mimetype:'text/markdown',text:'full'};
 const f=lookupFixture(t,{send:async()=>{throw new Error('evaluation failed');},messages:now=>[
  {id:{_serialized:'doc-1'},fromMe:true,type:'document',body:'',_data:{filename:document.filename},timestamp:now/1000,ack:1}]});
 await f.p.observe(f.client,f.message);
 assert.deepEqual((await f.p.sendDocument(f.client,f.group,document,'main',{requestId:'d1',parentId:'owner-1'},m=>m)).ids,['doc-1']);
});
test('no match, an ambiguous match or a missing server ack stays uncertain',async t=>{
 for(const variant of ['none','two','unacked','journaled']) {
  const text='y'.repeat(5000);
  const f=lookupFixture(t,{send:async()=>({id:{_serialized:variant==='journaled' ? 'first' : 'summary:x'}}),messages:now=>({
   none:[],
   two:[{id:{_serialized:'a'},fromMe:true,type:'chat',body:text,timestamp:now/1000,ack:1},{id:{_serialized:'b'},fromMe:true,type:'chat',body:text,timestamp:now/1000,ack:1}],
   unacked:[{id:{_serialized:'a'},fromMe:true,type:'chat',body:text,timestamp:now/1000,ack:0}],
   journaled:[{id:{_serialized:'first'},fromMe:true,type:'chat',body:text,timestamp:now/1000,ack:1}],
  })[variant]});
  await f.p.observe(f.client,f.message);
  if(variant==='journaled') {
   await f.p.sendText(f.client,f.group,text,'main',{requestId:'r0',parentId:'owner-1'});
   f.client.sendMessage=async()=>undefined;
  }
  await assert.rejects(f.p.sendText(f.client,f.group,text,'main',{requestId:'r1',parentId:'owner-1'}),/delivery_uncertain/,variant);
  assert.equal(f.p.blocked(),true,variant);
 }
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
