import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThread } from '../packages/core/src/threads.js';
import { whatsappProjectionFields } from '../packages/core/src/codex-app-server-whatsapp.js';
import { whatsappTypingTargetForThread } from '../packages/connectors/src/whatsapp-outbound-mirror.js';
import { routedWhatsAppTypingTarget } from '../packages/connectors/src/whatsapp-router-typing.js';
import { isDedicatedOwnerSelfChatOutput } from '../packages/connectors/src/whatsapp-owner-selfchat-scope.js';
import { startOwnerSelfChatPolling } from '../packages/connectors/src/whatsapp-owner-selfchat-runtime.js';
import { listenOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-socket.js';
import { createOwnerSelfChatWrapper } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper.js';

const chatId='15550000001@c.us';
const thread={id:'home',binding:{connector:'whatsapp',enabled:true,chatId:'ordinary-group@g.us',responderAccountId:'ordinary-account'}};
const ordinary={id:'ordinary',role:'user',source:'whatsapp_inbound',chatId:thread.binding.chatId,state:'running'};
const dedicated={...ordinary,id:'self-input',chatId,accountId:'example-personal',ownerSelfChatDedicatedTransport:true,
  ownerSelfChatRevision:'revision',ownerSelfChatHomeThreadId:'home'};

test('dedicated typing never falls back to an older ordinary group input',()=>{
  const status={state:'working'};
  assert.equal(whatsappTypingTargetForThread({thread,messages:[ordinary,dedicated],status}),null);
  assert.equal(whatsappTypingTargetForThread({thread,messages:[ordinary,{...dedicated,state:'failed'}],status}),null);
  assert.equal(whatsappTypingTargetForThread({thread,messages:[ordinary],status}).accountId,'ordinary-account');
  assert.equal(routedWhatsAppTypingTarget({thread,input:dedicated}),null);
  assert.equal(routedWhatsAppTypingTarget({thread,input:{chatId,ownerSelfChatOrigin:{dedicatedTransport:true}}}),null);
});

test('output projection and retired supplemental binding fence orphan replies after revocation',()=>{
  const projected=whatsappProjectionFields(dedicated,thread);
  assert.equal(projected.ownerSelfChatDedicatedTransport,true);
  assert.equal(projected.ownerSelfChatRevision,'revision');
  assert.equal(isDedicatedOwnerSelfChatOutput(projected,null,{}),true);
  const state={bindings:[{id:'owner-selfchat:example-personal',privateOwnerChat:true,chatId,enabled:false,retired:true}]};
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,connector:'whatsapp'},null,state),true);
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId:thread.binding.chatId},null,state),false);
});

test('runtime rereads protected configuration after history await before routing any input',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'self-review-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const socketPath=path.join(root,'adapter.sock');
  const env={ORKESTR_HOME:root,ORKESTR_OWNER_SELFCHAT_CONFIG:'/mock/protected-config'};
  await createThread({id:'home',name:'home',ownerUserId:'admin',executorId:'noop'},env);
  let config={activationApproved:true,home:root,scope:{enabled:true,ownerUserId:'admin',accountId:'example-personal',
    chatId,homeThreadId:'home',threadIds:['home'],transport:'owner-selfchat-socket',socketPath,activatedAt:'2026-01-01T00:00:00Z'}};
  let routed=0,run;const errors=[];
  const server=await listenOwnerSelfChatAdapter({socketPath,mode:0o600,adapter:{request:async request=>{
    assert.equal(request.operation,'history');
    config={...config,activationApproved:false};
    return {ok:true,messages:[{id:'owner-new',from:chatId,to:chatId,body:'hello',timestamp:'2026-01-01T00:01:00Z'}]};
  }}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  t.mock.method(globalThis,'setInterval',callback=>{run=callback;return {unref(){}};});
  t.mock.method(globalThis,'clearInterval',()=>{});
  const polling=await startOwnerSelfChatPolling(env,{readConfig:async()=>config,
    routeInbound:async()=>{routed++;},onError:error=>errors.push(error.message)});
  assert.equal(polling.enabled,true);await run();
  assert.equal(routed,0);assert.deepEqual(errors,['selfchat_scope_changed']);polling.close();
});

test('wrapper checks cancellation and runtime identity after asynchronous preflight before dispatch',async t=>{
  const invocation='a'.repeat(32);
  // Synthetic root-owned metadata only: never inspect protected live paths.
  t.mock.method(fs,'lstat',async()=>({uid:0,mode:0o100700,size:1,isSymbolicLink:()=>false,isDirectory:()=>true,isFile:()=>true}));
  let active=true,changeDuringPreflight=true;const calls=[];
  const runner=createOwnerSelfChatWrapper({wrapperPath:'/mock/wrapper',implementationPaths:['/mock/source'],
    requiredDirectories:['/mock/state'],requiredFiles:['/mock/existing-token'],existingService:'example.service'},
    async(command,args)=>{calls.push(command);assert.equal(command,'/usr/bin/systemctl');
      if(changeDuringPreflight)active=false;
      return {stdout:`ActiveState=active\nMainPID=42\nInvocationID=${invocation}\n`};});
  await assert.rejects(runner.invoke(['send-text',chatId,'hello'],{runtimeId:`example.service:42:${invocation}`,isActive:()=>active}),/adapter_closed/);
  active=true;changeDuringPreflight=false;
  await assert.rejects(runner.invoke(['send-text',chatId,'hello'],{runtimeId:`example.service:41:${invocation}`}),/runtime_changed/);
  assert.deepEqual(calls,['/usr/bin/systemctl','/usr/bin/systemctl']);
});
