import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createDelegateReactions} from '../packages/connectors/src/whatsapp-delegate-reactions.js';

const own='15550000001@c.us',chat='15550000002@c.us',messageId=`false_${chat}_ABC`;
const body={to:chat,messageId,emoji:'👍',requestId:'r1'};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delegate={name:'one',allowReactions:true,chats:new Set([chat])};
const material=digest([chat,messageId,'👍']);
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let now=Date.now(),queue=Promise.resolve(),writes=0;
  const serial=operation=>{const next=queue.then(operation);queue=next.catch(()=>{});return next;};
  const args={config:{ownChatId:own},delegates:new Map([['one',delegate]]),db,serial,now:()=>now,timeoutMs:10,lookupDelayMs:1};
  const api=createDelegateReactions(args);
  const message={id:{_serialized:messageId,remote:chat},hasReaction:false,react:async()=>{writes++;}};
  const client={info:{wid:{_serialized:own}},getMessageById:async()=>message};
  const insert=(requestId,state,createdAt=new Date(now).toISOString(),target=messageId)=>db.prepare('INSERT INTO delegate_reaction VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(`one:${requestId}`,'one',requestId,material,chat,target,'👍',state,null,createdAt,null);
  return {db,args,api,message,client,insert,advance:ms=>{now+=ms;},writes:()=>writes};
}

test('crash recovery preserves original sending record as uncertain, never retries it or a new ID for same target', async t=>{
  const f=fixture(t);f.insert('r1','sending');
  const api=createDelegateReactions(f.args);
  assert.equal(f.db.prepare('SELECT state FROM delegate_reaction').get().state,'uncertain');
  for(const requestId of ['r1','new']) await assert.rejects(api.react(f.client,delegate,{...body,requestId}),/reaction_uncertain/);
  assert.equal(f.writes(),0);assert.equal(api.list('one','uncertain').length,1);
});

test('a timed-out operation remains uncertain, including concurrent duplicate requests', async t=>{
  const f=fixture(t);
  let calls=0;f.message.react=()=>{calls++;return new Promise(()=>{});};
  const outcomes=await Promise.allSettled([f.api.react(f.client,delegate,body),f.api.react(f.client,delegate,body)]);
  assert.equal(outcomes.every(o=>o.status==='rejected' && /reaction_uncertain/.test(o.reason.message)),true);
  assert.equal(calls,1);assert.equal(f.api.list('one').length,1);
});

test('missing ack, stale reaction or wrong-parent reaction never proves provider acceptance', async t=>{
  for(const patch of [{ack:0},{timestamp:1},{msgId:'foreign-message'}]) {
    const f=fixture(t);
    f.message.react=async()=>{f.message.hasReaction=true;f.message.getReactions=async()=>[{senders:[{
      id:{_serialized:'new-reaction',fromMe:true},msgId:messageId,reaction:'👍',timestamp:Date.now()/1000,ack:1,...patch}]}];};
    await assert.rejects(f.api.react(f.client,delegate,body),/reaction_uncertain/);
    assert.equal(f.api.list('one')[0].state,'uncertain');
  }
});

test('reaction-only cap and spacing use rolling window and never delete old records', async t=>{
  const f=fixture(t);f.insert('recent','confirmed',new Date().toISOString(),'other-message');
  await assert.rejects(f.api.react(f.client,delegate,body),/reaction_too_soon/);
  f.advance(61_000);
  for(let i=0;i<19;i++)f.insert(`old-${i}`,'uncertain',new Date(Date.now()-120_000).toISOString(),`other-${i}`);
  await assert.rejects(f.api.react(f.client,delegate,body),/reaction_cap_reached/);
  assert.equal(f.writes(),0);
  f.advance(24*3600*1000);
  await assert.rejects(f.api.react(f.client,delegate,body),/reaction_uncertain/);
  assert.equal(f.writes(),1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM delegate_reaction').get().n,21);
});

test('operator resolution cannot reuse an acceptance receipt, and original request IDs stay consumed', async t=>{
  const f=fixture(t);f.insert('r1','uncertain');f.insert('r2','uncertain',new Date().toISOString(),'other-target');
  await f.api.resolve({delegate:'one',requestId:'r1',outcome:'confirmed',providerId:'accepted-reaction-1'});
  await assert.rejects(f.api.resolve({delegate:'one',requestId:'r2',outcome:'confirmed',providerId:'accepted-reaction-1'}),/provider_id_journaled/);
  assert.equal(f.api.list('one').find(row=>row.requestId==='r2').state,'uncertain');
  await f.api.resolve({delegate:'one',requestId:'r2',outcome:'not_sent'});
  assert.equal(f.api.list('one').find(row=>row.requestId==='r2').resolvedAt!==null,true);
  assert.equal(f.writes(),0);
});
