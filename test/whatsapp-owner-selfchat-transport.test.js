import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerSelfChatTransportPolicy } from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';

const chatId = '15550000001@c.us';
const config = { enabled:true, identityVerified:true, accountId:'example-personal', chatId,
  verifiedOwnChatId:chatId, activatedAt:'2026-01-01T12:00:00Z' };
const request = { accountId:config.accountId, chatId, operation:'history', mark_seen:false };
const message = { id:'owner-1', fromMe:true, from:chatId, to:chatId,
  body:'@project continue', timestamp:'2026-01-01T12:01:00Z' };

test('transport cannot be constructed from readiness or configured number alone', () => {
  for (const override of [{enabled:false}, {identityVerified:false}, {verifiedOwnChatId:'other'},
    {activatedAt:''}, {chatId:'group@g.us',verifiedOwnChatId:'group@g.us'}]) {
    assert.throws(() => createOwnerSelfChatTransportPolicy({...config,...override}), /not_verified/);
  }
});
test('only pinned self-chat history with explicit no-mark-seen is admitted', () => {
  const policy=createOwnerSelfChatTransportPolicy(config);
  assert.deepEqual(policy.command(request), ['history',chatId,'20']);
  for (const override of [{accountId:'old-sender'},{chatId:'15550000002@c.us'},
    {mark_seen:true},{mark_seen:undefined},{limit:51},{limit:1.5}]) {
    assert.throws(() => policy.command({...request,...override}), /scope_denied/);
  }
});
test('no bulk, pair, reset, group, all-message or media command reaches the wrapper', () => {
  const policy=createOwnerSelfChatTransportPolicy(config);
  for (const operation of ['messages','chats','pair-code','start','stop','create-group','send-media']) {
    assert.throws(() => policy.command({...request,operation}), /scope_denied/);
  }
  const send={...request,operation:'send_text',text:'hello'};
  assert.deepEqual(policy.command(send),['send-text',chatId,'hello']);
  for (const override of [{text:''},{text:'x'.repeat(3001)},{attachmentPaths:['file']}]) {
    assert.throws(() => policy.command({...send,...override}), /scope_denied/);
  }
});
test('activation cutoff prevents historical commands or synthetic fallback from running', () => {
  const policy=createOwnerSelfChatTransportPolicy(config);
  const rows=[message, {...message,id:'old',timestamp:config.activatedAt},
    {...message,id:'summary:chat'}, {...message,id:'bad-date',timestamp:'invalid'},
    {...message,id:'not-owner',fromMe:false}, {...message,id:'wrong-chat',to:'other'},
    {...message,id:'missing-from',from:null}];
  assert.deepEqual(policy.inbound(rows,{deliveryUnresolved:false}),[message]);
});
test('agent echo, duplicate owner input and acknowledged consumed IDs are rejected', () => {
  const policy=createOwnerSelfChatTransportPolicy(config);
  const rows=[message,message,{...message,id:'echo'},{...message,id:'consumed'}];
  assert.deepEqual(policy.inbound(rows,{deliveryUnresolved:false,outboundIds:['echo'],consumedIds:['consumed']}),[message]);
});
test('pending or uncertain send blocks ingestion including possible racing echoes', () => {
  const policy=createOwnerSelfChatTransportPolicy(config);
  assert.deepEqual(policy.inbound([message]),[]);
  assert.deepEqual(policy.inbound([message],{deliveryUnresolved:true}),[]);
});
