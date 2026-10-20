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
