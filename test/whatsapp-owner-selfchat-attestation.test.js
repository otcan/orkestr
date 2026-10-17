import assert from 'node:assert/strict';
import test from 'node:test';
import {attestOwnerSelfChatAccount as attestActual,normalizeAttestedSelfChatHistory} from '../packages/connectors/src/whatsapp-owner-selfchat-attestation.js';
import {assertOwnerSelfChatIdentity} from '../packages/connectors/src/whatsapp-owner-selfchat-identity.js';
import {ownerSelfChatTransportContract,createOwnerSelfChatTransportPolicy} from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';
import {createOwnerSelfChatAdapter} from '../packages/connectors/src/whatsapp-owner-selfchat-adapter.js';
import {OwnerSelfChatJournal} from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
const runtimeId='example.service:42:invocation',chatId='15550000001@c.us',now=Date.now();
const status={authenticated:true,ready:true,state:'ready',ownerSelfChatPolicy:{buildHash:'b'.repeat(64),version:1,transportOnly:true,sendAttempts:1,textOnly:true,maxTextLength:3000,markSeen:false,automaticRouting:false,strictBearer:true}};
function attestOwnerSelfChatAccount(args) {
 const at=args.now ?? Date.now(),challenge='a'.repeat(32),requestedAt=new Date(at).toISOString();
 return attestActual({...args,challenge,requestedAt,evidence:{...args.status,ok:true,version:1,challenge,
  checkedAt:requestedAt,ownChatId:args.config.chatId,ownLid:'123456@lid',
  mappingSource:'whatsapp-sdk-bidirectional',serverRefreshVerified:false}});
}
function fixture(){
 const config={enabled:true,eligible:true,identityVerificationMode:'live-account',accountId:'example-personal',chatId,ownerUserId:'admin',homeThreadId:'home',threadIds:['home'],socketPath:'/example/bridge.sock',activatedAt:'2026-01-01T12:00:00Z',bridgeBuildHash:'b'.repeat(64)};
 config.liveAccountAttestation={version:2,approved:true,ownerUserId:config.ownerUserId,expiresAt:new Date(now+3600000).toISOString(),approvalRef:'example-approval',approvedAt:'2026-01-01T12:00:00Z',runtimeId,accountId:config.accountId,chatId,bridgeBuildHash:config.bridgeBuildHash,transportContract:ownerSelfChatTransportContract(config),readyRequiresConfiguredIdentity:true,allowVerifiedOwnIdAliases:true};
 const identity=attestOwnerSelfChatAccount({config,status,runtimeId,now});
 return {config,identity};
}
test('explicit live account approval records accurate evidence without fabricated message proof',()=>{
 const {config,identity}=fixture();assert.equal(identity.method,'live-account');assert.equal(identity.humanPresenceVerified,false);
 assert.equal(identity.proofId,undefined);assert.equal(identity.challengeHash,undefined);
 assert.doesNotThrow(()=>assertOwnerSelfChatIdentity(config,identity,runtimeId));
 assert.throws(()=>assertOwnerSelfChatIdentity(config,identity,'changed-runtime'),/unverified/);
 assert.throws(()=>assertOwnerSelfChatIdentity({...config,identityVerificationMode:'message-challenge'},identity,runtimeId),/unverified/);
});
test('generic ready status alone, missing approval or changed scope/runtime/build cannot attest',()=>{
 const {config}=fixture();
 for(const change of [{approved:false},{ownerUserId:'wrong-owner'},{runtimeId:'other'},
  {accountId:'other'},{chatId:'15550000002@c.us'},{bridgeBuildHash:'c'.repeat(64)},
  {transportContract:'wrong'},{approvalRef:''},{approvedAt:new Date(now+1000).toISOString()}])
  assert.throws(()=>attestOwnerSelfChatAccount({config:{...config,liveAccountAttestation:{...config.liveAccountAttestation,...change}},status,runtimeId,now}),/approval_required/);
 assert.throws(()=>attestOwnerSelfChatAccount({config:{...config,threadIds:['home','other']},status,runtimeId,now}),/approval_required/);
 assert.throws(()=>attestOwnerSelfChatAccount({config,status:{ready:true,authenticated:true,state:'ready'},runtimeId,now}),/policy_unverified/);
 assert.throws(()=>attestOwnerSelfChatAccount({config,status:{...status,authenticated:false},runtimeId,now}),/not_ready/);
 assert.throws(()=>assertOwnerSelfChatIdentity({...config,liveAccountAttestation:{...config.liveAccountAttestation,approvalRef:'changed'}},fixture().identity,runtimeId),/unverified/);
});
test('LID normalization is opt-in, self-history-only and retains raw sender evidence',()=>{
 const {config,identity}=fixture();
 const message={id:'provider-1',fromMe:true,from:'123456@lid',to:chatId,body:'hello',timestamp:'2026-01-01T12:01:00Z'};
 const payload={ok:true,chatId,messages:[message,{...message,id:'foreign',fromMe:false},
  {...message,id:'other-recipient',to:'15550000002@c.us'}, {...message,id:'lid-recipient',to:'123456@lid'}]};
 const normalized=normalizeAttestedSelfChatHistory({config,identity,payload});
 assert.equal(normalized.messages[0].from,chatId);assert.equal(normalized.messages[0].providerFrom,message.from);
 assert.deepEqual(payload.messages[0],message,'provider history is not mutated');
 const policy=createOwnerSelfChatTransportPolicy({...config,identityVerified:true,verifiedOwnChatId:chatId});
 assert.deepEqual(policy.inbound(normalized.messages,{deliveryUnresolved:false}).map(m=>m.id),['provider-1','lid-recipient']);
 assert.deepEqual(policy.inbound(normalized.messages,{deliveryUnresolved:false,outboundIds:['provider-1','lid-recipient']}),[]);
 assert.deepEqual(policy.inbound(normalized.messages,{deliveryUnresolved:true}),[]);
 assert.throws(()=>normalizeAttestedSelfChatHistory({config,identity,payload:{...payload,chatId:'other'}}),/history_invalid/);
 const disabled={...config,identityVerificationMode:'message-challenge'};
 assert.equal(normalizeAttestedSelfChatHistory({config:disabled,identity,payload}),payload);
});

test('alternative identity cannot claim human presence, borrow nonce evidence or opt into aliases implicitly',()=>{
 const {config,identity}=fixture();
 for(const change of [{humanPresenceVerified:true},{proofId:'invented-proof'},
  {challengeHash:'invented-challenge'},{method:'message-challenge'}])
  assert.throws(()=>assertOwnerSelfChatIdentity(config,{...identity,...change},runtimeId),/unverified/);
 assert.throws(()=>assertOwnerSelfChatIdentity({...config,identityVerificationMode:undefined},identity,runtimeId),/unverified/);
 assert.throws(()=>assertOwnerSelfChatIdentity({...config,identityVerificationMode:'unknown'},identity,runtimeId),/unverified/);
 const noAlias={...config,liveAccountAttestation:{...config.liveAccountAttestation,allowVerifiedOwnIdAliases:false}};
 const noAliasIdentity=attestOwnerSelfChatAccount({config:noAlias,status,runtimeId,now});
 const payload={ok:true,chatId,messages:[{id:'lid',fromMe:true,from:'123456@lid',to:chatId}]};
 assert.equal(normalizeAttestedSelfChatHistory({config:noAlias,identity:noAliasIdentity,payload}),payload);
 assert.throws(()=>normalizeAttestedSelfChatHistory({config:noAlias,identity,payload}),/unverified/);
});

test('live-account adapter preserves raw evidence and durable reply/echo/uncertainty gates',async t=>{
 const {config,identity}=fixture();
 config.verifiedSendPolicy={runtimeId,attempts:1,textOnly:true,maxTextLength:3000};
 const journal=new OwnerSelfChatJournal(':memory:',{accountId:config.accountId,chatId});
 t.after(()=>journal.close());journal.setMeta('identity',identity);
 const own={id:'owner-input',fromMe:true,from:'123456@lid',to:chatId,body:'hello',timestamp:'2026-01-01T12:01:00Z'};
 let rows=[{...own,id:'historical',timestamp:'2025-12-31T12:01:00Z'},own];
 let failSend=false;const calls=[];
 const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>runtimeId,invoke:async args=>{
  calls.push(args[0]);
  if(args[0]==='status')return status;
  if(args[0]==='history')return {ok:true,chatId,messages:rows};
  if(failSend)throw new Error('mock ambiguous dispatch');
  return {ok:true,ids:['agent-output']};
 }});
 const request=body=>adapter.request({accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config),...body});
 const history={operation:'history',mark_seen:false,limit:50};
 const received=(await request(history)).messages;
 assert.deepEqual(received.map(row=>row.id),['owner-input']);
 assert.equal(received[0].providerFrom,own.from);
 assert.equal(journal.pending()[0].ownerSelfChatSenderEvidence,'verified-whatsapp-id-mapping');
 const send={operation:'send_text',threadId:'home',parentMessageId:'parent',requestId:'reply:1',text:'response'};
 await assert.rejects(request(send),/parent_required/);
 await request({operation:'ack',id:own.id,threadId:'home',messageId:'parent'});
 await request(send);await request(send);
 assert.equal(calls.filter(op=>op==='send-text').length,1);
 rows=[own,{...own,id:'agent-output',body:'response'}];
 assert.deepEqual((await request(history)).messages,[],'normalized sent echo and consumed input remain suppressed');
 failSend=true;
 await assert.rejects(request({...send,requestId:'reply:2'}),/delivery_uncertain/);
 const before=calls.length;
 await assert.rejects(request(history),/delivery_uncertain/);
 assert.equal(calls.length,before,'uncertainty blocks history dispatch before aliases are considered');
});

test('live-account adapter refuses changed runtime and policy before reading history',async t=>{
 const {config,identity}=fixture();
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());journal.setMeta('identity',identity);
 for(const badRuntime of [false,true]){
  const calls=[];
  const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>badRuntime?'different-runtime':runtimeId,
   invoke:async args=>{calls.push(args[0]);return {...status,ownerSelfChatPolicy:{...status.ownerSelfChatPolicy,strictBearer:false}};}});
  await assert.rejects(adapter.request({operation:'history',mark_seen:false,accountId:config.accountId,chatId,
   contract:ownerSelfChatTransportContract(config)}),/unverified|approval_required/);
  assert.deepEqual(calls,badRuntime?[]:['status']);
 }
});

test('failed expired-evidence refresh latches closed without repeated SDK reads or sends',async t=>{
 const {config,identity}=fixture();
 const journal=new OwnerSelfChatJournal(':memory:',{});t.after(()=>journal.close());
 journal.setMeta('identity',{...identity,evidenceCheckedAt:new Date(Date.now()-60000).toISOString(),evidenceExpiresAt:new Date(Date.now()-30000).toISOString()});
 const calls=[];
 const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>runtimeId,
  invoke:async args=>{calls.push(args[0]);throw new Error('mock SDK unavailable');}});
 const req={operation:'history',mark_seen:false,accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config)};
 await assert.rejects(adapter.request(req),/refresh_failed/);
 await assert.rejects(adapter.request(req),/refresh_failed/);
 assert.deepEqual(calls,['identity']);assert.deepEqual(journal.outboundIds(),[]);
});
