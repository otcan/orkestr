import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';

const groups=Array.from({length:3},(_,i)=>({threadId:`thread-${i}`,chatId:`12000000000${i}@g.us`}));
const now=1900000000000;
const config={workerAccountId:'existing',ownChatId:'15550000001@c.us',activatedAt:new Date(now-10000).toISOString(),groups,
 routeControl:{threadIds:groups.map(g=>g.threadId),routeId:'primary',dbPath:':memory:'}};
const url=s=>new URL(s,'http://local');
test('multi-route scope requires an exact explicit set and denies unrelated destinations',()=>{
 const p=createScopedNativeWorkerPolicy(config);
 for(const g of groups){
  p.checkRequest('POST',url('/send-text'),{accountId:'existing',to:g.chatId,text:'hi',requestId:'r',parentId:'p'});
  p.checkRequest('GET',url(`/accounts/existing/chats/${encodeURIComponent(g.chatId)}/history?mark_seen=false`));
 }
 for(const routeControl of [{threadId:groups[0].threadId},{...config.routeControl,threadIds:[]},
  {...config.routeControl,threadIds:['thread-0','thread-0','thread-2']},
  {...config.routeControl,threadIds:['thread-0','thread-1','other']},
  {...config.routeControl,threadId:'thread-0'}])
   assert.throws(()=>createScopedNativeWorkerPolicy({...config,routeControl}),/configuration_invalid/);
 assert.throws(()=>p.checkRequest('POST',url('/send-text'),{accountId:'existing',to:'120000000099@g.us',text:'hi',requestId:'r',parentId:'p'}),/denied/);
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/120000000000%40g.us/history?mark_seen=true')),/denied/);
 assert.throws(()=>p.checkRequest('POST',url('/accounts/existing/start-phone'),{}),/denied/);
});
test('one cutover fence covers every destination, old input, replay and echoes',async t=>{
 const fence=createDeliveryRouteFence({dbPath:':memory:',now:()=>now});
 const p=createScopedGroupTransport({config,token:'fixture',base:{},dbPath:':memory:',now:()=>now,routeFence:fence});
 t.after(()=>{p.close();fence.close();});
 let calls=0;
 const client={info:{wid:{_serialized:config.ownChatId}},sendMessage:async()=>({id:{_serialized:`receipt-${++calls}`}})};
 const msg=(g,id,ts=now)=>({id:{_serialized:id},fromMe:true,to:g.chatId,body:'question',timestamp:ts/1000});
 for(const g of groups)assert.equal(await p.observe(client,msg(g,g.threadId)),false);
 fence.activate({to:'primary',evidence:{routeId:'primary',checkedAt:new Date(now).toISOString(),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 for(const g of groups){
  assert.equal(await p.observe(client,msg(g,`old-${g.threadId}`,now-1000)),false);
  assert.equal(await p.observe(client,msg(g,g.threadId)),true);
  assert.equal(await p.observe(client,msg(g,g.threadId)),false);
  const req={requestId:`reply-${g.threadId}`,parentId:g.threadId};
  const r=await p.sendText(client,g.chatId,'answer','main',req);
  assert.equal((await p.sendText(client,g.chatId,'answer','main',req)).duplicate,true);
  assert.equal(await p.observe(client,msg(g,r.ids[0])),false);
 }
 assert.equal(calls,3);
 await assert.rejects(p.sendText(client,groups[1].chatId,'answer','main',{requestId:'cross',parentId:groups[0].threadId}),/parent_required/);
});
test('uncertain delivery in any destination blocks the whole cutover',async t=>{
 const fence=createDeliveryRouteFence({dbPath:':memory:',now:()=>now});
 fence.activate({to:'primary',evidence:{routeId:'primary',checkedAt:new Date(now).toISOString(),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 const p=createScopedGroupTransport({config,token:'fixture',base:{},dbPath:':memory:',now:()=>now,routeFence:fence});
 t.after(()=>{p.close();fence.close();});
 let calls=0;const client={info:{wid:{_serialized:config.ownChatId}},sendMessage:async()=>{calls++;throw Error('timeout');}};
 for(const g of groups)await p.observe(client,{id:{_serialized:g.threadId},fromMe:true,to:g.chatId,body:'hi',timestamp:now/1000});
 await assert.rejects(p.sendText(client,groups[1].chatId,'reply','main',{requestId:'r1',parentId:groups[1].threadId}),/uncertain/);
 await assert.rejects(p.sendText(client,groups[2].chatId,'reply','main',{requestId:'r2',parentId:groups[2].threadId}),/uncertain/);
 assert.equal(calls,1);assert.equal(fence.blocked(),true);
});
