import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createThread, getThread, updateThread, appendThreadMessage, listThreadMessages } from '../packages/core/src/threads.js';
import { bindThreadToPrivateOwnerChat } from '../packages/connectors/src/whatsapp-onboarding-private-chat.js';
import { routeWhatsAppInbound, deliverWhatsAppReplies } from '../packages/connectors/src/whatsapp.js';
import { ownerSelfChatScope, ownerSelfChatReplyRoute } from '../packages/connectors/src/whatsapp-owner-selfchat-scope.js';
import { upsertWhatsAppConnectorAccount } from '../packages/connectors/src/whatsapp-account-registry.js';
import { upsertWhatsAppBindingRecord } from '../packages/connectors/src/whatsapp-binding-registry.js';
import { writeConnectorConfig } from '../packages/storage/src/config.js';
import { dataPaths } from '../packages/storage/src/paths.js';
import { readJson, writeJson } from '../packages/storage/src/store.js';
const self='15550000001@c.us';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'owner-selfchat-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const scope={enabled:true,ownerUserId:'admin',accountId:'personal',chatId:self,homeThreadId:'home',threadIds:['home','project','held','other-owner']};
 const env={ORKESTR_HOME:root,ORKESTR_ADMIN_USER_ID:'admin',ORKESTR_CONNECTOR_OUTBOX_STORE:'json',ORKESTR_WHATSAPP_API_AGENT_AUTORUN:'0',ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify(scope)};
 const h=await createThread({id:'home',name:'home',ownerUserId:'admin',executorId:'noop'},env);
 await bindThreadToPrivateOwnerChat(h,{accountId:'personal',contactId:self,name:'home'},env);
 for(const id of ['project','unlisted','held','other-owner']) await createThread({id,name:id,ownerUserId:id==='other-owner'?'someone-else':'admin',executorId:'noop',binding:{connector:'whatsapp',chatId:`${id}-original@g.us`,enabled:true,mirrorToWhatsApp:id!=='held',senderAccountId:'old-account',responderAccountId:'old-account',outboundAccountId:'old-account'}},env);
 let n=0;
 const send=(text,extra={})=>routeWhatsAppInbound({eventId:`incoming-${++n}`,chatId:self,accountId:'personal',from:self,fromMe:true,text,...extra},env);
 const users=async id=>(await listThreadMessages(id,env)).filter(m=>m.role==='user');
 const sent=[];
 const deliver=async()=>{
  env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED='1';
  await writeConnectorConfig('whatsapp',{bridgeMode:'external',bridgeUrl:'http://bridge.invalid/api/connectors/whatsapp/bridge'},env);
  return deliverWhatsAppReplies(env,async(url,options={})=>{
   if(String(url.pathname||url).endsWith('/send-text')) {
    sent.push(JSON.parse(options.body)); const id=`echo-${sent.length}`;
    return {ok:true,status:200,json:async()=>({ok:true,ids:[id]}),text:async()=>JSON.stringify({ok:true,ids:[id]})};
   }
   return {ok:true,status:200,json:async()=>({ok:true,ready:true,accounts:[{id:'personal',ready:true,state:'ready',contactId:self}]}),text:async()=>'{}'};
  },{fresh:true});
 };
 return {env,send,users,deliver,sent};
}

test('explicit owner scope selects existing grouped threads; other owners and unlisted groups remain excluded',async t=>{
 const f=await fixture(t), before=(await getThread('project',f.env)).binding;
 await f.send('/switch project'); await f.send('continue existing work');
 const messages=await f.users('project');assert.equal(messages.length,1);assert.equal(messages[0].text,'continue existing work');
 assert.ok(messages[0].ownerSelfChatRevision);
 assert.deepEqual((await getThread('project',f.env)).binding,before);
 await f.send('@unlisted no');await f.send('@other-owner no');
 assert.equal((await f.users('unlisted')).length,0);assert.equal((await f.users('other-owner')).length,0);
 await f.send('/switch');await f.send('home again');assert.equal((await f.users('home')).at(-1).text,'home again');
});

test('mock reply stays on self account, echoes cannot steer focus, duplicate owner commands cannot replay',async t=>{
 const f=await fixture(t);
 await f.send('@project status');const parent=(await f.users('project'))[0];
 await appendThreadMessage('project',{role:'assistant',phase:'final_answer',state:'completed',text:'Status is good.',parentMessageId:parent.id},f.env);
 await f.deliver();const reply=f.sent.find(s=>s.text.includes('Status is good.'));
 assert.ok(reply,JSON.stringify(f.sent));assert.equal(reply.to,self);assert.equal(reply.accountId,'personal');
 const beforeEcho=(await f.users('project')).length;
 const actualEcho=await f.send(reply.text,{eventId:'echo-1'});
 assert.equal(actualEcho.ignoredOutboundEcho,true);
 assert.equal((await f.users('project')).length,beforeEcho);
 const paths=dataPaths(f.env),state=await readJson(paths.whatsapp,{});
 state.outboundDeliveries.push({kind:'thread',threadId:'project',accountId:'personal',chatId:self,messageId:'assistant-switch',payloadText:'/switch project',deliveredAt:new Date().toISOString(),brokerAck:{ids:['echo-command']}});
 await writeJson(paths.whatsapp,state);
 const result=await f.send('/switch project',{eventId:'echo-command'});assert.equal(result.ignoredOutboundEcho,true);
 await f.send('still home');assert.equal((await f.users('home')).at(-1).text,'still home');
 await f.send('/switch project',{eventId:'owner-command'});await f.send('/switch');
 const duplicate=await f.send('/switch project',{eventId:'owner-command'});assert.equal(duplicate.duplicate,true);
 await f.send('still home after replay');assert.equal((await f.users('home')).at(-1).text,'still home after replay');
 const count=f.sent.length;await f.deliver();assert.equal(f.sent.filter(s=>s.text.includes('Status is good.')).length,1);
 assert.ok(f.sent.length>=count);
});

test('scope revocation and existing mirror hold block delivery; non-owner origins cannot select',async t=>{
 const f=await fixture(t);
 await f.send('@project forbidden',{fromMe:false,from:'15550009999@c.us'}).catch(()=>null);
 await f.send('@project wrong account',{accountId:'unapproved'}).catch(()=>null);
 assert.equal((await f.users('project')).length,0);
 await f.send('@held status');const held=(await f.users('held'))[0];assert.ok(held);
 await appendThreadMessage('held',{role:'assistant',phase:'final_answer',state:'completed',text:'Held result.',parentMessageId:held.id},f.env);
 await f.send('@project status');const parent=(await f.users('project'))[0];
 await appendThreadMessage('project',{role:'assistant',phase:'final_answer',state:'completed',text:'Revoked result.',parentMessageId:parent.id},f.env);
 await f.deliver();
 assert.ok(!f.sent.some(s=>/Held result/.test(s.text)), 'existing mirror suppression is retained while scope is enabled');
 const before=f.sent.length;
 await appendThreadMessage('project',{role:'assistant',phase:'final_answer',state:'completed',text:'After revocation.',parentMessageId:parent.id},f.env);
 delete f.env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE;await f.deliver();
 assert.equal(f.sent.length,before);
 assert.ok(!f.sent.some(s=>/Held result|After revocation/.test(s.text)));
});

test('self-chat scope defaults off and binds replies to exact policy and owner',()=>{
 assert.equal(ownerSelfChatScope({}),null);assert.equal(ownerSelfChatScope({ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:'invalid'}),null);
 const env={ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify({enabled:true,ownerUserId:'a',accountId:'p',chatId:self,homeThreadId:'h',threadIds:['x']})};
 const scope=ownerSelfChatScope(env),parent={source:'whatsapp_inbound',accountId:'p',chatId:self,ownerSelfChatRevision:scope.revision,ownerSelfChatHomeThreadId:'h'};
 assert.equal(ownerSelfChatReplyRoute(parent,{id:'x',ownerUserId:'a'},env).allowed,true);
 assert.equal(ownerSelfChatReplyRoute(parent,{id:'x',ownerUserId:'b'},env).allowed,false);
 assert.equal(ownerSelfChatReplyRoute(parent,{id:'x',ownerUserId:'a'},{}).allowed,false);
});


test('a supplemental self-chat binding keeps the existing home group and thread identity',async t=>{
 const f=await fixture(t), home=await getThread('home',f.env);
 f.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED='1';
 await writeConnectorConfig('whatsapp',{bridgeMode:'external',bridgeUrl:'http://bridge.invalid/api/connectors/whatsapp/bridge'},f.env);
 t.mock.method(globalThis,'fetch',async(_url,options={})=>{
  assert.equal(options.method||'GET','GET','only mock readiness requests');
  return new Response(JSON.stringify({ok:true,ready:true,authenticated:true,accounts:[{id:'personal',state:'ready',ready:true,authenticated:true,contactId:self}]}),{status:200,headers:{'content-type':'application/json'}});
 });
 await upsertWhatsAppConnectorAccount({accountId:'personal',ownerUserId:'admin',runtimeAccountId:'personal'},f.env);
 await upsertWhatsAppBindingRecord({...home.binding,id:'self-entry',level:'chat',threadId:'home',ownerUserId:'admin'},f.env);
 const originalGroup={privateOwnerChat:false,connector:'whatsapp',chatId:'home-original@g.us',enabled:true,mirrorToWhatsApp:true,senderAccountId:'old-account',responderAccountId:'old-account',outboundAccountId:'old-account'};
 await updateThread('home',{binding:originalGroup},f.env);
 const preservedBinding=(await getThread('home',f.env)).binding;
 await f.send('/switch project');await f.send('same existing project');
 assert.equal((await f.users('project')).at(-1)?.text,'same existing project');
 await f.send('/switch');await f.send('same existing home');
 assert.equal((await f.users('home')).at(-1)?.text,'same existing home');
 assert.deepEqual((await getThread('home',f.env)).binding,preservedBinding);
 const parent=(await f.users('home')).at(-1);
 await appendThreadMessage('home',{role:'assistant',phase:'final_answer',state:'completed',text:'Home answer.',parentMessageId:parent.id},f.env);
 await f.deliver();
 const reply=f.sent.find(x=>x.text.includes('Home answer.'));assert.ok(reply);
 assert.equal(reply.accountId,'personal');assert.equal(reply.to,self);
 assert.ok(f.sent.every(x=>x.accountId==='personal' && x.to===self),'router command replies use self transport too');
 delete f.env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE;
 await assert.rejects(f.send('revoked ingress'),/owner_selfchat_scope_required/);
 assert.deepEqual((await getThread('home',f.env)).binding,preservedBinding);
});
