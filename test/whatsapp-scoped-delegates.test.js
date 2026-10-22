import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';

const own='15550000001@c.us',group='120000000001@g.us',alice='15550000002@c.us',bob='15550000003@c.us',stranger='15550000009@c.us';
const token='delegate-test-token',coordinatorToken='coordinator-test-token';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function fixture(t,{send,delegate={},messages={}}={}) {
  let now=Date.now();
  const config={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}],
    coordinator:{tokenSha256:sha(coordinatorToken),authorizedAt:new Date(now-500).toISOString()},
    delegates:[{name:'swing',threadId:'thread-1',tokenSha256:sha(token),authorizedAt:new Date(now-500).toISOString(),chatIds:[alice,bob],
      dailyNewRecipientCap:2,dailyFollowUpCap:1,minGapSeconds:60,...delegate}]};
  const p=createScopedGroupTransport({config,token:'transport-token',base:{},dbPath:':memory:',now:()=>now,sendLookupDelayMs:1});
  t.after(()=>p.close());
  const calls={sent:[],seen:0};
  const chats={};
  const chatFor=id=>chats[id] ||= {id:{_serialized:id},name:`chat ${id}`,isGroup:false,timestamp:now/1000,unreadCount:1,
    sendSeen:async()=>{calls.seen++;},fetchMessages:async({limit})=>(messages[id]||[]).slice(-limit)};
  let counter=0;
  const client={info:{wid:{_serialized:own}},
    getChats:async()=>[chatFor(alice),chatFor(bob),chatFor(stranger),chatFor(group)],
    getChatById:async id=>chatFor(id),
    sendMessage:send || (async(to,text,options)=>{calls.sent.push({to,text,options});return {id:{_serialized:`out-${++counter}`}};})};
  return {p,client,calls,advance:ms=>{now+=ms;}};
}

function authorize(p,{bearer,method='GET',path}) {
  const req={method,path,query:{},get:name=>name==='authorization'&&bearer?`Bearer ${bearer}`:''};
  let status=200,payload=null,passed=false;
  const res={status(code){status=code;return res;},json(value){payload=value;return res;}};
  p.middleware(req,res,()=>{passed=true;});
  return {passed,status,payload,req};
}

function call(p,client,{method='GET',path,query={},body,coordinator=false,delegate=true}) {
  const req={method,path,query,body};
  if(coordinator)req.orkestrCoordinator=true;
  if(delegate){const auth=authorize(p,{bearer:token,path:'/delegate/x'});req.orkestrDelegate=auth.req.orkestrDelegate;}
  return new Promise(resolve=>{
    let status=200;
    const res={status(code){status=code;return res;},json(value){resolve({status,body:value});return res;}};
    const app={use(handler){this.handlers.push(handler);},handlers:[]};
    p.routes(app,()=>client);
    let i=0;const run=()=>{const h=app.handlers[i++];if(!h)return resolve({status:404,body:null});h(req,res,run);};run();
  });
}

test('a delegate bearer reaches only /delegate/* and cannot reach coordinator or transport routes', t => {
  const {p}=fixture(t);
  assert.equal(authorize(p,{bearer:token,path:'/delegate/health'}).passed,true);
  for(const path of ['/coordinator/chats','/health','/api/chats/x/history','/send-text']) {
    const r=authorize(p,{bearer:token,path});
    assert.equal(r.passed,false,path);assert.equal(r.status,403,path);
  }
  assert.equal(authorize(p,{bearer:'wrong',path:'/delegate/health'}).status,401);
  const viaCoordinator=authorize(p,{bearer:coordinatorToken,path:'/delegate/health'});
  assert.equal(viaCoordinator.passed,false);
  assert.equal(authorize(p,{bearer:'transport-token',path:'/delegate/health'}).passed,false);
});

test('delegate configuration is validated and needs dedicated credentials', t => {
  const now=Date.now();
  const base={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}]};
  const good={name:'swing',threadId:'t',tokenSha256:sha('x'),authorizedAt:base.activatedAt,chatIds:[alice],dailyNewRecipientCap:2};
  const make=delegates=>createScopedGroupTransport({config:{...base,delegates},token:'transport-token',base:{},dbPath:':memory:'});
  make([good]).close();
  for(const bad of [{...good,tokenSha256:'abc'},{...good,name:'Bad Name'},{...good,chatIds:[group]},{...good,chatIds:[alice,alice]},
      {...good,chatIds:[]},{...good,dailyNewRecipientCap:0},{...good,extra:1},{...good,tokenSha256:sha('transport-token')},{...good,minGapSeconds:-1}])
    assert.throws(()=>make([bad]),/configuration_invalid/);
  assert.throws(()=>make([good,{...good,name:'other'}]),/configuration_invalid/);
  assert.throws(()=>createScopedGroupTransport({config:{...base,delegates:[good],coordinator:{tokenSha256:good.tokenSha256,authorizedAt:base.activatedAt}},
    token:'transport-token',base:{},dbPath:':memory:'}),/configuration_invalid/);
});

test('send is limited to scoped chats, idempotent, and counts first contacts per rolling 24 h', async t => {
  const {p,client,calls,advance}=fixture(t);
  const denied=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:stranger,text:'hi',requestId:'r0'}});
  assert.equal(denied.status,403);assert.equal(denied.body.error,'delegate_scope_denied');
  const group_=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:group,text:'hi',requestId:'r0'}});
  assert.equal(group_.status,403);
  const first=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r1'}});
  assert.deepEqual(first,{status:200,body:{ok:true,requestId:'r1',ids:['out-1']}});
  assert.equal(calls.sent[0].options.sendSeen,false);
  const retry=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r1'}});
  assert.equal(retry.body.duplicate,true);assert.equal(calls.sent.length,1);
  const conflict=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'other',requestId:'r1'}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error,'delegate_request_conflict');
  const tooSoon=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:bob,text:'hello',requestId:'r2'}});
  assert.equal(tooSoon.status,429);assert.equal(tooSoon.body.error,'delegate_too_soon');
  advance(61_000);
  assert.equal((await call(p,client,{method:'POST',path:'/delegate/send',body:{to:bob,text:'hello',requestId:'r2'}})).status,200);
  // Two new recipients used; follow-up to alice allowed once, the second is refused.
  advance(61_000);
  assert.equal((await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'again',requestId:'r3'}})).status,200);
  advance(61_000);
  const followCap=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'and again',requestId:'r4'}});
  assert.equal(followCap.body.error,'delegate_follow_up_cap_reached');
  // After 24 h the window frees up.
  advance(24*3600*1000);
  assert.equal((await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'later',requestId:'r5'}})).status,200);
});

test('new-recipient cap refuses a third first contact and a dry run sends nothing', async t => {
  const {p,client,calls,advance}=fixture(t,{delegate:{dailyNewRecipientCap:1}});
  const dry=await call(p,client,{method:'POST',path:'/delegate/send-dry-run',body:{to:alice,text:'hello',requestId:'d1'}});
  assert.equal(dry.body.dryRun,true);assert.equal(dry.body.wouldSend.firstContact,true);assert.equal(calls.sent.length,0);
  assert.equal((await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r1'}})).status,200);
  advance(61_000);
  const capped=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:bob,text:'hello',requestId:'r2'}});
  assert.equal(capped.status,429);assert.equal(capped.body.error,'delegate_daily_cap_reached');
  assert.equal(capped.body.usage.newRecipientsRemaining,0);
  assert.equal(calls.sent.length,1);
});

test('an unconfirmed send is uncertain, blocks that chat, counts toward the cap, and the operator resolves it', async t => {
  const {p,client,advance}=fixture(t,{send:async()=>{throw new Error('no receipt');}});
  const uncertain=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r1'}});
  assert.equal(uncertain.status,409);assert.equal(uncertain.body.error,'delegate_delivery_uncertain');
  advance(61_000);
  const blocked=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r9'}});
  assert.equal(blocked.body.error,'delegate_chat_delivery_uncertain');
  const health=await call(p,client,{path:'/delegate/health'});
  assert.equal(health.body.uncertainSends,1);assert.equal(health.body.usage.newRecipients,1);
  // The delegate cannot resolve; the coordinator can.
  assert.equal((await call(p,client,{method:'POST',path:'/coordinator/delegate-resolve',body:{delegate:'swing',requestId:'r1',outcome:'not_sent'}})).status,403);
  const listed=await call(p,client,{path:'/coordinator/delegate-sends',query:{state:'uncertain'},coordinator:true,delegate:false});
  assert.equal(listed.body.sends.length,1);
  const bad=await call(p,client,{method:'POST',path:'/coordinator/delegate-resolve',body:{delegate:'swing',requestId:'r1',outcome:'sent'},coordinator:true,delegate:false});
  assert.equal(bad.status,400);
  const resolved=await call(p,client,{method:'POST',path:'/coordinator/delegate-resolve',body:{delegate:'swing',requestId:'r1',outcome:'not_sent'},coordinator:true,delegate:false});
  assert.deepEqual(resolved.body,{ok:true,delegate:'swing',requestId:'r1',state:'not_sent'});
  const afterCap=await call(p,client,{path:'/delegate/cap'});
  assert.equal(afterCap.body.usage.newRecipients,0);
  const again=await call(p,client,{method:'POST',path:'/delegate/send',body:{to:alice,text:'hello',requestId:'r1'}});
  assert.equal(again.body.error,'delegate_request_resolved_not_sent');
});

test('reads are limited to the delegate chats and never mark anything seen', async t => {
  const {p,client,calls}=fixture(t,{messages:{[alice]:[{id:{_serialized:'m1'},fromMe:false,from:alice,timestamp:1000,type:'chat',body:'hi',ack:1},
    {id:{_serialized:'m2'},fromMe:true,timestamp:1001,type:'chat',body:'yo',ack:2}]}});
  const listed=await call(p,client,{path:'/delegate/chats'});
  assert.deepEqual(listed.body.chats.map(c=>c.chatId).sort(),[alice,bob].sort());
  const history=await call(p,client,{path:`/delegate/chats/${encodeURIComponent(alice)}/messages`,query:{limit:'5'}});
  assert.deepEqual(history.body.messages.map(m=>m.id),['m2','m1']);
  for(const other of [stranger,group])
    assert.equal((await call(p,client,{path:`/delegate/chats/${encodeURIComponent(other)}/messages`})).status,403);
  assert.equal(calls.seen,0);
  const noDelegate=await call(p,client,{path:'/delegate/health',delegate:false});
  assert.equal(noDelegate.status,403);
});
