import test from 'node:test';
import assert from 'node:assert/strict';
import {acknowledgementActivity} from '../packages/connectors/src/scoped-acknowledgement-activity.js';
import {remoteInputActivity} from '../packages/connectors/src/whatsapp-remote-input-activity.js';

const group={threadId:'thread'},route={message_id:'input'};
const thread={id:'thread',binding:{remoteThreadId:'remote',remoteBackend:'example'}};
const hint={ok:true,supported:true,publicThreadId:'thread',publicMessageId:'input',observedAtMs:20000,active:true,fastReady:false,finalReady:false};
const options=changes=>({group,route,thread,messages:[],now:()=>20000,api:async()=>({...hint,...changes})});

test('remote fallback requires fresh exact-input execution and cancels on ready native output',async()=>{
  assert.equal((await acknowledgementActivity(options())).active,true);
  for(const change of [{observedAtMs:14999},{observedAtMs:20001},{publicMessageId:'foreign'},{publicThreadId:'foreign'},{active:false}])
    assert.equal((await acknowledgementActivity(options(change))).active,false);
  for(const change of [{fastReady:true},{finalReady:true}])assert.equal((await acknowledgementActivity(options(change))).covered,true);
});

test('only an actually delivered useful output cancels by receipt, and a queued input is not active',async()=>{
  const own={role:'assistant',parentMessageId:'input',text:'Useful output',deliveryState:'delivered',whatsappMessageIds:['fake-receipt']};
  const args=options();args.messages=[own];args.api=async()=>{throw new Error('should not need another status read');};
  assert.equal((await acknowledgementActivity(args)).covered,true);
  args.messages=[{...own,parentMessageId:'foreign'}];args.route=null;
  assert.equal((await acknowledgementActivity(args)).active,false);
});

test('local runtime needs the exact active message and a fresh foreground turn',async()=>{
  const args={...options(),thread:{binding:{}},api:async()=>({orkestrThreadId:'thread',foregroundWorking:true,
    turnLifecycle:{activeMessageId:'input',running:true,updatedAt:new Date(20000).toISOString()}})};
  assert.equal((await acknowledgementActivity(args)).active,true);
  args.api=async()=>({orkestrThreadId:'thread',foregroundWorking:true,turnLifecycle:{activeMessageId:'queued-other',running:true,updatedAt:new Date(20000).toISOString()}});
  assert.equal((await acknowledgementActivity(args)).active,false);
});

test('V1 activity proxy is scoped, fresh, read-only and denies a mismatched backend reply',async()=>{
  const env={ORKESTR_REMOTE_THREAD_BACKENDS_JSON:JSON.stringify({example:{baseUrl:'http://example.test',token:'synthetic-token'}})};
  let seen;
  const fetch=async(url,init)=>{seen={url:String(url),init};return {ok:true,status:200,json:async()=>({...hint,version:1,phase:'running'})};};
  const deps={readThread:async()=>thread,now:()=>20000};
  assert.equal((await remoteInputActivity({threadId:'thread',publicMessageId:'input'},env,fetch,deps)).active,true);
  assert.equal(seen.url,'http://example.test/threads/remote/activity?publicMessageId=input');
  assert.equal(seen.init.method,undefined);assert.equal(seen.init.body,undefined);
  await assert.rejects(remoteInputActivity({threadId:'thread',publicMessageId:'foreign'},env,fetch,deps),/scope_mismatch/);
  const unsupported=async()=>({status:404});
  assert.equal((await remoteInputActivity({threadId:'thread',publicMessageId:'input'},env,unsupported,deps)).active,false);
});


test('a scoped queued input is distinct from active work and does not need a native timestamp',async()=>{
  const args=options({active:false,phase:'queued',observedAtMs:null});
  assert.deepEqual(await acknowledgementActivity(args),{active:false,queued:true});
  for(const change of [{publicMessageId:'foreign'},{publicThreadId:'foreign'},{supported:false},{phase:'paused'},{phase:'absorbed'}]){
    const value=await acknowledgementActivity(options({active:false,phase:'queued',observedAtMs:null,...change}));
    assert.notEqual(value.queued,true);
  }
  assert.equal((await acknowledgementActivity(options({active:false,phase:'queued',finalReady:true}))).covered,true);
});

test('V1 proxy preserves the exact queued phase without inventing active execution',async()=>{
  const env={ORKESTR_REMOTE_THREAD_BACKENDS_JSON:JSON.stringify({example:{baseUrl:'http://example.test',token:'synthetic-token'}})};
  const backend=async()=>({ok:true,status:200,json:async()=>({...hint,version:1,phase:'queued',active:false,observedAtMs:null})});
  const value=await remoteInputActivity({threadId:'thread',publicMessageId:'input'},env,backend,{readThread:async()=>thread,now:()=>20000});
  assert.equal(value.phase,'queued');assert.equal(value.active,false);assert.equal(value.observedAtMs,null);
});
