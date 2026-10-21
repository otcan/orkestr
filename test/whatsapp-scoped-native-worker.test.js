import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedNativeWorkerPolicy} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
const config={workerAccountId:'existing',groups:[{threadId:'thread1',chatId:'120000000001@g.us'}],routeControl:{threadId:'thread1'}};
test('native worker accepts only scoped text, health and read-without-seen operations',()=>{
 const p=createScopedNativeWorkerPolicy(config);
 const url=s=>new URL(s,'http://local');
 p.checkRequest('GET',url('/health'));
 assert.throws(()=>p.checkRequest('GET',url('/diagnostics/health?readOnly=0')),/denied/);
 p.checkRequest('GET',url('/accounts/existing/chats/120000000001%40g.us/history?mark_seen=false&limit=30'));
 const body={accountId:'existing',to:config.groups[0].chatId,text:'hello',requestId:'r1',parentId:'p1'};
 p.checkRequest('POST',url('/send-text'),body);
 p.checkRequest('POST',url('/send-text'),{...body,text:'x'.repeat(65000)});
 for(const patch of [{to:'120000000002@g.us'},{accountId:'other'},{paths:[]},{parentId:undefined},{text:'x'.repeat(65001)}])
  assert.throws(()=>p.checkRequest('POST',url('/send-text'),{...body,...patch}),/denied/);
 const doc={accountId:'existing',to:config.groups[0].chatId,filename:'reply-0123456789.md',mimetype:'text/markdown',text:'full',requestId:'d1',parentId:'p1'};
 p.checkRequest('POST',url('/send-document'),doc);
 p.checkRequest('POST',url('/send-document'),{...doc,notificationId:'d1'});
 for(const patch of [{to:'120000000002@g.us'},{accountId:'other'},{filename:'reply.sh'},{mimetype:'application/pdf'},{text:''},{path:'/etc/passwd'},{parentId:undefined}])
  assert.throws(()=>p.checkRequest('POST',url('/send-document'),{...doc,...patch}),/denied/);
 for(const op of ['/accounts/existing/logout','/send-media','/accounts/existing/reconnect','/accounts/existing/pair-code','/api/groups','/accounts/existing/chats/120000000001%40g.us/recover'])
  assert.throws(()=>p.checkRequest('POST',url(op),{}),/denied/);
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/120000000001%40g.us/history?mark_seen=true')),/denied/);
});
test('native input and output reuse the scoped transport without replacing its authenticated client',async()=>{
 const calls=[],client={identity:'mock'};
 const p=createScopedNativeWorkerPolicy(config,{createTransport:()=>({observe:async(c,m)=>{calls.push(['observe',c,m]);return true;},sendText:async(...args)=>{calls.push(['send',...args]);return {ok:true};},close(){}})});
 await p.observe('existing',client,{id:'x'});await p.send('existing',client,config.groups[0].chatId,'hi',{requestId:'r1',parentId:'x'});
 assert.equal(calls[0][1],client);assert.equal(calls[1][1],client);
 assert.throws(()=>p.observe('other',client,{}),/denied/);
 assert.throws(()=>createScopedNativeWorkerPolicy({...config,groups:[...config.groups,{threadId:'thread2',chatId:'120000000002@g.us'}]}),/configuration_invalid/);
});

test('scoped native startup preserves the saved profile and refuses pairing/reset/retries',async t=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const profile=path.join(root,'session-existing');fs.mkdirSync(profile);
 const p=createScopedNativeWorkerPolicy(config);
 for(const options of [{force:true},{reset:true},{phoneNumber:'15550000001'}])assert.throws(()=>p.claimStart({accountId:'existing',profile,options}),/operator_recovery/);
 p.claimStart({accountId:'existing',profile});
 assert.throws(()=>p.claimStart({accountId:'existing',profile}),/operator_recovery/);
 const {createPreservingNativeAuth}=await import('../packages/connectors/src/whatsapp-scoped-native-worker.js');
 class Base {constructor(){this.clientId='existing';this.dataPath=root;}async beforeBrowserInitialized(){return 'existing';}async logout(){fs.rmSync(profile,{recursive:true});}}
 const auth=new (createPreservingNativeAuth(Base))();assert.equal(await auth.beforeBrowserInitialized(),'existing');
 assert.equal((await auth.onAuthenticationNeeded()).failed,true);await assert.rejects(auth.logout(),/preserve_session/);assert.equal(fs.existsSync(profile),true);
});

test('journal failures are reported without content instead of being dropped silently',async()=>{
 const reports=[];let clock=1000;
 const p=createScopedNativeWorkerPolicy(config,{report:e=>reports.push(e),now:()=>clock,createTransport:()=>({observe:async()=>{throw new Error('table group_input has 8 columns but 4 values were supplied');},close(){}})});
 const message={from:'120000000001@g.us',body:'private words 4915550000000',fromMe:false};
 assert.equal(await p.observe('existing',{},message),false);
 assert.equal(await p.observe('existing',{},message),false);
 assert.equal(reports.length,1,'rate limited per code');
 assert.equal(reports[0].event,'scoped_group_observe_failed');assert.equal(reports[0].chatId,'120000000001@g.us');
 assert.doesNotMatch(JSON.stringify(reports),/private words/);
 clock+=60000;await p.observe('existing',{},message);
 assert.equal(reports.length,2);assert.equal(p.observeFailures().total,3);
 const broken=createScopedNativeWorkerPolicy(config,{report:e=>reports.push(e),now:()=>clock,createTransport:()=>{throw new Error('timer_notification_configuration_invalid');}});
 assert.equal(await broken.observe('existing',{},message),false);
 assert.equal(reports.at(-1).code,'timer_notification_configuration_invalid');
 assert.throws(()=>broken.observe('other',{},message),/denied/);
});

// Owner-approved direct (1:1) chats: explicit list per scoped thread, isolated journal.
const directConfig=(extra={})=>({...config,ownChatId:'15550000000@c.us',directChats:{journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us','15550000002@c.us']}]},...extra});
test('direct chats allow read-without-seen and request-id text sends only for listed contacts',()=>{
 const p=createScopedNativeWorkerPolicy(directConfig());
 const url=s=>new URL(s,'http://local');
 p.checkRequest('GET',url('/accounts/existing/chats/15550000001%40c.us/history?mark_seen=false&limit=1&thread_id=thread1'));
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/15550000001%40c.us/history?mark_seen=true&limit=1&thread_id=thread1')),/denied/);
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/15550000001%40c.us/history?limit=1')),/denied/);
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/15550000009%40c.us/history?limit=1&thread_id=thread1')),/denied/);
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats')),/denied/);
 const body={accountId:'existing',to:'15550000001@c.us',text:'hello',requestId:'co_1',threadId:'thread1'};
 p.checkRequest('POST',url('/send-text'),body);
 for(const patch of [{to:'15550000009@c.us'},{accountId:'other'},{paths:[]},{requestId:undefined},{text:'x'.repeat(3001)},{mentions:[]},{threadId:undefined},{threadId:'thread2'}])
  assert.throws(()=>p.checkRequest('POST',url('/send-text'),{...body,...patch}),/denied/);
 assert.throws(()=>p.checkRequest('POST',url('/send-media'),{...body,paths:['/tmp/x']}),/denied/);
 assert.equal(p.directChatCount(),2);
 // Without directChats nothing direct is reachable.
 assert.throws(()=>createScopedNativeWorkerPolicy(config).checkRequest('POST',url('/send-text'),body),/denied/);
});

test('direct chat config is validated strictly at startup',()=>{
 const bad=[
  {journalPath:':memory:',routes:[{threadId:'not-scoped',chatIds:['15550000001@c.us']}]},
  {journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['120000000009@g.us']}]},
  {journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us','15550000001@c.us']}]},
  {journalPath:':memory:',routes:[{threadId:'thread1',chatIds:[]}]},
  {journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us'],extra:true}]},
  {routes:[{threadId:'thread1',chatIds:['15550000001@c.us']}]},
  {journalPath:':memory:',routes:[],all:true},
 ];
 for(const directChats of bad)assert.throws(()=>createScopedNativeWorkerPolicy({...config,directChats}),/direct_configuration_invalid/);
});

test('direct sends use their own journal: idempotent, never retried, uncertainty isolated per chat',async()=>{
 const sent=[];let mode='ok';
 const client={info:{wid:{_serialized:'15550000000@c.us'}},sendMessage:async(to,text,options)=>{
  assert.equal(options.sendSeen,false);
  if(mode==='throw')throw new Error('network');
  if(mode==='hang')return new Promise(()=>{});
  sent.push([to,text]);return {id:{_serialized:`m${sent.length}`}};
 }};
 const {createScopedDirectSender}=await import('../packages/connectors/src/whatsapp-scoped-direct-chats.js');
 const p=createScopedNativeWorkerPolicy(directConfig(),{
  createTransport:()=>{throw new Error('group transport must not be used for direct chats');},
  createDirectSender:args=>createScopedDirectSender({...args,timeoutMs:20,lookupDelayMs:1}),
 });
 assert.deepEqual(await p.send('existing',client,'15550000001@c.us','hi',{threadId:'thread1',requestId:'co_a'}),{ok:true,ids:['m1']});
 assert.deepEqual(await p.send('existing',client,'15550000001@c.us','hi',{threadId:'thread1',requestId:'co_a'}),{ok:true,ids:['m1'],duplicate:true});
 await assert.rejects(p.send('existing',client,'15550000001@c.us','other text',{threadId:'thread1',requestId:'co_a'}),/request_conflict/);
 await assert.rejects(p.send('existing',client,'15550000001@c.us','hi',{threadId:'thread1',requestId:'bad id!'}),/direct_scope_denied/);
 await assert.rejects(p.send('existing',{...client,info:{wid:{_serialized:'1@c.us'}}},'15550000001@c.us','hi',{threadId:'thread1',requestId:'co_b'}),/account_mismatch/);
 assert.throws(()=>p.send('other',client,'15550000001@c.us','hi',{threadId:'thread1',requestId:'co_b'}),/denied/);
 mode='hang';
 await assert.rejects(p.send('existing',client,'15550000002@c.us','hi',{threadId:'thread1',requestId:'co_c'}),/delivery_uncertain/);
 mode='ok';
 // The uncertain request is never resent, and that chat stays blocked...
 await assert.rejects(p.send('existing',client,'15550000002@c.us','hi',{threadId:'thread1',requestId:'co_c'}),/delivery_uncertain/);
 await assert.rejects(p.send('existing',client,'15550000002@c.us','new',{threadId:'thread1',requestId:'co_d'}),/delivery_uncertain/);
 // ...while other approved chats keep working.
 assert.deepEqual(await p.send('existing',client,'15550000001@c.us','again',{threadId:'thread1',requestId:'co_e'}),{ok:true,ids:['m2']});
 mode='throw';
 await assert.rejects(p.send('existing',client,'15550000001@c.us','x',{threadId:'thread1',requestId:'co_f'}),/delivery_uncertain/);
 assert.deepEqual(sent.map(([to])=>to),['15550000001@c.us','15550000001@c.us']);
 p.close();
});

test('direct journal refuses a changed direct chat list until an operator migrates its fingerprint',async t=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const journalPath=path.join(root,'direct.sqlite');
 const {createScopedDirectSender,validateScopedDirectChats,scopedDirectChatsContract}=await import('../packages/connectors/src/whatsapp-scoped-direct-chats.js');
 const cfgA=directConfig({directChats:{journalPath,routes:[{threadId:'thread1',chatIds:['15550000001@c.us']}]}});
 const a=validateScopedDirectChats(cfgA,new Set(['thread1']));
 assert.equal(a.contract,scopedDirectChatsContract(cfgA));
 createScopedDirectSender({config:cfgA,direct:a}).close();
 const cfgB=directConfig({directChats:{journalPath,routes:[{threadId:'thread1',chatIds:['15550000001@c.us','15550000003@c.us']}]}});
 assert.throws(()=>createScopedDirectSender({config:cfgB,direct:validateScopedDirectChats(cfgB,new Set(['thread1']))}),/direct_configuration_changed/);
});

test('a direct chat is reachable only by the thread whose route lists it',async()=>{
 const two={...config,ownChatId:'15550000000@c.us',
  groups:[{threadId:'thread1',chatId:'120000000001@g.us'},{threadId:'thread2',chatId:'120000000002@g.us'}],
  routeControl:{threadIds:['thread1','thread2']},
  directChats:{journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us']},{threadId:'thread2',chatIds:['15550000002@c.us']}]}};
 const p=createScopedNativeWorkerPolicy(two,{createTransport:()=>({close(){}}),createDirectSender:()=>({sendText:async()=>({ok:true,ids:['m']}),close(){}})});
 const url=s=>new URL(s,'http://local');
 p.checkRequest('GET',url('/accounts/existing/chats/15550000002%40c.us/history?limit=1&thread_id=thread2'));
 assert.throws(()=>p.checkRequest('GET',url('/accounts/existing/chats/15550000002%40c.us/history?limit=1&thread_id=thread1')),/denied/);
 const body={accountId:'existing',to:'15550000002@c.us',text:'hi',requestId:'co_1',threadId:'thread1'};
 assert.throws(()=>p.checkRequest('POST',url('/send-text'),body),/denied/);
 p.checkRequest('POST',url('/send-text'),{...body,threadId:'thread2'});
 assert.throws(()=>p.send('existing',{},'15550000002@c.us','hi',{requestId:'co_1',threadId:'thread1'}),/denied/);
 assert.deepEqual(await p.send('existing',{},'15550000002@c.us','hi',{requestId:'co_1',threadId:'thread2'}),{ok:true,ids:['m']});
});

test('a direct send that returned no message model is confirmed by exactly one acked own message, else stays uncertain',async()=>{
 const {createScopedDirectSender,validateScopedDirectChats}=await import('../packages/connectors/src/whatsapp-scoped-direct-chats.js');
 const cfg=directConfig();const direct=validateScopedDirectChats(cfg,new Set(['thread1']));
 let history=[];const now=()=>Date.parse('2026-10-20T21:00:00Z');
 const client={info:{wid:{_serialized:'15550000000@c.us'}},sendMessage:async(to,text)=>{history.push({fromMe:true,type:'chat',body:text,timestamp:now()/1000,ack:1,id:{_serialized:`true_${to}_${history.length}`}});return undefined;},
  getChatById:async()=>({fetchMessages:async()=>history})};
 const s=createScopedDirectSender({config:cfg,direct,now,lookupDelayMs:1});
 assert.deepEqual(await s.sendText(client,'15550000001@c.us','hello',{requestId:'co_1'}),{ok:true,ids:['true_15550000001@c.us_0']});
 // Two indistinguishable candidates: stays uncertain.
 const twice={...client,sendMessage:async(to,text)=>{for(const n of [1,2])history.push({fromMe:true,type:'chat',body:text,timestamp:now()/1000,ack:1,id:{_serialized:`dup${n}`}});}};
 await assert.rejects(s.sendText(twice,'15550000002@c.us','same',{requestId:'co_2'}),/delivery_uncertain/);
 s.close();
});

test('read-all: only an owner-authorized thread may page chats and any history, read-only; sends stay on the approved list',async()=>{
 const cfg=directConfig({directChats:{journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us'],readAll:true}]}});
 const p=createScopedNativeWorkerPolicy(cfg);
 const url=s=>new URL(s,'http://local');
 p.checkRequest('GET',url('/accounts/existing/chats/page?thread_id=thread1&source=chats&limit=100'));
 p.checkRequest('GET',url('/accounts/existing/chats/page?thread_id=thread1&cursor=abc'));
 p.checkRequest('GET',url('/accounts/existing/chats/19990000000%40c.us/history?thread_id=thread1&page=1&mark_seen=false&limit=50&before=x'));
 for(const bad of ['/accounts/existing/chats/page','/accounts/existing/chats/page?thread_id=thread2','/accounts/existing/chats/page?thread_id=thread1&mark_seen=true',
   '/accounts/existing/chats/19990000000%40c.us/history?thread_id=thread1&page=1&mark_seen=true',
   '/accounts/existing/chats/19990000000%40c.us/history?thread_id=thread1',
   '/accounts/existing/chats/19990000000%40c.us/history?thread_id=thread2&page=1',
   '/accounts/existing/chats?thread_id=thread1'])
  assert.throws(()=>p.checkRequest('GET',url(bad)),/denied/,bad);
 // Reading everything never widens sending.
 const send={accountId:'existing',to:'19990000000@c.us',text:'x',requestId:'co_1',threadId:'thread1'};
 assert.throws(()=>p.checkRequest('POST',url('/send-text'),send),/denied/);
 p.checkRequest('POST',url('/send-text'),{...send,to:'15550000001@c.us'});
 // Without readAll the same thread has no listing.
 assert.throws(()=>createScopedNativeWorkerPolicy(directConfig()).checkRequest('GET',url('/accounts/existing/chats/page?thread_id=thread1')),/denied/);
 assert.throws(()=>createScopedNativeWorkerPolicy({...config,directChats:{journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us'],readAll:'yes'}]}}),/direct_configuration_invalid/);
 // At most one read-all thread per worker.
 const two={...config,groups:[{threadId:'thread1',chatId:'120000000001@g.us'},{threadId:'thread2',chatId:'120000000002@g.us'}],routeControl:{threadIds:['thread1','thread2']},
  directChats:{journalPath:':memory:',routes:[{threadId:'thread1',chatIds:['15550000001@c.us'],readAll:true},{threadId:'thread2',chatIds:['15550000002@c.us'],readAll:true}]}};
 assert.throws(()=>createScopedNativeWorkerPolicy(two),/direct_configuration_invalid/);
});

test('chat listing pages by cursor: multiple pages, explicit end, invalid cursor and page size errors, no content',async()=>{
 const {listAllChats,READ_ALL_PAGE_MAX}=await import('../packages/connectors/src/whatsapp-scoped-direct-chats.js');
 const chats=Array.from({length:7},(_,i)=>({id:{_serialized:`1555000000${i}@c.us`},name:`C${i}`,unreadCount:i%2,timestamp:1000+(i<2?5:i),
  lastMessage:{fromMe:i%3===0,body:`secret ${i}`}}));
 const seen=[];const client={getChats:async()=>chats.map(c=>({...c,sendSeen:async()=>seen.push(c)})),getContacts:async()=>[
  {id:{_serialized:'a@c.us'},name:'A',isMyContact:true},{id:{_serialized:'me@c.us'},isMe:true},{id:{_serialized:'b@c.us'},pushname:'B'}]};
 const ids=[];let cursor;let pages=0;
 do {
  const page=await listAllChats(client,{cursor,limit:3});pages++;
  ids.push(...page.chats.map(c=>c.chatId));
  assert.equal(page.total,7);
  assert.equal(page.hasMore,Boolean(page.nextCursor));
  for(const chat of page.chats)assert.deepEqual(Object.keys(chat).sort(),['chatId','isGroup','label','lastFromThem','lastMessageAt','unreadCount']);
  cursor=page.nextCursor;
 } while(cursor);
 assert.equal(pages,3);
 assert.equal(new Set(ids).size,7,'no overlap, nothing skipped');
 assert.deepEqual(ids.slice(0,4),['15550000006@c.us','15550000000@c.us','15550000001@c.us','15550000005@c.us'],'newest first, ties by id');
 const last=await listAllChats(client,{limit:7});assert.equal(last.hasMore,false);assert.equal(last.nextCursor,null);
 await assert.rejects(listAllChats(client,{cursor:'not a cursor!'}),/invalid_cursor/);
 await assert.rejects(listAllChats(client,{cursor:Buffer.from('{"x":1}').toString('base64url')}),/invalid_cursor/);
 await assert.rejects(listAllChats(client,{limit:READ_ALL_PAGE_MAX+1}),/invalid_page_size/);
 await assert.rejects(listAllChats(client,{source:'groups'}),/invalid_source/);
 // unreadOnly filters before paging: pages and totals describe only unread chats.
 const unreadIds=[];let uc;do{const pg=await listAllChats(client,{cursor:uc,limit:1,unreadOnly:true});assert.equal(pg.total,3);assert.equal(pg.chats.length,1);unreadIds.push(pg.chats[0].chatId);uc=pg.nextCursor;}while(uc);
 assert.deepEqual(unreadIds,['15550000001@c.us','15550000005@c.us','15550000003@c.us']);
 const contacts=await listAllChats(client,{source:'contacts',limit:1});
 assert.equal(contacts.contacts.length,1);assert.equal(contacts.total,2);assert.equal(contacts.hasMore,true);
 assert.doesNotMatch(JSON.stringify(ids)+JSON.stringify(contacts),/secret/);
 assert.deepEqual(seen,[]);
});

test('history pages older than a before-cursor, grows its window, and rejects unknown or too-deep cursors',async()=>{
 const {historyPage}=await import('../packages/connectors/src/whatsapp-scoped-direct-chats.js');
 const all=Array.from({length:130},(_,i)=>({id:{_serialized:`m${i}`},timestamp:i,fromMe:false,body:'x'}));
 const fetches=[];const chat={fetchMessages:async({limit})=>{fetches.push(limit);return all.slice(-limit);}};
 const first=await historyPage(chat,{limit:50});
 assert.deepEqual([first.messages[0].id._serialized,first.messages.at(-1).id._serialized],['m129','m80']);
 assert.equal(first.hasMore,true);assert.equal(first.nextCursor,'m80');
 const second=await historyPage(chat,{before:first.nextCursor,limit:50});
 assert.deepEqual([second.messages[0].id._serialized,second.messages.at(-1).id._serialized],['m79','m30']);
 const third=await historyPage(chat,{before:second.nextCursor,limit:50});
 assert.equal(third.messages.length,30);assert.equal(third.hasMore,false);assert.equal(third.nextCursor,null);
 await assert.rejects(historyPage(chat,{before:'no-such-id',limit:5}),/invalid_cursor/);
 await assert.rejects(historyPage(chat,{before:'bad cursor/..',limit:5}),/invalid_cursor/);
 await assert.rejects(historyPage(chat,{limit:51}),/invalid_page_size/);
 const deep={fetchMessages:async({limit})=>Array.from({length:limit},(_,i)=>({id:{_serialized:`d${i}`},timestamp:i}))};
 await assert.rejects(historyPage(deep,{before:'older-than-window',limit:10}),/history_window_exceeded/);
 // A burst of messages in the same second pages without skipping or repeating any.
 const burst=Array.from({length:240},(_,i)=>({id:{_serialized:`s${i}`},timestamp:7000}));
 const burstChat={fetchMessages:async({limit})=>burst.slice(-limit)};
 const got=[];let bc;
 do{const pg=await historyPage(burstChat,{before:bc,limit:50});got.push(...pg.messages.map(m=>m.id._serialized));bc=pg.nextCursor;}while(bc);
 assert.deepEqual(got,burst.map(m=>m.id._serialized).reverse());
 // A valid cursor at the oldest message of the maximum window must not report the end of the chat.
 const big={fetchMessages:async({limit})=>Array.from({length:limit},(_,i)=>({id:{_serialized:`b${5001-limit+i}`},timestamp:5001-limit+i}))};
 const edge=await historyPage(big,{before:'b4002',limit:2});
 assert.deepEqual([edge.messages.map(m=>m.id._serialized),edge.hasMore,edge.nextCursor],[['b4001'],true,'b4001']);
 await assert.rejects(historyPage(big,{before:'b4001',limit:2}),/history_window_exceeded/);
});
