import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

function fixture(t, {enabled = true, suppressed = false} = {}) {
  const inboxDb = new DatabaseSync(':memory:');
  const relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id,chat_id,body,created_at);
    CREATE TABLE group_send(state);
    INSERT INTO group_input VALUES('provider-input','example-group','check','2026-01-02');`);
  const state = {messages: [], sends: [], reports: []};
  const config = {ownerUserId:'admin', groups:[{chatId:'example-group',threadId:'example-thread',name:'Example'}],
    forwardProgressUpdates:enabled, forwardProgressSince:'2026-01-01T00:00:00Z'};
  const api = async (url, options = {}) => {
    if (url.endsWith('/input')) return {message:{id:'public-input'}};
    if (url.includes('/messages?')) return {messages:state.messages};
    if (url.endsWith('/scoped-relay-files')) return {files:[]};
    if (url.endsWith('/scoped-relay-delivery')) {state.reports.push(options.body);return {ok:true};}
    return {thread:{ownerUserId:'admin',binding:{connector:'whatsapp',enabled:true,chatId:'example-group',
      remoteBackend:'rust-v2',remoteThreadId:'example-remote',mirrorToWhatsApp:false,suppressWhatsAppUpdates:suppressed}}};
  };
  const relay = createScopedGroupRelay({config,api,inboxDb,relayDb,env:{},
    send:async payload => {state.sends.push(payload);return {ok:true,ids:[`receipt-${state.sends.length}`]};}});
  t.after(()=>{relay.close();inboxDb.close();relayDb.close();});
  return {relay,relayDb,state};
}

const progress = (overrides = {}) => ({id:'public-progress',role:'assistant',state:'completed',
  phase:'commentary',source:'rust-v2-adapter',remoteKind:'progress',remoteBackend:'rust-v2',
  remoteThreadId:'example-remote',remoteMessageId:'remote-progress',parentMessageId:'public-input',
  text:'The check is running.',createdAt:'2026-01-02T00:00:00Z',...overrides});

test('V2 progress delivers once, reports the provider receipt and leaves the input open',async t=>{
  const {relay,relayDb,state}=fixture(t);
  state.messages=[progress()];
  assert.equal((await relay.tick()).completed,0);
  await relay.tick();
  assert.equal(state.sends.length,1);
  assert.deepEqual(state.reports[0].connectorMessageIds,['receipt-1']);
  assert.equal(relayDb.prepare('SELECT completed FROM routed').get().completed,0);
  state.messages.push(progress({id:'public-final',remoteMessageId:'remote-final',remoteKind:'final',phase:'final_answer',text:'Finished.'}));
  assert.equal((await relay.tick()).completed,1);
  assert.equal(state.sends.length,2);
});

for (const policy of [{enabled:false},{suppressed:true}]) {
  test(`V2 commentary respects ${JSON.stringify(policy)}`,async t=>{
    const {relay,state}=fixture(t,policy);state.messages=[progress()];
    await relay.tick();assert.equal(state.sends.length,0);assert.equal(state.reports.length,0);
  });
}

test('V2 progress keeps the cutoff, completed-state, source, parent and internal-phase fences',async t=>{
  const {relay,state}=fixture(t);
  state.messages=[progress({id:'old',createdAt:'2025-12-31T00:00:00Z'}),
    progress({id:'stream',state:'streaming'}),progress({id:'other',parentMessageId:'another-input'}),
    progress({id:'internal',phase:'analysis'}),progress({id:'untrusted',source:'watcher-alert'}),
    progress({id:'silent',text:'NO_REPLY'})];
  await relay.tick();assert.equal(state.sends.length,0);
});

test('an available V2 final supersedes unsent progress without a backlog replay',async t=>{
  const {relay,state}=fixture(t);
  state.messages=[progress(),progress({id:'final',phase:'final_answer',remoteKind:'final',text:'Finished.'})];
  assert.equal((await relay.tick()).completed,1);
  assert.equal(state.sends.length,1);assert.match(state.sends[0].text,/Finished/);
});

test('enabling V2 progress does not replay previous transport decisions or incomplete remote metadata',async t=>{
  const {relay,state}=fixture(t);
  state.messages=['suppressed','delivered','uncertain','failed','no_reply'].map(outcome=>
    progress({id:outcome,remoteMirrorAck:{outcome}}));
  state.messages.push(progress({id:'no-remote-id',remoteMessageId:''}),progress({id:'not-progress',remoteKind:'final'}));
  await relay.tick();assert.equal(state.sends.length,0);assert.equal(state.reports.length,0);
});
