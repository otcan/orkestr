import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';

const own='15550000001@c.us',group='120000000001@g.us',other='120000000099@g.us',person='15550000002@c.us';
const coordinatorToken='coordinator-test-token';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function fixture(t,{send,messages={}}={}) {
  const now=Date.now();
  const config={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}],
    coordinator:{tokenSha256:sha(coordinatorToken),authorizedAt:new Date(now-500).toISOString()}};
  const p=createScopedGroupTransport({config,token:'test-token',base:{},dbPath:':memory:',now:()=>now,sendLookupDelayMs:1});
  t.after(()=>p.close());
  const calls={sent:[],seen:0};
  const chats={};
  const chatFor=id=>chats[id] ||= {id:{_serialized:id},name:`chat ${id}`,isGroup:id.endsWith('@g.us'),timestamp:now/1000,unreadCount:0,
    groupMetadata:id.endsWith('@g.us')?{participants:[{id:{_serialized:own},isAdmin:true},{id:{_serialized:person}}]}:undefined,
    sendSeen:async()=>{calls.seen++;},
    fetchMessages:async({limit})=>(messages[id]||[]).slice(-limit)};
  let counter=0;
  const client={info:{wid:{_serialized:own}},
    getChats:async()=>[chatFor(group),chatFor(other),chatFor(person)],
    getChatById:async id=>chatFor(id),
    getContactById:async id=>({name:id===person?'Someone':null}),
    sendMessage:send || (async(to,text,options)=>{calls.sent.push({to,text,options});return {id:{_serialized:`out-${++counter}`}};})};
  return {p,client,calls,now,config,messages};
}

function middleware(p,{token,method='GET',path,body}) {
  const req={method,path,body,query:{},get:name=>name==='authorization'&&token?`Bearer ${token}`:''};
  let status=200,payload=null,passed=false;
  const res={status(code){status=code;return res;},json(value){payload=value;return res;}};
  p.middleware(req,res,()=>{passed=true;});
  return {passed,status,payload,req};
}

function request(p,client,{method='GET',path,query={},body}) {
  const req={method,path,query,body,orkestrCoordinator:true};
  return new Promise(resolve=>{
    let status=200;
    const res={status(code){status=code;return res;},json(value){resolve({status,body:value});return res;}};
    p.coordinator.handler(()=>client)(req,res,()=>resolve({status:404,body:null}));
  });
}

test('the coordinator bearer reaches only coordinator routes and the transport token never does', t => {
  const {p}=fixture(t);
  const viaTransport=middleware(p,{token:'test-token',path:'/coordinator/chats'});
  assert.equal(viaTransport.passed,false);assert.equal(viaTransport.status,403);
  assert.equal(viaTransport.req.orkestrCoordinator,undefined);
  for(const [method,path,body] of [['GET','/health'],['GET',`/api/chats/${encodeURIComponent(group)}/history`],
      ['POST','/send-text',{to:group,text:'x',accountId:'main',requestId:'r',parentId:'p'}]]) {
    const result=middleware(p,{token:coordinatorToken,method,path,body});
    assert.equal(result.passed,false,path);assert.equal(result.status,403,path);
  }
  const allowed=middleware(p,{token:coordinatorToken,path:'/coordinator/chats'});
  assert.equal(allowed.passed,true);assert.equal(allowed.req.orkestrCoordinator,true);
  assert.equal(middleware(p,{token:'wrong',path:'/coordinator/chats'}).status,401);
});

test('coordinator configuration is opt-in, validated and needs a dedicated credential', t => {
  const now=Date.now();
  const base={ownChatId:own,activatedAt:new Date(now-1000).toISOString(),groups:[{chatId:group,threadId:'thread-1'}]};
  const plain=createScopedGroupTransport({config:base,token:'test-token',base:{},dbPath:':memory:'});
  t.after(()=>plain.close());
  assert.equal(plain.coordinator,null);
  const app={used:0,use(){this.used++;}};plain.routes(app,()=>null);assert.equal(app.used,0);
  for(const coordinator of [{tokenSha256:'abc',authorizedAt:base.activatedAt},{tokenSha256:sha('x'),authorizedAt:'never'},
      {tokenSha256:sha('x'),authorizedAt:base.activatedAt,extra:true},{tokenSha256:sha('test-token'),authorizedAt:base.activatedAt}])
    assert.throws(()=>createScopedGroupTransport({config:{...base,coordinator},token:'test-token',base:{},dbPath:':memory:'}),/configuration_invalid/);
});

test('coordinator originates to any chat once per request id, without a reply parent', async t => {
  const {p,client,calls}=fixture(t);
  const first=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'hello',requestId:'req-1'}});
  assert.deepEqual(first,{status:200,body:{ok:true,requestId:'req-1',ids:['out-1']}});
  assert.equal(calls.sent[0].options.sendSeen,false);
  const retry=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'hello',requestId:'req-1'}});
  assert.equal(retry.body.duplicate,true);assert.equal(calls.sent.length,1,'a retry never sends twice');
  const conflict=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'changed',requestId:'req-1'}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error,'coordinator_request_conflict');
  const direct=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:person,text:'hi',requestId:'req-2'}});
  assert.equal(direct.status,200);
  for(const body of [{to:'status@broadcast',text:'x',requestId:'r3'},{to:other,text:' ',requestId:'r4'},{to:other,text:'x',requestId:'bad id'},
      {to:other,text:'x',requestId:'r5',parentId:'p'}])
    assert.equal((await request(p,client,{method:'POST',path:'/coordinator/send',body})).status,400);
});

test('an unconfirmed coordinator send blocks only that chat, never group replies', async t => {
  let fail=true;
  const {p,client}=fixture(t,{send:async(to,text)=>{if(fail && to===other)throw new Error('timeout');return {id:{_serialized:`out-${to}-${text}`}};}});
  const uncertain=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'lost',requestId:'u-1'}});
  assert.equal(uncertain.status,409);assert.equal(uncertain.body.error,'coordinator_delivery_uncertain');
  assert.equal(p.blocked(),false,'the group transport is not blocked');
  const sameChat=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'next',requestId:'u-2'}});
  assert.equal(sameChat.body.error,'coordinator_chat_delivery_uncertain');
  assert.equal((await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:person,text:'ok',requestId:'u-3'}})).status,200);
  // A normal group reply still works.
  const message={id:{_serialized:'owner-1'},fromMe:true,to:group,body:'hello',timestamp:Date.now()/1000};
  assert.equal(await p.observe(client,message),true);
  assert.equal((await p.sendText(client,group,'reply','main',{requestId:'g-1',parentId:'owner-1'})).ok,true);
  // Operator resolution after reading the chat unblocks it; the old id stays resolved.
  const listed=await request(p,client,{path:'/coordinator/sends',query:{state:'uncertain'}});
  assert.deepEqual(listed.body.sends.map(s=>s.id),['u-1']);
  assert.equal((await request(p,client,{method:'POST',path:'/coordinator/resolve',body:{requestId:'u-1',outcome:'not_sent'}})).status,200);
  fail=false;
  assert.equal((await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'next',requestId:'u-2'}})).status,200);
  assert.equal((await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'lost',requestId:'u-1'}})).body.error,'coordinator_request_resolved_not_sent');
});

test('a delivered send without a model is confirmed by reading the chat back', async t => {
  const messages={};
  const {p,client}=fixture(t,{messages,send:async(to,text)=>{
    messages[to]=[{id:{_serialized:'read-back-1'},fromMe:true,type:'chat',body:text,timestamp:Date.now()/1000,ack:1}];
    return undefined;
  }});
  const result=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'confirm me',requestId:'c-1'}});
  assert.deepEqual(result.body,{ok:true,requestId:'c-1',ids:['read-back-1']});
});

test('coordinator sends into a scoped group are admitted as owner input like a phone message', async t => {
  const {p,client}=fixture(t);
  const result=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:group,text:'from coordinator',requestId:'o-1'}});
  const id=result.body.ids[0];
  assert.equal(await p.observe(client,{id:{_serialized:id},fromMe:true,to:group,body:'from coordinator',timestamp:Date.now()/1000}),true);
});

test('coordinator reads chats, history and members without marking anything seen', async t => {
  const messages={[other]:Array.from({length:5},(_,i)=>({id:{_serialized:`m-${i}`},fromMe:i%2===0,from:person,author:person,type:'chat',body:`b${i}`,timestamp:1000+i,ack:2}))};
  const {p,client,calls}=fixture(t,{messages});
  const chats=await request(p,client,{path:'/coordinator/chats',query:{limit:'2'}});
  assert.equal(chats.body.chats.length,2);assert.equal(chats.body.hasMore,true);assert.ok(chats.body.nextCursor);
  const next=await request(p,client,{path:'/coordinator/chats',query:{limit:'2',cursor:chats.body.nextCursor}});
  assert.equal(next.body.chats.length,1);assert.equal(next.body.hasMore,false);
  const history=await request(p,client,{path:`/coordinator/chats/${encodeURIComponent(other)}/messages`,query:{limit:'2'}});
  assert.deepEqual(history.body.messages.map(m=>m.id),['m-4','m-3']);
  const older=await request(p,client,{path:`/coordinator/chats/${encodeURIComponent(other)}/messages`,query:{limit:'2',before:history.body.nextCursor}});
  assert.deepEqual(older.body.messages.map(m=>m.id),['m-2','m-1']);
  const members=await request(p,client,{path:`/coordinator/groups/${encodeURIComponent(other)}/members`});
  assert.deepEqual(members.body.participants.map(m=>[m.id,m.name,m.isAdmin]),[[own,null,true],[person,'Someone',false]]);
  assert.equal((await request(p,client,{path:`/coordinator/groups/${encodeURIComponent(person)}/members`})).status,400);
  assert.equal(calls.seen,0);assert.equal(calls.sent.length,0);
});

test('the coordinator handler refuses requests the middleware did not authorize', async t => {
  const {p,client}=fixture(t);
  const result=await new Promise(resolve=>{
    let status=200;
    const res={status(code){status=code;return res;},json(value){resolve({status,body:value});return res;}};
    p.coordinator.handler(()=>client)({method:'GET',path:'/coordinator/chats',query:{}},res,()=>resolve(null));
  });
  assert.equal(result.status,403);
  assert.equal((await request(p,null,{path:'/coordinator/chats'})).status,503);
});

test('a coordinator send can quote a message, journaled with the quoted id', async t => {
  const {p,client,calls}=fixture(t);
  const sent=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'ack',requestId:'q-1',replyTo:'true_chat_ABC'}});
  assert.equal(sent.status,200);
  assert.equal(calls.sent.at(-1).options.quotedMessageId,'true_chat_ABC');
  const conflict=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'ack',requestId:'q-1'}});
  assert.equal(conflict.status,409,'the quoted id is part of the request identity');
  const bad=await request(p,client,{method:'POST',path:'/coordinator/send',body:{to:other,text:'ack',requestId:'q-2',replyTo:'bad id'}});
  assert.equal(bad.status,400);
});
