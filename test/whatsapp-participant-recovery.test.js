import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createParticipantRecoveryPolicy,readProtectedParticipantGrant,validateParticipantRecoveryReference} from '../packages/connectors/src/whatsapp-participant-recovery.js';
import {createScopedGroupTransport,validateScopedGroupConfig} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {preflightScopedGroupConfigs} from '../scripts/scoped-group-preflight.mjs';

const NOW=Date.parse('2026-01-03T12:00:00.000Z'),group='120000000001@g.us',other='120000000002@g.us';
const own='15550000001@c.us',phone='15550000002@c.us',lid='10000000002@lid';
const body='An earlier participant reply.',createdAt='2026-01-03T03:00:00.000Z',messageId='false_120000000001@g.us_ABC_10000000002@lid';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t) {
 const grant={format:'orkestr-whatsapp-participant-message-recovery-v1',accountId:'sender',chatId:group,threadId:'thread-a',
  messageId,authorId:lid,phoneId:phone,createdAt,bodySha256:hash(body),expiresAt:'2026-01-03T13:00:00.000Z'};
 const config={ownerUserId:'owner',workerAccountId:'sender',ownChatId:own,activatedAt:'2026-01-03T10:00:00.000Z',
  groups:[{chatId:group,threadId:'thread-a',name:'Example'}],
  participantAuthors:[{chatId:group,threadId:'thread-a',ids:[phone],since:'2026-01-03T11:00:00.000Z'}],
  participantRecoveryGrant:{path:'/protected/grant.json',sha256:hash(JSON.stringify(grant))}};
 let clock=NOW,revoked=false;const state={lookups:[],posts:[],sends:[],answers:[],member:true};
 const read=()=>{if(revoked)throw new Error('participant_recovery_denied');return structuredClone(grant);};
 const client={info:{wid:{_serialized:own}},getContactLidAndPhone:async()=>[{lid,pn:phone}],
  getMessageById:async id=>{state.lookups.push(id);return message();}};
 const message=(patch={})=>({id:{_serialized:messageId,remote:group},from:group,fromMe:false,author:lid,
  body,timestamp:Date.parse(createdAt)/1000,...patch});
 const request=(patch={})=>({threadId:'thread-a',messageId,expectedAuthorId:lid,expectedPhoneId:phone,
  expectedCreatedAt:createdAt,expectedBodySha256:hash(body),...patch});
 return {config,grant,client,state,message,request,read,now:()=>clock,setNow:v=>{clock=v;},revoke:()=>{revoked=true;}};
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function pipeline(t) {
 const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'participant-recovery-'));
 f.config.journalPath=path.join(dir,'inbox.sqlite');
 const transport=createScopedGroupTransport({config:f.config,token:'fixture-token',base:{},now:f.now,readRecoveryGrant:f.read});
 const inbox=new DatabaseSync(f.config.journalPath),db=new DatabaseSync(':memory:');
 const api=async(url,options={})=>{
  if(url.endsWith('/whatsapp-participant-check'))return {allowed:f.state.member};
  if(url.endsWith('/input')){f.state.posts.push(options.body);return {message:{id:'routed-message'}};}
  if(url.includes('/messages'))return {messages:f.state.answers};
  return {thread:{id:'thread-a',ownerUserId:'owner',binding:{chatId:group,enabled:true,mirrorToWhatsApp:false,
   allowOtherPeople:true,authorizedContactIds:f.state.member?[phone]:[]}}};
 };
 const relay=createScopedGroupRelay({config:f.config,api,inboxDb:inbox,relayDb:db,now:f.now,readRecoveryGrant:f.read,
  send:async p=>{f.state.sends.push(p);return {ok:true,ids:['fixture-sent']};}});
 t.after(()=>{relay.close();inbox.close();db.close();transport.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {...f,transport,inbox,db,relay};
}

test('exact protected grant recovers original provider message once through normal participant routing',async t=>{
 const f=pipeline(t);
 assert.equal(await f.transport.observe(f.client,f.message()),false,'normal freshness remains unchanged');
 const first=await f.transport.recoverParticipantMessage(f.client,group,f.request());
 assert.equal(first.ok,true);assert.equal(first.duplicate,false);assert.equal(first.receipt.bodySha256,hash(body));
 assert.equal(f.inbox.prepare('SELECT count(*) n FROM group_input').get().n,1);
 const proof=JSON.parse(f.inbox.prepare('SELECT proof FROM group_input_author').get().proof);
 assert.equal(proof.recoveryGrantSha256,f.config.participantRecoveryGrant.sha256);
 const repeat=await f.transport.recoverParticipantMessage(f.client,group,f.request());
 assert.equal(repeat.duplicate,true);assert.deepEqual(repeat.receipt,first.receipt);assert.deepEqual(f.state.lookups,[messageId]);
 await f.relay.tick();assert.equal(f.state.posts.length,1);
 const posted=f.state.posts[0];assert.equal(posted.originOwner,false);assert.equal(posted.controlAllowed,false);assert.equal(posted.parseCommands,false);
 assert.equal(posted.externalId,messageId);assert.equal(posted.senderParticipantId,lid);
});

test('wrong group, member, original body/time/author/fromMe and extra caller authority never insert',async t=>{
 const f=pipeline(t);
 const worker=createScopedNativeWorkerPolicy({...f.config,routeControl:{threadIds:['thread-a'],routeId:'fixture',dbPath:'/unused'}},{readRecoveryGrant:f.read,now:f.now});
 const url=new URL(`/accounts/sender/chats/${encodeURIComponent(group)}/recover-participant-message`,'http://worker');
 worker.checkRequest('POST',url,f.request());
 for(const extra of [{originOwner:true},{controlAllowed:true},{body:'forged'},{grant:true},{threadId:'other'},{expectedBodySha256:'a'.repeat(64)}])
  assert.throws(()=>worker.checkRequest('POST',url,f.request(extra)),/denied/);
 assert.throws(()=>worker.checkRequest('POST',new URL(url.href+'?force=1'),f.request()),/denied/);
 await assert.rejects(f.transport.recoverParticipantMessage(f.client,other,f.request()),/denied/);
 for(const patch of [{from:other},{fromMe:true},{author:own},{body:'changed'},{timestamp:Date.parse(createdAt)/1000+1},
   {id:{_serialized:'another',remote:group}},{id:{_serialized:messageId,remote:other}}]){
  f.client.getMessageById=async()=>f.message(patch);
  await assert.rejects(f.transport.recoverParticipantMessage(f.client,group,f.request()),/denied/);
 }
 f.client.getMessageById=async()=>f.message();f.client.getContactLidAndPhone=async()=>[{lid,pn:own}];
 await assert.rejects(f.transport.recoverParticipantMessage(f.client,group,f.request()),/unconfirmed/);
 assert.equal(f.inbox.prepare('SELECT count(*) n FROM group_input').get().n,0);
});

test('expiry or grant revocation during live identity lookup commits no input or proof',async t=>{
 for(const action of ['expiry','revocation']){
  await t.test(action,async t=>{
   const f=pipeline(t);let release;
   f.client.getContactLidAndPhone=()=>new Promise(resolve=>{release=resolve;});
   const pending=f.transport.recoverParticipantMessage(f.client,group,f.request());
   while(!release)await new Promise(resolve=>setImmediate(resolve));
   if(action==='expiry')f.setNow(Date.parse(f.grant.expiresAt)+1);else f.revoke();
   release([{lid,pn:phone}]);await assert.rejects(pending,/denied|expired/);
   for(const table of ['group_input','group_input_author','group_input_participant_recovery'])
    assert.equal(f.inbox.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  });
 }
});

test('relay refuses unadmitted historical input after grant expiry',async t=>{
 const f=pipeline(t);await f.transport.recoverParticipantMessage(f.client,group,f.request());
 f.setNow(Date.parse(f.grant.expiresAt)+1);
 assert.deepEqual((await f.relay.tick()).errors,['group_participant_binding_denied']);assert.equal(f.state.posts.length,0);
});

test('already admitted recovery completes after expiry using exact routed receipt, with current member policy',async t=>{
 const f=pipeline(t);await f.transport.recoverParticipantMessage(f.client,group,f.request());
 await f.relay.tick();assert.equal(f.state.posts.length,1);
 f.setNow(Date.parse(f.grant.expiresAt)+1);f.revoke();
 f.state.answers=[{id:'answer',parentMessageId:'routed-message',role:'assistant',state:'completed',phase:'final_answer',text:'A scoped reply'}];
 const status=await f.relay.tick();assert.equal(status.completed,1);assert.equal(f.state.sends.length,1);assert.equal(f.state.posts.length,1);
});

test('removing membership still denies completion after a recovery was admitted',async t=>{
 const f=pipeline(t);await f.transport.recoverParticipantMessage(f.client,group,f.request());await f.relay.tick();
 f.state.member=false;f.setNow(Date.parse(f.grant.expiresAt)+1);
 f.state.answers=[{id:'answer',parentMessageId:'routed-message',role:'assistant',state:'completed',phase:'final_answer',text:'Not sent'}];
 assert.deepEqual((await f.relay.tick()).errors,['group_participant_binding_denied']);assert.equal(f.state.sends.length,0);
});

test('grant config preflight is closed and pure; no Root file or journal is opened',t=>{
 const f=fixture(t);validateScopedGroupConfig(f.config);
 const cfg=JSON.stringify(f.config),result=preflightScopedGroupConfigs(['/fixture.json'],{readFile:()=>cfg});assert.equal(result.ok,true);
 for(const ref of [{...f.config.participantRecoveryGrant,allowOld:true},{path:'relative',sha256:'a'.repeat(64)},
  {path:'/safe/grant',sha256:'bad'},{path:'/safe/../grant',sha256:'a'.repeat(64)}])
  assert.throws(()=>validateParticipantRecoveryReference({...f.config,participantRecoveryGrant:ref}),/denied/);
});

test('real grant reader refuses unprotected, aliased, replaced or hardlinked authority', {skip:process.getuid()!==0},t=>{
 const dir=fs.mkdtempSync('/run/participant-grant-test-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'grant.json'),raw=JSON.stringify({fixture:'no-secret'});fs.writeFileSync(file,raw,{mode:0o400});
 const ref={path:file,sha256:hash(raw)};assert.deepEqual(readProtectedParticipantGrant(ref),{fixture:'no-secret'});
 fs.chmodSync(file,0o600);assert.throws(()=>readProtectedParticipantGrant(ref),/denied/);fs.chmodSync(file,0o400);
 fs.linkSync(file,path.join(dir,'alias'));assert.throws(()=>readProtectedParticipantGrant(ref),/denied/);fs.unlinkSync(path.join(dir,'alias'));
 fs.symlinkSync(file,path.join(dir,'link'));assert.throws(()=>readProtectedParticipantGrant({...ref,path:path.join(dir,'link')}),/denied/);
 fs.writeFileSync(file,'changed',{mode:0o400});assert.throws(()=>readProtectedParticipantGrant(ref),/denied/);
});

test('authenticated scoped HTTP port dispatches exact recovery only; no legacy or owner-flag fallback', {skip:process.getuid()!==0},async t=>{
 const f=fixture(t),dir=fs.mkdtempSync('/run/participant-http-test-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'grant.json'),raw=JSON.stringify(f.grant);fs.writeFileSync(file,raw,{mode:0o400});
 const config={...f.config,routeControl:{threadIds:['thread-a'],routeId:'fixture',dbPath:path.join(dir,'not-opened.sqlite')},
  participantRecoveryGrant:{path:file,sha256:hash(raw)}};
 // Use future real wall time for this filesystem/HTTP fixture only.
 const grant={...f.grant,expiresAt:new Date(Date.now()+60000).toISOString()};
 fs.writeFileSync(file,JSON.stringify(grant));config.participantRecoveryGrant.sha256=hash(JSON.stringify(grant));
 const cfg=path.join(dir,'config.json');fs.writeFileSync(cfg,JSON.stringify(config),{mode:0o600});
 const {createOrkestrWaService}=await import('../scripts/orkestr-wa-service.mjs');
 const calls=[];const server=createOrkestrWaService({env:{ORKESTR_WA_SCOPED_GROUP_CONFIG:cfg,
  ORKESTR_WHATSAPP_ACCOUNT_IDS:'sender',ORKESTR_WA_SERVICE_TOKEN:'fixture-only-token'},bridge:{
   recoverLocalWhatsAppScopedParticipantMessage:async p=>{calls.push(p);return {ok:true,receipt:{messageId:p.request.messageId}};},
   recoverLocalWhatsAppChatMessages:async()=>{throw Error('legacy recovery must not run');},
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/accounts/sender/chats/${encodeURIComponent(group)}/recover-participant-message`;
 const call=async(body,auth=true)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer fixture-only-token'}:{})},body:JSON.stringify(body)});
 assert.equal((await call(f.request(),false)).status,401);assert.equal(calls.length,0);
 assert.equal((await call(f.request({originOwner:true}))).status,403);assert.equal(calls.length,0);
 const response=await call(f.request());assert.equal(response.status,200);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].request,f.request());assert.equal(calls[0].accountId,'sender');assert.equal(calls[0].chatId,group);
 assert.equal(fs.existsSync(config.routeControl.dbPath),false,'policy validation did not create a route journal');
});
