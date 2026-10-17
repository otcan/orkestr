import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThread,getThread,listThreadMessages,appendThreadMessage } from '../packages/core/src/threads.js';
import { writeConnectorConfig } from '../packages/storage/src/config.js';
import { readJson,writeJson } from '../packages/storage/src/store.js';
import { dataPaths } from '../packages/storage/src/paths.js';
import { OwnerSelfChatJournal } from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import { createOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-adapter.js';
import { listenOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-socket.js';
import { createOwnerSelfChatPump } from '../packages/connectors/src/whatsapp-owner-selfchat-pump.js';
import { ownerSelfChatScope } from '../packages/connectors/src/whatsapp-owner-selfchat-scope.js';
import { ownerSelfChatClient } from '../packages/connectors/src/whatsapp-owner-selfchat-client.js';
import { planOwnerSelfChatRegistration,applyOwnerSelfChatRegistration,retireOwnerSelfChatRegistration } from '../packages/connectors/src/whatsapp-owner-selfchat-registration.js';
import { routeWhatsAppInbound,deliverWhatsAppReplies } from '../packages/connectors/src/whatsapp.js';

async function fixture(t,{exception=true,threads=['home','project']}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'self-pump-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const socketPath=path.join(root,'bridge.sock'),chatId='15550000001@c.us';
  const config={enabled:true,eligible:true,ownerUserId:'admin',accountId:'example-personal',chatId,
    socketPath,homeThreadId:'home',threadIds:threads,transport:'owner-selfchat-socket',
    allowSuppressedThreadReplies:exception,activatedAt:new Date(Date.now()-10000).toISOString(),
    verifiedSendPolicy:{runtimeId:'example:42',attempts:1,textOnly:true,maxTextLength:3000}};
  const env={ORKESTR_HOME:root,ORKESTR_ADMIN_USER_ID:'admin',ORKESTR_CONNECTOR_OUTBOX_STORE:'json',
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN:'0',ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify(config)};
  for(const id of ['home','project','unlisted']) await createThread({id,name:id,ownerUserId:'admin',executorId:'noop',
    binding:{connector:'whatsapp',chatId:`${id}-original@g.us`,enabled:true,
      senderAccountId:'old-account',responderAccountId:'old-account',mirrorToWhatsApp:false,suppressWhatsAppUpdates:true}},env);
  const bindings=Object.fromEntries(await Promise.all(['home','project','unlisted'].map(async id=>[id,(await getThread(id,env)).binding])));
  // Even a legacy catch-all must not override supplemental self-chat selection.
  await writeConnectorConfig('whatsapp',{defaultThreadId:'unlisted',bridgeMode:'external',bridgeUrl:'http://unused.invalid'},env);
  const journal=new OwnerSelfChatJournal(path.join(root,'journal.sqlite'),config);
  journal.setMeta('identity',{accountId:config.accountId,chatId,runtimeId:'example:42',proofId:'proof'});
  const inbox=[],sent=[];
  const adapter=createOwnerSelfChatAdapter({config,journal,preflight:async()=>'example:42',invoke:async args=>{
    if(args[0]==='status') return {state:'ready',ready:true,authenticated:true};
    if(args[0]==='history') return {ok:true,chatId,messages:inbox};
    assert.equal(args[0],'send-text');assert.equal(args[1],chatId);
    const id=`agent-${sent.length+1}`;sent.push({id,text:args[2]});
    inbox.push({id,body:args[2],from:chatId,to:chatId,fromMe:true,timestamp:new Date().toISOString()});
    return {ok:true,ids:[id]};
  }});
  const server=await listenOwnerSelfChatAdapter({socketPath,adapter,mode:0o600});
  t.after(()=>new Promise(resolve=>server.close(()=>{journal.close();resolve();})));
  await applyOwnerSelfChatRegistration(await planOwnerSelfChatRegistration(env),env,{approved:true});
  // Any unexpected provider HTTP path is a test failure; only local mock socket is permitted.
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('unexpected live network');});
  const tick=createOwnerSelfChatPump({env,routeInbound:routeWhatsAppInbound});
  let sequence=0;
  const input=body=>inbox.push({id:`owner-${++sequence}`,body,from:chatId,to:chatId,fromMe:true,timestamp:new Date().toISOString()});
  return {env,config,bindings,journal,inbox,sent,tick,input};
}

test('mock end-to-end: existing threads, replies, loop prevention and original groups preserved',async t=>{
  const f=await fixture(t);
  f.input('/threads');await f.tick();
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/project/);assert.doesNotMatch(f.sent[0].text,/unlisted/);
  f.input('@project continue');await f.tick();
  const parent=(await listThreadMessages('project',f.env)).find(m=>m.role==='user');
  assert.ok(parent);assert.equal(parent.ownerSelfChatDedicatedTransport,true);
  await appendThreadMessage('project',{role:'assistant',phase:'final_answer',state:'completed',text:'Project answer',parentMessageId:parent.id},f.env);
  await f.tick();await f.tick();
  assert.equal(f.sent.filter(m=>m.text.includes('Project answer')).length,1);
  assert.equal((await listThreadMessages('project',f.env)).filter(m=>m.role==='user').length,1);
  for(const [id,binding] of Object.entries(f.bindings)) assert.deepEqual((await getThread(id,f.env)).binding,binding);
  // General mirror must not deliver dedicated inputs, even if its scope is absent.
  const withoutScope={...f.env};delete withoutScope.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE;
  const result=await deliverWhatsAppReplies(withoutScope,async()=>{throw new Error('wrong transport');},{fresh:true});
  assert.equal(result.delivered.length,0);assert.equal(result.failed.length,0);
});

test('pilot lists home only and rejects other existing threads without creating new ones',async t=>{
  const f=await fixture(t,{threads:['home']});f.input('@project forbidden');await f.tick();
  assert.equal((await listThreadMessages('project',f.env)).length,0);
  assert.match(f.sent[0].text,/No thread called/);
});

test('suppressed home replies require the explicit per-scope exception',async t=>{
  const f=await fixture(t,{exception:false});f.input('/threads');await f.tick();assert.equal(f.sent.length,0);
  assert.equal((await getThread('home',f.env)).binding.mirrorToWhatsApp,false);
});

test('scope revocation stops private pump rather than falling back to any sender',async t=>{
  const f=await fixture(t);f.input('/threads');delete f.env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE;
  await assert.rejects(f.tick(),/scope_changed/);assert.equal(f.sent.length,0);
});

test('registration is approval gated, detects stale plan and preserves campaign records on retire',async t=>{
  const f=await fixture(t),plan=await planOwnerSelfChatRegistration(f.env);
  await assert.rejects(applyOwnerSelfChatRegistration(plan,f.env),/approval_required/);
  const paths=dataPaths(f.env),state=await readJson(paths.whatsapp,{});
  state.outboundDeliveries=[{messageId:'already-sent'}];state.campaigns=[{state:'cancelled'}];state.uncertain=[{id:'pending-evidence'}];
  await writeJson(paths.whatsapp,state);
  await assert.rejects(applyOwnerSelfChatRegistration(plan,f.env,{approved:true}),/plan_stale/);
  await retireOwnerSelfChatRegistration(f.env,{approved:true});
  const after=await readJson(paths.whatsapp,{});
  assert.deepEqual(after.outboundDeliveries,state.outboundDeliveries);assert.deepEqual(after.campaigns,state.campaigns);assert.deepEqual(after.uncertain,state.uncertain);
  assert.equal(after.bindings.find(b=>b.id==='owner-selfchat:example-personal').enabled,false);
});

test('registration refuses a different owner thread and conflicting account identity',async t=>{
  const f=await fixture(t),scope=ownerSelfChatScope(f.env);
  f.env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE=JSON.stringify({...scope,enabled:true,ownerUserId:'different'});
  await assert.rejects(planOwnerSelfChatRegistration(f.env),/thread_invalid/);
  f.env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE=JSON.stringify(f.config);
  const paths=dataPaths(f.env),state=await readJson(paths.whatsapp,{});
  state.connectorAccounts[0].sessionRef='other-connector';await writeJson(paths.whatsapp,state);
  await assert.rejects(planOwnerSelfChatRegistration(f.env),/account_conflict/);
});

test('revocation mid-batch prevents the next input and preserves its pending journal entry',async t=>{
  const f=await fixture(t);f.input('first');f.input('second');let active=true;
  const tick=createOwnerSelfChatPump({env:f.env,
    assertActive:async()=>{if(!active) throw new Error('selfchat_scope_changed');},
    routeInbound:async(...args)=>{const result=await routeWhatsAppInbound(...args);active=false;return result;}});
  await assert.rejects(tick(),/scope_changed/);
  assert.equal((await listThreadMessages('home',f.env)).filter(m=>m.role==='user').length,1);
  assert.equal(f.journal.pending().length,1);assert.equal(f.sent.length,0);
});

test('revocation after one chunk prevents later chunks without losing its receipt',async t=>{
  const f=await fixture(t);f.input('hello');await f.tick();
  const parent=(await listThreadMessages('home',f.env)).find(m=>m.role==='user');
  await appendThreadMessage('home',{role:'assistant',phase:'final_answer',state:'completed',text:'x'.repeat(6000),parentMessageId:parent.id},f.env);
  const base=ownerSelfChatClient(f.env);let active=true;
  const tick=createOwnerSelfChatPump({env:f.env,routeInbound:routeWhatsAppInbound,
    assertActive:async()=>{if(!active) throw new Error('selfchat_scope_changed');},
    client:{scope:base.scope,call:async request=>{const result=await base.call(request);if(request.operation==='send_text')active=false;return result;}}});
  await assert.rejects(tick(),/scope_changed/);
  assert.equal(f.sent.length,1);assert.deepEqual(f.journal.outboundIds(),['agent-1']);
  assert.equal(f.journal.unresolved(),false);
});
