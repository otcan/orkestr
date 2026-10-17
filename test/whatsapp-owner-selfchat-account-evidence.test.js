import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectOwnerSelfChatAccountEvidence} from '../packages/connectors/src/whatsapp-owner-selfchat-account-evidence.js';
import {verifyLiveOwnerSelfChatAccount} from '../packages/connectors/src/whatsapp-owner-selfchat-live-verification.js';
import {OwnerSelfChatJournal} from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import {assertOwnerSelfChatIdentity} from '../packages/connectors/src/whatsapp-owner-selfchat-identity.js';
import {ownerSelfChatTransportContract} from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';
const chatId='15550000001@c.us',lid='123456@lid',runtimeId='example.service:42:invocation',nonce='a'.repeat(32);
const policy={buildHash:'b'.repeat(64),version:1,transportOnly:true,sendAttempts:1,textOnly:true,maxTextLength:3000,markSeen:false,automaticRouting:false,strictBearer:true};
function context(t,{filename=':memory:'}={}) {
 const now=Date.now(),config={enabled:true,eligible:true,identityVerificationMode:'live-account',ownerUserId:'example-owner',accountId:'example-account',chatId,homeThreadId:'home',threadIds:['home'],socketPath:'/example/socket',activatedAt:new Date(now-60000).toISOString(),bridgeBuildHash:policy.buildHash};
 config.liveAccountAttestation={version:2,approved:true,approvalRef:'example-owner-consent',approvedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),ownerUserId:config.ownerUserId,accountId:config.accountId,chatId,runtimeId,bridgeBuildHash:config.bridgeBuildHash,transportContract:ownerSelfChatTransportContract(config),allowVerifiedOwnIdAliases:true};
 const journal=new OwnerSelfChatJournal(filename,{});t.after(()=>journal.close());
 const evidence=challenge=>({ok:true,version:1,challenge,checkedAt:new Date(now).toISOString(),authenticated:true,ready:true,state:'ready',ownChatId:chatId,ownLid:lid,mappingSource:'whatsapp-sdk-bidirectional',serverRefreshVerified:false,ownerSelfChatPolicy:policy});
 const runner={preflight:async()=>runtimeId,invoke:async args=>{assert.deepEqual(args,['identity',nonce]);return evidence(args[1]);}};
 return {config,journal,evidence,runner,now};
}
test('collector reads only configured own PN and its SDK-provided LID, checking both directions',async()=>{
 const calls=[],client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async ids=>{calls.push(ids);return [{pn:chatId,lid}];}};
 const result=await collectOwnerSelfChatAccountEvidence({client,chatId,challenge:nonce,policy,isReady:()=>true});
 assert.deepEqual(calls,[[chatId],[lid]]);assert.equal(result.ownChatId,chatId);assert.equal(result.ownLid,lid);
 assert.equal(result.serverRefreshVerified,false);assert.equal(result.challenge,nonce);
});
test('collector rejects missing/ambiguous/wrong forward or reverse maps and sanitizes SDK failures',async()=>{
 const cases=[[],[{pn:'15550000002@c.us',lid}],[{pn:chatId,lid:'bad'}],[{pn:chatId,lid},{pn:chatId,lid}],null];
 for(const forward of cases){
  let calls=0;const client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async()=>{calls++;return forward;}};
  await assert.rejects(collectOwnerSelfChatAccountEvidence({client,chatId,challenge:nonce,policy,isReady:()=>true}),/evidence_unavailable/);assert.equal(calls,1);
 }
 for(const reverse of [[],[{pn:'15550000002@c.us',lid}],[{pn:chatId,lid:'654321@lid'}]]){
  let calls=0;const client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async()=>++calls===1?[{pn:chatId,lid}]:reverse};
  await assert.rejects(collectOwnerSelfChatAccountEvidence({client,chatId,challenge:nonce,policy,isReady:()=>true}),/evidence_unavailable/);
 }
 const client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async()=>{throw new Error('SECRET SDK DETAIL');}};
 await assert.rejects(collectOwnerSelfChatAccountEvidence({client,chatId,challenge:nonce,policy,isReady:()=>true}),error=>error.message==='selfchat_account_evidence_unavailable');
});
test('collector rejects identity/readiness changes across either await and malformed challenges',async()=>{
 for(const changedAt of [1,2])for(const changedKind of ['identity','ready']){
  let calls=0,ready=true;const client={info:{wid:{_serialized:chatId}},getContactLidAndPhone:async()=>{
   if(++calls===changedAt){if(changedKind==='identity')client.info.wid._serialized='15550000002@c.us';else ready=false;}return [{pn:chatId,lid}];}};
  await assert.rejects(collectOwnerSelfChatAccountEvidence({client,chatId,challenge:nonce,policy,isReady:()=>ready}),/evidence_unavailable/);
 }
 for(const challenge of ['',[],nonce+'a','x'.repeat(32)])await assert.rejects(collectOwnerSelfChatAccountEvidence({client:{},chatId,challenge,policy,isReady:()=>true}),/evidence_unavailable/);
});
test('fresh verification atomically binds owner, runtime, scope and exact mapping without human proof',async t=>{
 const c=context(t);const identity=await verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce});
 assert.equal(identity.ownerUserId,c.config.ownerUserId);assert.equal(identity.ownLid,lid);assert.equal(identity.humanPresenceVerified,false);
 assert.equal(identity.proofId,undefined);assert.deepEqual(c.journal.meta('identity'),identity);assert.equal(c.journal.meta('pendingIdentityEvidence'),null);
 assertOwnerSelfChatIdentity(c.config,identity,runtimeId,c.now);
 assert.throws(()=>assertOwnerSelfChatIdentity(c.config,identity,runtimeId,c.now+30001),/unverified/);
 await assert.rejects(verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce}),/replayed/);
});
test('mismatched, stale, future, unverified and replayed evidence never writes identity',async t=>{
 const changes=[{challenge:'b'.repeat(32)},{ownChatId:'15550000002@c.us'},{ownLid:'unknown'},
  {mappingSource:'history-inference'},{serverRefreshVerified:true},{version:0},{authenticated:false},
  {ownerSelfChatPolicy:{...policy,buildHash:'c'.repeat(64)}}];
 for(const change of [...changes,'stale','future']){
  const c=context(t);c.runner.invoke=async args=>({...c.evidence(args[1]),...(change==='stale'?{checkedAt:new Date(c.now-30001).toISOString()}:change==='future'?{checkedAt:new Date(c.now+1).toISOString()}:change)});
  await assert.rejects(verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce}),/selfchat_/);
  assert.equal(c.journal.meta('identity'),null);
 }
});
test('wrong owner, expired approval and changed runtime are rejected before acceptance',async t=>{
 for(const change of [{ownerUserId:'someone-else'},{expiresAt:'2020-01-01T00:00:00Z'}]){
  const c=context(t);c.config.liveAccountAttestation={...c.config.liveAccountAttestation,...change};
  c.runner.invoke=async()=>assert.fail('must not call provider for invalid approval');
  await assert.rejects(verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce}),/approval_required/);
 }
 const c=context(t);let n=0;c.runner.preflight=async()=>++n===1?runtimeId:'changed';
 await assert.rejects(verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce}),/runtime_changed/);assert.equal(c.journal.meta('identity'),null);
});
test('consumed challenge remains rejected after journal reopening',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'identity-replay-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'journal.sqlite'),c=context(t,{filename});
 await verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce});
 const second=new OwnerSelfChatJournal(filename,{});t.after(()=>second.close());
 await assert.rejects(verifyLiveOwnerSelfChatAccount({...c,journal:second,now:()=>c.now,createChallenge:()=>nonce}),/replayed/);
});
test('an older concurrent response cannot overwrite a newer accepted identity',async t=>{
 const c=context(t),next='b'.repeat(32);let release,entered;
 const begun=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 c.runner.invoke=async args=>{if(args[1]===nonce){entered();await gate;}return c.evidence(args[1]);};
 const first=verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>nonce});await begun;
 const second=await verifyLiveOwnerSelfChatAccount({...c,now:()=>c.now,createChallenge:()=>next});release();
 await assert.rejects(first,/replayed/);assert.deepEqual(c.journal.meta('identity'),second);
});
