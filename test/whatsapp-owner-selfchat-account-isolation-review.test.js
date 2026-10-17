import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThread } from '../packages/core/src/threads.js';
import { writeJson } from '../packages/storage/src/store.js';
import { dataPaths } from '../packages/storage/src/paths.js';
import { planOwnerSelfChatRegistration } from '../packages/connectors/src/whatsapp-owner-selfchat-registration.js';
import { selfChatBindingAccountKeys } from '../packages/connectors/src/whatsapp-owner-selfchat-binding-accounts.js';
import { isDedicatedOwnerSelfChatOutput } from '../packages/connectors/src/whatsapp-owner-selfchat-scope.js';

const accountId='example-personal',chatId='15550000001@c.us';
const conflictingAliases=[
  {targetAccountId:'old-account',accountId},
  {responderConnectorAccountId:'old-account',outboundAccountId:accountId},
  {responderConnectorAccountId:'old-account',responderAccountId:accountId},
  {senderAccountId:'old-account',inboundAccountId:accountId},
  {bridgeAccountId:'old-account',receivingAccountId:accountId},
  {replyAccountId:'old-account',runtimeAccountId:accountId},
];

test('independent registration review rejects hidden overlap in every account alias group',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'selfchat-account-review-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('network forbidden');});
  const env={ORKESTR_HOME:root,ORKESTR_ADMIN_USER_ID:'admin',
    ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify({enabled:true,ownerUserId:'admin',accountId,chatId,
      threadIds:['home'],homeThreadId:'home',transport:'owner-selfchat-socket',
      socketPath:path.join(root,'mock.sock'),activatedAt:new Date().toISOString()})};
  await createThread({id:'home',ownerUserId:'admin',executorId:'noop'},env);
  for(const aliases of conflictingAliases) {
    await writeJson(dataPaths(env).whatsapp,{bindings:[{id:'legacy-contact',chatId,enabled:true,...aliases}]});
    await assert.rejects(planOwnerSelfChatRegistration(env),/chat_already_bound/,JSON.stringify(Object.keys(aliases)));
  }
  await writeJson(dataPaths(env).whatsapp,{bindings:[{id:'legacy-contact',chatId,enabled:true,
    accountId:'old-account',senderAccountId:'old-account',responderConnectorAccountId:'old-account'}]});
  assert.equal((await planOwnerSelfChatRegistration(env)).binding.accountId,accountId);
});

test('independent retired-output fence review retains hidden aliases and permits proven distinct account',()=>{
  for(const aliases of conflictingAliases) {
    const state={bindings:[{id:`owner-selfchat:${accountId}`,privateOwnerChat:true,chatId,retired:true,enabled:false,...aliases}]};
    assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId},null,state),true,JSON.stringify(Object.keys(aliases)));
  }
  const state={bindings:[{id:`owner-selfchat:${accountId}`,privateOwnerChat:true,chatId,accountId,enabled:false}]};
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId:'old-account'},null,state),false);
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId},null,state),true);
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId:'old-account'},
    {chatId,accountId,ownerSelfChatDedicatedTransport:true},state),true);
});


test('account helper closes transitive configured aliases and malformed selectors conservatively',()=>{
  const accounts=[
    {accountId:'intermediate',runtimeAccountId:' Legacy '},
    {accountId,runtimeAccountId:'intermediate'},
  ];
  const keys=selfChatBindingAccountKeys({accountId:' LEGACY '},accounts);
  assert.equal(keys.has(accountId),true);
  assert.equal(keys.has('legacy'),true);
  assert.equal(selfChatBindingAccountKeys({accountId:'old-account'},accounts).has(accountId),false);
  for(const invalid of [{accountId:7},{accountId:'old-account',runtimeAccountId:{}},
    {accountIds:'old-account'},{accountIds:['old-account',false]}])
    assert.equal(selfChatBindingAccountKeys(invalid,accounts).size,0);
  const state={connectorAccounts:accounts,bindings:[{id:`owner-selfchat:${accountId}`,
    privateOwnerChat:true,chatId,accountId,retired:true,enabled:false}]};
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId:' LEGACY '},null,state),true);
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId:7},null,state),true);
  assert.equal(isDedicatedOwnerSelfChatOutput({chatId,accountId:'old-account'},null,state),false);
});
