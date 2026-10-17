import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OwnerSelfChatJournal } from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import { verifyOwnerSelfChatIdentity } from '../packages/connectors/src/whatsapp-owner-selfchat-identity.js';
import { createOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-adapter.js';
import { listenOwnerSelfChatAdapter,ownerSelfChatSocketRequest } from '../packages/connectors/src/whatsapp-owner-selfchat-socket.js';
import { ownerSelfChatTransportContract } from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';

const chatId='15550000001@c.us';
const config={bridgeBuildHash:'b'.repeat(64),enabled:true,eligible:true,accountId:'example-personal',chatId,
  activatedAt:'2026-01-01T12:00:00Z',threadIds:['home'],
  verifiedSendPolicy:{runtimeId:'example.service:42',attempts:1,textOnly:true,maxTextLength:3000}};
const identity={accountId:config.accountId,chatId,runtimeId:'example.service:42',proofId:'proof'};
const message={id:'owner-1',from:chatId,to:chatId,fromMe:true,body:'hello',timestamp:'2026-01-01T12:01:00Z'};
const status={state:'ready',ready:true,authenticated:true,ownerSelfChatPolicy:{buildHash:'b'.repeat(64),version:1,transportOnly:true,sendAttempts:1,textOnly:true,maxTextLength:3000,markSeen:false,automaticRouting:false,strictBearer:true}};
async function fixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'self-adapter-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const filename=path.join(root,'journal.sqlite');
  const journal=new OwnerSelfChatJournal(filename,config);
  t.after(()=>journal.close());journal.setMeta('identity',identity);
  const calls=[];
  const invoke=async argv=>{
    calls.push(argv);
    if(argv[0]==='status') return options.status || status;
    if(argv[0]==='history') return {ok:true,chatId,messages:options.messages || [message]};
    return options.send ? options.send(argv) : {ok:true,ids:['agent-1']};
  };
  const adapter=createOwnerSelfChatAdapter({config,journal,invoke,preflight:async()=>options.runtimeId || identity.runtimeId});
  const request=body=>adapter.request({accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config),...body});
  const offer=async()=>{await request({operation:'history',mark_seen:false,limit:50});await request({operation:'ack',id:message.id,threadId:'home',messageId:'parent'});};
  const send={operation:'send_text',threadId:'home',parentMessageId:'parent',requestId:'reply:1',text:'response'};
  return {root,filename,journal,calls,adapter,request,offer,send};
}

test('fresh self-chat identity requires actual matching own-message evidence',()=>{
  const nonce='a'.repeat(32),now=Date.parse('2026-01-01T12:03:00Z');
  const args={config,status,runtimeId:identity.runtimeId,nonce,issuedAt:'2026-01-01T12:00:00Z',now,
    history:{ok:true,chatId,messages:[{...message,body:`orkestr-selfchat-verify ${nonce}`}]} };
  assert.equal(verifyOwnerSelfChatIdentity(args).proofId,message.id);
  for(const override of [{status:{...status,ready:false}},{runtimeId:''},{now:now+900000},
    {history:{...args.history,messages:[{...args.history.messages[0],fromMe:false}]}},
    {history:{...args.history,messages:[{...args.history.messages[0],to:'someone-else'}]}},
    {history:{...args.history,messages:[{...args.history.messages[0],id:'summary:fake'}]}}]) {
    assert.throws(()=>verifyOwnerSelfChatIdentity({...args,...override}),/selfchat_/);
  }
});

test('different runtime PID invalidates identity without status, history or sends',async t=>{
  const f=await fixture(t,{runtimeId:'example.service:43'});
  await assert.rejects(f.request({operation:'health'}),/identity_or_eligibility/);
  assert.equal(f.calls.length,0);
});

test('concurrent duplicate attempts dispatch once and receipt survives reopen',async t=>{
  const f=await fixture(t);await f.offer();
  const results=await Promise.all([f.request(f.send),f.request(f.send)]);
  assert.deepEqual(results.map(r=>r.duplicate || false),[false,true]);
  assert.equal(f.calls.filter(c=>c[0]==='send-text').length,1);
  const reopened=new OwnerSelfChatJournal(f.filename,config);
  assert.deepEqual(reopened.outboundIds(),['agent-1']);reopened.close();
  await assert.rejects(f.request({...f.send,text:'changed'}),/request_id_conflict/);
});

test('RPC failure leaves uncertainty across restart; no replay and no echo ingestion',async t=>{
  const f=await fixture(t,{send:async()=>{throw new Error('secret provider text');}});await f.offer();
  await assert.rejects(f.request(f.send),error=>error.message==='selfchat_delivery_uncertain');
  await assert.rejects(f.request(f.send),/delivery_uncertain/);
  await assert.rejects(f.request({operation:'history',mark_seen:false}),/delivery_uncertain/);
  const reopened=new OwnerSelfChatJournal(f.filename,config);
  assert.equal(reopened.unresolved(),true);reopened.close();
  assert.equal(f.calls.filter(c=>c[0]==='send-text').length,1);
});

test('missing receipt is uncertain and pre-dispatch crash reservation is never retried',async t=>{
  const f=await fixture(t,{send:async()=>({ok:true,ids:[]})});await f.offer();
  await assert.rejects(f.request(f.send),/delivery_uncertain/);
  assert.equal(f.journal.unresolved(),true);
  const j=new OwnerSelfChatJournal(':memory:',{});
  j.reserve('attempt',{});
  assert.throws(()=>j.reserve('attempt',{}),/delivery_uncertain/);j.close();
});

test('owner input survives failed acknowledgement and consumed input does not reappear',async t=>{
  const f=await fixture(t);
  const req={operation:'history',mark_seen:false,limit:50};
  assert.equal((await f.request(req)).messages.length,1);
  assert.equal((await f.request(req)).messages.length,1);
  await f.offer();assert.equal((await f.request(req)).messages.length,0);
  await assert.rejects(f.request({operation:'ack',id:message.id,threadId:'home',messageId:'different'}),/route_conflict/);
});

test('unsupported operations, wrong recipient, thread and unproven parent fail closed',async t=>{
  const f=await fixture(t);
  for(const req of [{operation:'messages'},{...f.send,chatId:'15550000002@c.us'},
    {...f.send,threadId:'other'},{...f.send},{operation:'history',mark_seen:true}])
    await assert.rejects(f.request(req),/scope_denied|thread_denied|parent_required/);
  assert.equal(f.calls.filter(c=>c[0]==='send-text').length,0);
});

test('bounded history overflow is reported instead of silently dropping messages',async t=>{
  const f=await fixture(t,{messages:Array.from({length:50},(_,i)=>({...message,id:`m-${i}`}))});
  await assert.rejects(f.request({operation:'history',mark_seen:false,limit:50}),/history_gap/);
});

test('SQLite identity namespace rejects switching the account or activation cutoff',async t=>{
  const f=await fixture(t);
  assert.throws(()=>new OwnerSelfChatJournal(f.filename,{...config,accountId:'other'}),/binding_changed/);
});

test('Unix socket exercises account-specific transport with a mock wrapper only',async t=>{
  const f=await fixture(t);const socketPath=path.join(f.root,'transport.sock');
  const server=await listenOwnerSelfChatAdapter({socketPath,adapter:f.adapter,mode:0o600});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await ownerSelfChatSocketRequest(socketPath,{accountId:config.accountId,chatId,operation:'health',contract:ownerSelfChatTransportContract(config)});
  assert.equal(result.ready,true);
  await assert.rejects(ownerSelfChatSocketRequest(socketPath,{accountId:'other',chatId,operation:'health'}),/scope_denied/);
});

test('sending is blocked when the underlying bridge retry/text-only policy is unverified',async t=>{
  const f=await fixture(t);await f.offer();
  const adapter=createOwnerSelfChatAdapter({config:{...config,verifiedSendPolicy:null},journal:f.journal,
    preflight:async()=>identity.runtimeId,invoke:async args=>{assert.equal(args[0],'status');return status;}});
  await assert.rejects(adapter.request({...f.send,accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config)}),/provider_send_policy_unverified/);
  assert.equal(f.journal.unresolved(),false,'policy refusal happens before send reservation');
});

test('client allowlist or suppression exception mismatch is denied before invoking the bridge',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.request({operation:'history',mark_seen:false,
    contract:ownerSelfChatTransportContract({...config,threadIds:['home','other']})}),/scope_denied/);
  await assert.rejects(f.request({operation:'history',mark_seen:false,
    contract:ownerSelfChatTransportContract({...config,allowSuppressedThreadReplies:true})}),/scope_denied/);
  assert.equal(f.calls.length,0);
});

test('closing while readiness preflight is pending blocks dispatch and queued sends',async t=>{
  const f=await fixture(t);await f.offer();
  let release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});const operations=[];
  const adapter=createOwnerSelfChatAdapter({config,journal:f.journal,
    preflight:async()=>{entered();await gate;return identity.runtimeId;},
    invoke:async args=>{operations.push(args[0]);return status;}});
  const body={...f.send,accountId:config.accountId,chatId,contract:ownerSelfChatTransportContract(config)};
  const first=assert.rejects(adapter.request(body),/adapter_closed/);
  await waiting;
  const queued=assert.rejects(adapter.request({...body,requestId:'reply:2'}),/adapter_closed/);
  adapter.close();release();await Promise.all([first,queued]);
  assert.equal(operations.includes('send-text'),false);assert.equal(f.journal.unresolved(),false);
});

test('close after provider dispatch retains accepted receipt and blocks queued sends',async t=>{
  let release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{send:async()=>{entered();await gate;return {ok:true,ids:['accepted-before-close']};}});
  await f.offer();
  const first=f.request(f.send);await waiting;
  const queued=assert.rejects(f.request({...f.send,requestId:'reply:2'}),/adapter_closed/);
  f.adapter.close();release();assert.deepEqual((await first).ids,['accepted-before-close']);await queued;
  assert.deepEqual(f.journal.outboundIds(),['accepted-before-close']);assert.equal(f.journal.unresolved(),false);
  assert.equal(f.calls.filter(args=>args[0]==='send-text').length,1);
});


test('operator send attestation cannot substitute for effective transport-only policy',async t=>{
  for(const override of [null,{...status.ownerSelfChatPolicy,sendAttempts:2},
    {...status.ownerSelfChatPolicy,automaticRouting:true},{...status.ownerSelfChatPolicy,strictBearer:false},
    {...status.ownerSelfChatPolicy,markSeen:true},{...status.ownerSelfChatPolicy,textOnly:false},
    {...status.ownerSelfChatPolicy,buildHash:'c'.repeat(64)},
    {...status.ownerSelfChatPolicy,buildHash:undefined}]) {
    const f=await fixture(t,{status:{...status,ownerSelfChatPolicy:override}});
    await assert.rejects(f.request({operation:'history',mark_seen:false}),/live_bridge_policy_unverified/);
    assert.deepEqual(f.calls.map(args=>args[0]),['status']);
    assert.equal(f.journal.unresolved(),false);
  }
});

test('pilot send cap survives reopening and returns old receipt without a new attempt',async t=>{
 const f=await fixture(t);
 const j=f.journal;
 j.reserve('pilot:1',{text:'one'},2);j.sent('pilot:1',['first-id']);
 j.reserve('pilot:2',{text:'two'},2);j.sent('pilot:2',['second-id']);
 const reopened=new OwnerSelfChatJournal(f.filename,config);
 assert.deepEqual(reopened.reserve('pilot:1',{text:'one'},2),{duplicate:true,ids:['first-id']});
 assert.throws(()=>reopened.reserve('pilot:3',{text:'three'},2),/send_limit_reached/);
 assert.equal(reopened.outboundIds().length,2);reopened.close();
});
