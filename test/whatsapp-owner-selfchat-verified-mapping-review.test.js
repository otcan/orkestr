import assert from 'node:assert/strict';
import test from 'node:test';
import {collectOwnerSelfChatAccountEvidence} from '../packages/connectors/src/whatsapp-owner-selfchat-account-evidence.js';
import {attestOwnerSelfChatAccount,normalizeAttestedSelfChatHistory} from '../packages/connectors/src/whatsapp-owner-selfchat-attestation.js';
import {verifyLiveOwnerSelfChatAccount} from '../packages/connectors/src/whatsapp-owner-selfchat-live-verification.js';
import {createOwnerSelfChatAdapter} from '../packages/connectors/src/whatsapp-owner-selfchat-adapter.js';
import {OwnerSelfChatJournal} from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import {ownerSelfChatTransportContract,createOwnerSelfChatTransportPolicy} from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';

const chatId='15550000001@c.us',lid='111111@lid',runtimeId='example.service:42:invocation';
const policy={buildHash:'b'.repeat(64),version:1,transportOnly:true,sendAttempts:1,textOnly:true,
 maxTextLength:3000,markSeen:false,automaticRouting:false,strictBearer:true};
const status={authenticated:true,ready:true,state:'ready',ownerSelfChatPolicy:policy};
function fixture(now=Date.now()){
 const config={enabled:true,eligible:true,identityVerificationMode:'live-account',accountId:'example-personal',
  ownerUserId:'owner',chatId,homeThreadId:'home',threadIds:['home'],socketPath:'/example/bridge.sock',
  activatedAt:new Date(now-60000).toISOString(),bridgeBuildHash:policy.buildHash,maxSendAttempts:2,
  verifiedSendPolicy:{runtimeId,attempts:1,textOnly:true,maxTextLength:3000}};
 config.liveAccountAttestation={version:2,approved:true,approvalRef:'example-review',
  approvedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
  ownerUserId:config.ownerUserId,runtimeId,accountId:config.accountId,chatId,bridgeBuildHash:policy.buildHash,
  transportContract:ownerSelfChatTransportContract(config),allowVerifiedOwnIdAliases:true};
 const evidence=challenge=>({...status,ok:true,version:1,challenge,checkedAt:new Date(now).toISOString(),
  ownChatId:chatId,ownLid:lid,mappingSource:'whatsapp-sdk-bidirectional',serverRefreshVerified:false});
 const attest=()=>attestOwnerSelfChatAccount({config,evidence:evidence('a'.repeat(32)),runtimeId,
  challenge:'a'.repeat(32),requestedAt:new Date(now).toISOString(),now});
 return {config,evidence,attest};
}

test('collector rejects account or readiness drift at either SDK await',async()=>{
 for(const changedCall of [1,2])for(const drift of ['account','readiness']){
  let count=0,ready=true;
  const client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async()=>{
   if(++count===changedCall){if(drift==='account')client.info.wid._serialized='15550000002@c.us';else ready=false;}
   return [{pn:chatId,lid}];
  }};
  await assert.rejects(collectOwnerSelfChatAccountEvidence({client,chatId,challenge:'a'.repeat(32),
   policy,isReady:()=>ready}),/account_evidence_unavailable/);
  assert.equal(count,changedCall);
 }
});

test('only the exact proved PN/LID pair normalizes on either side; history cannot introduce aliases',()=>{
 const {config,attest}=fixture();const identity=attest();
 const own={id:'own',fromMe:true,from:lid,to:lid,body:'hello',timestamp:new Date().toISOString()};
 const payload={ok:true,chatId,messages:[own,{...own,id:'other-sender',from:'222222@lid'},
  {...own,id:'other-recipient',to:'222222@lid'},{...own,id:'foreign',fromMe:false},
  {...own,id:'summary:synthetic'},{...own,id:'phone-to-lid',from:chatId},
  {...own,id:'lid-to-phone',to:chatId},{...own,id:'old',timestamp:config.activatedAt}]};
 const normalized=normalizeAttestedSelfChatHistory({config,identity,payload});
 const transport=createOwnerSelfChatTransportPolicy({...config,identityVerified:true,verifiedOwnChatId:chatId});
 assert.deepEqual(transport.inbound(normalized.messages,{deliveryUnresolved:false}).map(m=>m.id),
  ['own','phone-to-lid','lid-to-phone']);
 assert.equal(normalized.messages[0].providerFrom,lid);assert.equal(normalized.messages[0].providerTo,lid);
 assert.equal(payload.messages[0].to,lid,'normalization does not mutate provider evidence');
 assert.deepEqual(transport.command({operation:'send_text',accountId:config.accountId,chatId,text:'reply'}),
  ['send-text',chatId,'reply'],'outbound remains fixed phone-based ID');
 assert.throws(()=>transport.command({operation:'send_text',accountId:config.accountId,chatId:lid,text:'reply'}),/scope_denied/);
});

test('failed refresh cannot replace accepted identity when runtime changes after evidence collection',async t=>{
 const {config,evidence,attest}=fixture();const prior=attest();
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());journal.setMeta('identity',prior);
 let calls=0;
 await assert.rejects(verifyLiveOwnerSelfChatAccount({config,journal,runner:{
  preflight:async()=>++calls===1?runtimeId:'changed-runtime',
  invoke:async args=>evidence(args[1]),
 }}),/runtime_changed/);
 assert.deepEqual(journal.meta('identity'),prior);
 assert.equal(journal.db.prepare("SELECT count(*) AS count FROM identity_evidence WHERE state='consumed'").get().count,0);
});

test('final dispatch guard stops a send if approval expires during wrapper preflight',async t=>{
 const initial=Date.now();let clock=initial;t.mock.method(Date,'now',()=>clock);
 const {config,attest}=fixture(initial);config.liveAccountAttestation.expiresAt=new Date(initial+500).toISOString();
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());journal.setMeta('identity',attest());
 journal.offer([{id:'owner-input'}]);journal.ack('owner-input',{threadId:'home',messageId:'parent'});
 let dispatched=0;
 const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>runtimeId,invoke:async(args,options)=>{
  if(args[0]==='status')return status;
  assert.equal(args[0],'send-text');clock=initial+1000;
  if(!options.isActive())throw new Error('inactive before dispatch');
  dispatched++;return {ok:true,ids:['should-not-send']};
 }});
 await assert.rejects(adapter.request({accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config),
  operation:'send_text',threadId:'home',parentMessageId:'parent',requestId:'pilot:1',text:'reply'}),/delivery_uncertain/);
 assert.equal(dispatched,0);
});

test('revoked eligibility prevents evidence refresh and all connector reads',async t=>{
 const initial=Date.now();let clock=initial;t.mock.method(Date,'now',()=>clock);
 const {config,attest}=fixture(initial);
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());journal.setMeta('identity',attest());
 clock=initial+31000;config.eligible=false;const calls=[];
 const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>runtimeId,
  invoke:async args=>{calls.push(args[0]);throw new Error('unexpected connector lookup');}});
 await assert.rejects(adapter.request({operation:'history',mark_seen:false,accountId:config.accountId,chatId,
  contract:ownerSelfChatTransportContract(config)}));
 assert.deepEqual(calls,[],'eligibility revocation blocks even a read-only identity refresh');
});

test('identity lookup final guard rejects expiry, eligibility revocation or changed approval during preflight',async t=>{
 const initial=Date.now();let clock=initial;t.mock.method(Date,'now',()=>clock);
 for(const reason of ['expiry','eligibility','approval']){
  clock=initial;const {config,evidence}=fixture(initial);
  config.liveAccountAttestation.expiresAt=new Date(initial+500).toISOString();
  const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());let dispatched=0;
  const runner={preflight:async()=>runtimeId,invoke:async(args,options)=>{
   if(reason==='expiry')clock=initial+1000;
   else if(reason==='eligibility')config.eligible=false;
   else config.liveAccountAttestation.approvalRef='changed-approval';
   assert.equal(typeof options.isActive,'function','identity lookup requires an action-time authorization guard');
   if(!options.isActive())throw new Error('inactive before identity dispatch');
   dispatched++;return evidence(args[1]);
  }};
  await assert.rejects(verifyLiveOwnerSelfChatAccount({config,journal,runner}));
  assert.equal(dispatched,0);assert.equal(journal.meta('identity'),null);
 }
});

test('history polling refreshes identity before it expires during the wrapper call',async t=>{
 const initial=Date.now();let clock=initial;t.mock.method(Date,'now',()=>clock);
 const {config,evidence,attest}=fixture(initial);
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());
 journal.setMeta('identity',attest());clock=initial+29940;
 const calls=[];
 const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>runtimeId,
  invoke:async(args,options)=>{
   assert.equal(options.isActive(),true);calls.push(args[0]);
   if(args[0]==='identity')return {...evidence(args[1]),checkedAt:new Date(clock).toISOString()};
   if(args[0]==='status')return status;
   assert.equal(args[0],'history');clock+=200;
   return {ok:true,chatId,messages:[]};
  }});
 const result=await adapter.request({operation:'history',mark_seen:false,limit:50,
  accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config)});
 assert.deepEqual(result,{ok:true,messages:[]});
 assert.deepEqual(calls,['identity','status','history']);
 assert.equal(journal.routes().length,0);
 assert.equal(journal.outboundIds().length,0);
});
