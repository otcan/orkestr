import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createTimerNotificationProofStore} from '../packages/connectors/src/whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';
const epoch=Date.parse('2026-01-01T00:00:00Z'),iso=ms=>new Date(epoch+ms).toISOString();
function fixture(t) {
 let clock=epoch+10000;const now=()=>clock;
 const config={ownChatId:'15550000001@c.us',ownerUserId:'admin',activatedAt:iso(0),groups:[{chatId:'120000000001@g.us',threadId:'thread-1',name:'Example'},{chatId:'120000000002@g.us',threadId:'thread-2',name:'Other'}],appendDebugFooter:true,
  timerNotifications:{enabled:true,threadId:'thread-1',since:iso(0),proofDbPath:':memory:'},routeControl:{threadId:'thread-1',routeId:'temporary',dbPath:':memory:'}};
 const fence=createDeliveryRouteFence({dbPath:':memory:',now});
 fence.activate({to:'temporary',evidence:{routeId:'temporary',checkedAt:iso(10000),preserveExistingSince:iso(0),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 const proofs=createTimerNotificationProofStore({path:':memory:',now});
 const event={type:'timer_due',timerId:'timer1',messageId:'parent1',target:'thread-1',targetType:'thread',ownerUserId:'admin',ts:iso(5000)};
 const timer={id:'timer1',label:'Example check',ownerUserId:'admin',target:'thread-1',targetType:'thread',enabled:true,cadence:'daily'};
 const parent={id:'parent1',role:'user',source:'timer_due',timerId:'timer1',ownerUserId:'admin',chatId:config.groups[0].chatId,createdAt:iso(5000)};
 const answer={id:'answer1',role:'assistant',state:'completed',phase:'final_answer',source:'codex-app-server',parentMessageId:'parent1',createdAt:iso(9000),text:'All clear.',cursor:2};
 const state={events:[event],timers:[timer],messages:[parent,answer],sent:[],fail:false,echoes:[],mirror:false,apiCalls:[]};
 const api=async url=>{state.apiCalls.push(url);
  if(url==='/api/timers')return {timers:state.timers};
  if(url.startsWith('/api/events'))return {events:state.events};
  if(url.includes('/messages'))return {messages:state.messages};
  if(url.includes('/quota/'))return {quota:{}};
  return {thread:{ownerUserId:'admin',binding:{chatId:config.groups[0].chatId,enabled:true,mirrorToWhatsApp:state.mirror},codexModel:'example'}};
 };
 const transport=createScopedGroupTransport({config,token:'test-only',base:{},dbPath:':memory:',now,routeFence:fence,proofStore:proofs});
 const client={info:{wid:{_serialized:config.ownChatId}},sendMessage:async(to,text)=>{
  state.sent.push({to,text});if(state.fail)throw new Error('timeout');
  const id='sent-'+state.sent.length;
  state.echoes.push(transport.observe(client,{fromMe:true,to,body:text,timestamp:now()/1000,id:{_serialized:id}}));
  return {id:{_serialized:id}};
 }};
 const options={config,api,formatter,env:{},now,proofStore:proofs,routeFence:fence,send:p=>p.document ? transport.sendDocument(client,p.chatId,p.document,'main',p,media=>({media})) : transport.sendText(client,p.chatId,p.text,'main',p)};
 const notifier=createScopedTimerNotifications(options);
 t.after(()=>{notifier.close();transport.close();proofs.close();fence.close();});
 return {notifier,transport,client,state,config,proofs,fence,options,advance:ms=>clock+=ms};
}
test('only scheduler-verified thread notification is labeled, delivered once and not echoed',async t=>{
 const {notifier,state,options}=fixture(t);
 assert.equal((await notifier.tick()).sent,1);
 assert.equal(state.sent.length,1);assert.match(state.sent[0].text,/⏰ Example check/);assert.match(state.sent[0].text,/msg:\*update\*/);
 assert.deepEqual(await Promise.all(state.echoes),[false]);
 await notifier.tick();const resumed=createScopedTimerNotifications(options);await resumed.tick();resumed.close();
 assert.equal(state.sent.length,1);assert.ok(state.apiCalls.every(x=>!x.includes('thread-2')));
});
test('paused, foreign, hidden, silent, stale, spoofed and unverified runs never send',async t=>{
 for(const mode of ['paused','foreignTimer','foreignEvent','missingEvent','wrongParent','recordOnly','hidden','noReply','stale','future','oldRun','untrusted','invalidParentDate']) {
  const {notifier,state,config}=fixture(t);
  if(mode==='paused')state.timers[0].enabled=false;
  if(mode==='foreignTimer')state.timers[0].target='thread-2';
  if(mode==='foreignEvent')state.events[0].target='thread-2';
  if(mode==='missingEvent')state.events=[];
  if(mode==='wrongParent')state.messages[1].parentMessageId='other';
  if(mode==='recordOnly')state.messages[1].signalMode='record_only';
  if(mode==='hidden')state.messages[1].visibility='hidden';
  if(mode==='noReply')state.messages[1].text='NO_REPLY';
  if(mode==='stale')state.messages[1].createdAt=iso(-1000000);
  if(mode==='future')state.messages[1].createdAt=iso(20000);
  if(mode==='oldRun')config.timerNotifications.since=iso(8000); // scope already frozen: event itself must predate original cutoff.
  if(mode==='oldRun')state.events[0].ts=iso(-1000);
  if(mode==='untrusted')state.messages[1].source='watcher-alert';
  if(mode==='invalidParentDate')state.messages[0].createdAt='invalid';
  await notifier.tick();assert.equal(state.sent.length,0,mode);
 }
});
test('one-shot auto-disabled on completion can notify; later explicit pause cannot',async t=>{
 const {notifier,state}=fixture(t);Object.assign(state.timers[0],{enabled:false,cadence:'once',nextRunAt:null,lastRunAt:iso(5000)});
 assert.equal((await notifier.tick()).sent,1);
 const other=fixture(t);Object.assign(other.state.timers[0],{enabled:false,cadence:'once',nextRunAt:null,lastRunAt:iso(5000),updatedAt:iso(7000)});
 await other.notifier.tick();assert.equal(other.state.sent.length,0);
});
test('provider uncertainty survives restart and prevents both retry and cutover',async t=>{
 const {notifier,state,options,fence}=fixture(t);state.fail=true;
 await assert.rejects(notifier.tick(),/unresolved/);assert.equal(state.sent.length,1);
 const resumed=createScopedTimerNotifications(options);await assert.rejects(resumed.tick(),/unresolved/);resumed.close();
 assert.equal(fence.blocked(),true);assert.equal(state.sent.length,1);
});
test('transport rejects forged notification, altered payload and another recipient',async t=>{
 const {notifier,state,transport,client,proofs,config}=fixture(t);
 await assert.rejects(transport.sendText(client,config.groups[0].chatId,'fake','main',{requestId:'fake',notificationId:'fake',parentId:'parent1'}),/proof_denied/);
 await notifier.tick();const event=proofs.runs()[0];assert.ok(event);
 const id='timer:'+ (await import('../packages/connectors/src/whatsapp-timer-notification-proof.js')).notificationKey(['thread-1',event.messageId])+':0';
 for(const [to,text] of [[config.groups[0].chatId,'altered'],[config.groups[1].chatId,state.sent[0].text]])
  await assert.rejects(transport.sendText(client,to,text,'main',{requestId:id,notificationId:id,parentId:'parent1'}),/proof_denied/);
 assert.equal(state.sent.length,1);
});
test('legacy mirror must be suppressed and no backlog is sent after cutover',async t=>{
 const {notifier,state,fence,advance}=fixture(t);state.mirror=true;
 await assert.rejects(notifier.tick(),/duplicate_route/);state.mirror=false;
 advance(1000);fence.activate({from:'temporary',to:'primary',evidence:{routeId:'primary',checkedAt:iso(11000),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 assert.equal((await notifier.tick()).active,false);assert.equal(state.sent.length,0);
});

test('lost response after accepted send reuses the bridge receipt without a new provider send',async t=>{
 const {state,proofs,transport,client,config,notifier}=fixture(t);
 await notifier.tick();const run=proofs.runs()[0];
 const {notificationKey}=await import('../packages/connectors/src/whatsapp-timer-notification-proof.js');
 const id='timer:'+notificationKey(['thread-1',run.messageId])+':0';
 const row=proofs.get(id);
 const r=await transport.sendText(client,config.groups[0].chatId,row.text,'main',{requestId:id,notificationId:id,parentId:row.parent_id});
 assert.equal(r.duplicate,true);assert.equal(state.sent.length,1);
});
test('event history gaps surface a blocker rather than silently skipping unverified runs',async t=>{
 const {state,notifier}=fixture(t);
 state.events=Array.from({length:500},(_,i)=>({type:'other',ts:iso(5000+i)}));
 await assert.rejects(notifier.tick(),/event_gap/);assert.equal(state.sent.length,0);
});
test('expired or revoked proofs cannot authorize proactive delivery',async t=>{
 const {notifier,state,transport,client,proofs,config,advance}=fixture(t);
 await notifier.tick();const run=proofs.runs()[0];
 const {notificationKey}=await import('../packages/connectors/src/whatsapp-timer-notification-proof.js');
 const id='timer:'+notificationKey(['thread-1',run.messageId])+':0',row=proofs.get(id);
 advance(900001);
 await assert.rejects(transport.sendText(client,config.groups[0].chatId,row.text,'main',{requestId:id,notificationId:id,parentId:row.parent_id}),/proof_denied/);
 assert.equal(state.sent.length,1);
});
test('thread-only route fence preserves unrelated group replies after switching',async t=>{
 const {fence,transport,client,config,state,advance}=fixture(t);advance(1000);
 fence.activate({from:'temporary',to:'primary',evidence:{routeId:'primary',checkedAt:iso(11000),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 const owner={id:{_serialized:'owner2'},fromMe:true,to:config.groups[1].chatId,body:'hello',timestamp:(epoch+11000)/1000};
 assert.equal(await transport.observe(client,owner),true);
 await transport.sendText(client,owner.to,'unchanged group reply','main',{requestId:'r2',parentId:'owner2'});
 assert.equal(state.sent.length,1);
 assert.equal(await transport.observe(client,{...owner,id:{_serialized:'owner1'},to:config.groups[0].chatId}),false);
});

test('wrapper response loss reconciles an accepted receipt; absent receipt blocks cutover',async t=>{
 const f=fixture(t);
 const afterAccept=createScopedTimerNotifications({...f.options,send:async p=>{await f.options.send(p);throw new Error('lost response');}});
 assert.equal((await afterAccept.tick()).sent,1);assert.equal(f.state.sent.length,1);assert.equal(f.fence.blocked(),false);afterAccept.close();
 const g=fixture(t);
 const beforeAccept=createScopedTimerNotifications({...g.options,send:async()=>{throw new Error('unknown wrapper outcome');}});
 await assert.rejects(beforeAccept.tick(),/unresolved/);assert.equal(g.fence.blocked(),true);assert.equal(g.state.sent.length,0);beforeAccept.close();
});

test('scheduler-recorded passive auth notices notify, while record-only and paused notices do not',async t=>{
 for(const mode of ['visible','record_only','paused','unverified']) {
  const {state,notifier}=fixture(t);
  Object.assign(state.timers[0],{blockedReason:'blocked_auth',lastAuthNoticeMessageId:mode==='unverified'?'other':'notice1',enabled:mode!=='paused'});
  state.events=[{type:'thread_signal_appended',source:'timer_connector_health',signalMode:'notify_passively',ownerUserId:'admin',threadId:'thread-1',messageId:'notice1',ts:iso(9000)}];
  state.messages=[{id:'notice1',role:'assistant',state:'completed',phase:'signal',source:'timer_connector_health',signalMode:mode==='record_only'?'record_only':'notify_passively',ownerUserId:'admin',chatId:'120000000001@g.us',createdAt:iso(9000),text:'Reconnect your mail account.'}];
  await notifier.tick();assert.equal(state.sent.length,mode==='visible'?1:0,mode);
 }
});

test('notification scope accepts a multi-thread route fence that includes its thread', async () => {
  const {notificationScope} = await import('../packages/connectors/src/whatsapp-timer-notification-proof.js');
  const groups = [{chatId: '120000000001@g.us', threadId: 'thread-a'}, {chatId: '120000000002@g.us', threadId: 'thread-b'}];
  const base = {groups, timerNotifications: {enabled: true, threadId: 'thread-a', proofDbPath: '/tmp/unused.sqlite', since: '2026-01-01T00:00:00Z'}};
  const route = extra => ({routeId: 'route-1', dbPath: '/tmp/unused-route.sqlite', ...extra});
  assert.equal(notificationScope({...base, routeControl: route({threadIds: ['thread-a', 'thread-b']})}).chatId, '120000000001@g.us');
  assert.equal(notificationScope({...base, groups: [groups[0]], routeControl: route({threadId: 'thread-a'})}).chatId, '120000000001@g.us');
  for (const control of [{threadIds: ['thread-b']}, {threadId: 'thread-a', threadIds: ['thread-a', 'thread-b']}, {threadIds: ['thread-a']}])
    assert.throws(() => notificationScope({...base, routeControl: route(control)}), /timer_notification_configuration_invalid/);
});

function multiFixture(t) {
 let clock=epoch+10000;const now=()=>clock;
 const groups=[{chatId:'120000000001@g.us',threadId:'thread-1'},{chatId:'120000000002@g.us',threadId:'thread-2'},{chatId:'120000000003@g.us',threadId:'thread-3'}];
 const config={ownChatId:'15550000001@c.us',ownerUserId:'admin',activatedAt:iso(0),groups,
  timerNotifications:{enabled:true,allGroups:true,since:iso(0),proofDbPath:':memory:'},routeControl:{threadIds:groups.map(g=>g.threadId),routeId:'temporary',dbPath:':memory:'}};
 const fence=createDeliveryRouteFence({dbPath:':memory:',now});
 fence.activate({to:'temporary',evidence:{routeId:'temporary',checkedAt:iso(10000),preserveExistingSince:iso(0),restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true}});
 const proofs=createTimerNotificationProofStore({path:':memory:',now});
 const run=(n,extra={})=>({type:'timer_due',timerId:`timer${n}`,messageId:`parent${n}`,target:`thread-${n}`,targetType:'thread',ownerUserId:'admin',ts:iso(5000),...extra});
 const timer=n=>({id:`timer${n}`,label:`Check ${n}`,ownerUserId:'admin',target:`thread-${n}`,targetType:'thread',enabled:true,cadence:'daily'});
 // Prompt-file timer messages are not listed; only the answers are.
 const answer=(n,extra={})=>({id:`answer${n}`,role:'assistant',state:'completed',phase:'final_answer',source:'claude-code',parentMessageId:`parent${n}`,chatId:groups[n-1].chatId,createdAt:iso(9000),text:`Report ${n}`,cursor:2,...extra});
 const state={events:[run(1),run(2),run(3)],timers:[timer(1),timer(2),timer(3)],messages:{'thread-1':[answer(1)],'thread-2':[answer(2)],'thread-3':[answer(3)]},sent:[],bindings:{},apiCalls:[]};
 const api=async url=>{state.apiCalls.push(url);
  if(url==='/api/timers')return {timers:state.timers};
  if(url.startsWith('/api/events'))return {events:state.events};
  const id=decodeURIComponent(url.split('/')[3]);
  if(url.includes('/messages'))return {messages:state.messages[id]||[]};
  if(url.includes('/quota/'))return {quota:{}};
  const g=groups.find(x=>x.threadId===id);
  return {thread:{ownerUserId:'admin',binding:{chatId:g.chatId,enabled:true,mirrorToWhatsApp:false,...(state.bindings[id]||{})}}};
 };
 const transport=createScopedGroupTransport({config,token:'test-only',base:{},dbPath:':memory:',now,routeFence:fence,proofStore:proofs});
 const client={info:{wid:{_serialized:config.ownChatId}},sendMessage:async(to,text)=>{state.sent.push({to,text});return {id:{_serialized:'sent-'+state.sent.length}};}};
 const options={config,api,formatter,env:{},now,proofStore:proofs,routeFence:fence,send:p=>transport.sendText(client,p.chatId,p.text,'main',p)};
 const notifier=createScopedTimerNotifications(options);
 t.after(()=>{notifier.close();transport.close();proofs.close();fence.close();});
 return {notifier,transport,client,state,config,proofs,options,groups,advance:ms=>clock+=ms};
}
test('every configured group thread delivers its own timer answer to its own chat only, exactly once',async t=>{
 const {notifier,state,groups,options}=multiFixture(t);
 const r=await notifier.tick();assert.equal(r.sent,3);
 assert.deepEqual(state.sent.map(s=>s.to).sort(),groups.map(g=>g.chatId).sort());
 for(const s of state.sent){const n=groups.findIndex(g=>g.chatId===s.to)+1;assert.match(s.text,new RegExp(`⏰ Check ${n}`));assert.match(s.text,new RegExp(`Report ${n}`));}
 await notifier.tick();const resumed=createScopedTimerNotifications(options);await resumed.tick();resumed.close();
 assert.equal(state.sent.length,3);
 const callsAfter=state.apiCalls.length;await notifier.tick();
 assert.ok(state.apiCalls.slice(callsAfter).every(u=>!u.includes('/messages')),'finished runs are not re-read');
});
test('NO_REPLY, disabled reply mirroring, foreign answers and inactive bindings never send; one bad thread does not block others',async t=>{
 const {notifier,state,groups}=multiFixture(t);
 state.messages['thread-1']=[{...state.messages['thread-1'][0],text:'NO_REPLY'}];
 state.bindings['thread-2']={mirrorReplies:false};
 state.bindings['thread-3']={enabled:false};
 let r=await notifier.tick();assert.equal(r.sent,0);assert.equal(r.errors['thread-3'],'timer_notification_binding_inactive');
 assert.equal(state.sent.length,0);
 const second=multiFixture(t);
 second.state.messages['thread-1']=[{...second.state.messages['thread-1'][0],chatId:second.groups[1].chatId}];
 second.state.messages['thread-2']=[{...second.state.messages['thread-2'][0],parentMessageId:'parent1'}];
 second.state.events[2]={...second.state.events[2],target:'thread-1'};
 r=await second.notifier.tick();
 // Answer bound to another chat, answer for another run, and a run retargeted
 // to a thread its timer does not belong to: nothing is delivered anywhere.
 assert.equal(second.state.sent.length,0);
});
test('a thread outside the fence or a mixed scope is rejected',async()=>{
 const {notificationScope}=await import('../packages/connectors/src/whatsapp-timer-notification-proof.js');
 const groups=[{chatId:'120000000001@g.us',threadId:'a'},{chatId:'120000000002@g.us',threadId:'b'}];
 const base={groups,routeControl:{routeId:'r',dbPath:'/tmp/x',threadIds:['a','b']}};
 const tn=extra=>({enabled:true,proofDbPath:'/tmp/p',since:'2026-01-01T00:00:00Z',...extra});
 assert.equal(notificationScope({...base,timerNotifications:tn({allGroups:true})}).threads.size,2);
 assert.equal(notificationScope({...base,timerNotifications:tn({threadIds:['b']})}).allowsChat('120000000001@g.us'),false);
 for(const extra of [{threadIds:['c']},{threadId:'a',threadIds:['a']},{allGroups:false},{threadIds:[]},{threadIds:['a','a']}])
  assert.throws(()=>notificationScope({...base,timerNotifications:tn(extra)}),/configuration_invalid/,JSON.stringify(extra));
});
test('multi-thread scope reports an event gap and still delivers provable runs',async t=>{
 const {notifier,state}=multiFixture(t);
 state.events=[...Array.from({length:497},(_,i)=>({type:'other',ts:iso(6000+i)})),...state.events.map(e=>({...e,ts:iso(6000)}))];
 const r=await notifier.tick();assert.ok(r.eventGap);assert.equal(r.sent,3);
});
test('V2-owned timer replies (no V1 timer_due run) are never delivered by the scoped notifier',async t=>{
 const {notifier,state}=multiFixture(t);
 state.events=[];
 state.messages['thread-1']=[{id:'v2timer-1',role:'user',source:'orkestr-v2-timer',timerId:'timer1',ownerUserId:'admin',createdAt:iso(5000)},
  {...state.messages['thread-1'][0],parentMessageId:'v2timer-1'}];
 const r=await notifier.tick();assert.equal(r.sent,0);assert.equal(state.sent.length,0);
});
test('a definitive pre-dispatch rejection closes the run without blocking other deliveries',async t=>{
 const {state,options,proofs,groups}=multiFixture(t);
 let calls=0;
 const notifier=createScopedTimerNotifications({...options,send:async p=>{calls++;if(p.chatId===groups[0].chatId)throw Object.assign(new Error('scoped_reply_invalid'),{definitive:true});return options.send(p);}});
 t.after(()=>notifier.close());
 const r=await notifier.tick();
 assert.equal(r.errors['thread-1'],'timer_notification_send_rejected');
 assert.equal(r.sent,2);
 assert.equal(state.sent.length,2);
 assert.equal(proofs.finished('parent1'),'rejected');
 await notifier.tick();assert.equal(calls,3,'rejected run is not retried');
});
test('a long timer reply goes out as one message with its footer through the group transport',async t=>{
 const {notifier,state}=fixture(t);
 state.messages[1].text=Array.from({length:500},(_,i)=>`item${i}`).join(' ').slice(0,3500);
 assert.equal((await notifier.tick()).sent,1);
 assert.equal(state.sent.length,1);
 assert.ok(state.sent[0].text.length>3000 && state.sent[0].text.length<=4000);
 assert.match(state.sent[0].text,/^⏰ Example check\nitem0 [\s\S]*\n\ndbg:/);
});
test('a timer reply over the budget is one message plus a journaled Markdown document',async t=>{
 const {state,options}=fixture(t);
 const text=Array.from({length:500},(_,i)=>`item${i}`).join(' ');
 state.messages[1].text=text;
 const env={ORKESTR_WHATSAPP_MAX_REPLY_CHARS:'1000'};
 const notifier=createScopedTimerNotifications({...options,env});
 t.after(()=>notifier.close());
 assert.equal((await notifier.tick()).sent,2);
 assert.equal(state.sent.length,2);
 assert.match(state.sent[0].text,/^⏰ Example check\nitem0 [\s\S]*\n\n… \(full reply attached\)\n\ndbg:/);
 const {media}=state.sent[1].text;
 assert.equal(media.mimetype,'text/markdown');
 assert.match(media.filename,/^reply-[0-9a-f]{10}\.md$/);
 assert.equal(Buffer.from(media.data,'base64').toString('utf8'),`⏰ Example check\n${text}`);
 await notifier.tick();
 const resumed=createScopedTimerNotifications({...options,env});await resumed.tick();resumed.close();
 assert.equal(state.sent.length,2,'neither the message nor the document repeats');
});
test('a timer answer with trailing whitespace and no footer still matches its proof',async t=>{
 const {state,config,notifier}=fixture(t);
 config.appendDebugFooter=false;
 state.messages[1].text='All clear.  \n';
 assert.equal((await notifier.tick()).sent,1);
 assert.equal(state.sent[0].text,'⏰ Example check\nAll clear.');
});
