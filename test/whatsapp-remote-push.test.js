import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {createThread, appendThreadMessage, getThread, listThreadMessages} from '../packages/core/src/threads.js';
import {discoverRemoteMessageWatches, importRemoteMessageChanges, importRemoteMessageThread} from '../packages/connectors/src/whatsapp-remote-changes.js';
import {syncRemoteWhatsAppThreadMessages} from '../packages/connectors/src/whatsapp-remote-runtime.js';
import {recordScopedRelayRemoteDelivery} from '../packages/connectors/src/whatsapp-scoped-relay-remote.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {startScopedRemoteWatch} from '../packages/connectors/src/whatsapp-scoped-remote-watch.js';
import {remoteInputActivity} from '../packages/connectors/src/whatsapp-remote-input-activity.js';

async function fixture(t, {slow = false, acknowledgement = false} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-push-'));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const env = {ORKESTR_HOME: home, ORKESTR_THREAD_STORE: 'sqlite', ORKESTR_THREAD_MESSAGE_STORE: 'sqlite',
    ORKESTR_AUTO_RUN_THREAD_INPUT: '0', ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({example: {baseUrl: 'http://example.test', token: 'synthetic-token'}})};
  const binding = {enabled: true, chatId: 'group', mirrorToWhatsApp: false, remoteBackend: 'example', remoteThreadId: 'route', suppressWhatsAppUpdates: false};
  const thread = await createThread({id: 'example-thread', name: 'Example', binding}, env);
  const parent = await appendThreadMessage(thread.id, {role: 'user', text: 'request', state: 'completed', source: 'whatsapp_group_relay', remoteBackend: 'example', remoteThreadId: 'route', remoteMessageId: 'remote-user'}, env);
  const inbox = new DatabaseSync(':memory:'), db = new DatabaseSync(':memory:');
  inbox.exec('CREATE TABLE group_input(id,chat_id,body,created_at);CREATE TABLE group_send(id,state);');
  const at = Date.now();
  if (slow) inbox.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('slow-wa', 'slow-group', 'older request', new Date(at - 1).toISOString());
  inbox.prepare('INSERT INTO group_input VALUES(?,?,?,?)').run('wa', 'group', 'request', new Date(at).toISOString());
  const state = {version: 0, exports: [], sends: [], acks: [], reads: [], waiters: [], sentAt: null, slowReads: 0, clock: at,
    nativeActive:true,nativePhase:'running',nativeFastReady:false,activityReads:0};
  let unblock, beginSlow;
  const slowStarted = new Promise(resolve => {beginSlow = resolve;});
  const slowGate = new Promise(resolve => {unblock = resolve;});
  const change = () => ({ok: true, cursor: `epoch:${state.version}`, threads: state.version ? ['route'] : []});
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    if (u.pathname === '/health') return Response.json({messageChanges: {version: 1, path: 'changes'}});
    if(u.pathname==='/threads/route/activity') {
      state.activityReads++;
      return Response.json({ok:true,version:1,publicThreadId:thread.id,publicMessageId:parent.id,phase:state.nativePhase,
        observedAtMs:state.nativePhase==='queued' ? null : state.clock,active:state.nativeActive,fastReady:state.nativeFastReady,finalReady:false});
    }
    if (u.pathname === '/changes') {
      if (u.searchParams.get('cursor') !== `epoch:${state.version}`) return Response.json({...change(), reset: !u.searchParams.get('cursor')});
      return new Promise((resolve, reject) => {
        const finish = () => {options.signal?.removeEventListener('abort', stop); resolve(Response.json(change()));};
        const stop = () => {state.waiters = state.waiters.filter(fn => fn !== finish); reject(new Error('aborted'));};
        state.waiters.push(finish); options.signal?.addEventListener('abort', stop, {once: true});
        if (options.signal?.aborted) stop();
      });
    }
    if (u.pathname.endsWith('/messages')) {
      state.reads.push(u.pathname);
      return Response.json({messages: [{id: 'remote-user', role: 'user', state: 'completed'}, ...state.exports.filter(row => !row.acked)], mirrorAck: {version: 1, ackedThrough: 0}});
    }
    if (u.pathname.endsWith('/mirror-acks')) {
      const ack = JSON.parse(options.body); state.acks.push(ack);
      const row = state.exports.find(row => row.id === ack.remoteMessageId); row.acked = true;
      return Response.json({ok: true, sequence: row.exportSequence, ackedThrough: row.exportSequence});
    }
    throw new Error(`unexpected request ${u.pathname}`);
  };
  const api = async (url, options = {}) => {
    if (url.endsWith('/watches')) return discoverRemoteMessageWatches(env, fetchImpl);
    if (url.includes('/remote-runtime/changes?')) {
      const query = new URL(url, 'http://v1.test').searchParams;
      return importRemoteMessageChanges({backendId: query.get('backend'), cursor: query.get('cursor'), signal: options.signal, signalOnly: query.get('signalOnly') === '1'}, env, fetchImpl);
    }
    if (url.includes('/remote-runtime/sync?')) {
      const query = new URL(url, 'http://v1.test').searchParams;
      return importRemoteMessageThread({backendId: query.get('backend'), threadId: query.get('thread'), signal: options.signal}, env, fetchImpl);
    }
    if(url.includes('/remote-runtime/input-activity?')) {
      const query=new URL(url,'http://v1.test').searchParams;
      return remoteInputActivity({threadId:query.get('thread'),publicMessageId:query.get('message')},env,fetchImpl,{now:()=>state.clock});
    }
    if (url.includes('/slow-thread')) {state.slowReads++; beginSlow(); await slowGate; return {thread: {ownerUserId: 'admin', binding: {enabled: true, chatId: 'slow-group'}}};}
    if (url.endsWith('/scoped-relay-delivery')) {
      const messageId = url.split('/')[5];
      await recordScopedRelayRemoteDelivery({thread: await getThread(thread.id, env), messageId, body: options.body}, env);
      await syncRemoteWhatsAppThreadMessages(env, fetchImpl, {threadIds: [thread.id], push: true});
      return {ok: true};
    }
    if (url.includes('/messages?')) return {messages: await listThreadMessages(thread.id, env)};
    return {thread: await getThread(thread.id, env)};
  };
  const config = {ownerUserId: 'admin', forwardProgressUpdates: true, forwardProgressSince: new Date(at - 1000).toISOString(),
    ...(acknowledgement ? {acknowledgement: {text: 'Empfangen ✓, ich arbeite daran', since: new Date(at - 1).toISOString()}} : {}),
    groups: [{threadId: thread.id, chatId: 'group', name: 'Example', deterministicAcknowledgement: acknowledgement},
      ...(slow ? [{threadId: 'slow-thread', chatId: 'slow-group', name: 'Slow'}] : [])]};
  const relay = createScopedGroupRelay({config, api, inboxDb: inbox, relayDb: db, env, now: () => state.clock,
    send: async payload => {state.sends.push(payload); state.sentAt = performance.now(); return {ok: true, ids: [`provider-${state.sends.length}`]};}});
  db.prepare('INSERT INTO routed VALUES(?,?,?,0)').run('wa', thread.id, parent.id);
  if (slow) db.prepare('INSERT INTO routed VALUES(?,?,?,0)').run('slow-wa', 'slow-thread', 'slow-input');
  const publish = (extra = {}) => {
    state.nativeFastReady=true;
    state.exports.push({id: `remote-${state.version + 1}`, role: 'assistant', state: 'completed', source: 'rust-v2-adapter', phase: 'commentary', kind: 'progress', text: 'Real Fast reply', parentMessageId: 'remote-user', createdAt: new Date(at).toISOString(), exportSequence: ++state.version, ...extra});
    for (const fn of state.waiters.splice(0)) fn();
  };
  t.after(() => {relay.close(); inbox.close(); db.close();});
  return {state, relay, api, env, fetchImpl, publish, parent, thread, slowStarted, unblock, inbox, db};
}
const until = async predicate => {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('synthetic event deadline');
    await new Promise(resolve => setImmediate(resolve));
  }
};

test('export wake -> V1 import -> Fast send and receipt acknowledgement without any background tick', async t => {
  const f = await fixture(t);
  const watch = startScopedRemoteWatch({api: f.api, deliver: async ids => assert.equal((await f.relay.deliverThreads(ids)).ok, true)});
  t.after(() => watch.close());
  await until(() => f.state.waiters.length > 0);
  const exportedAt = performance.now(); f.publish();
  await until(() => f.state.acks.length === 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.acks[0].outcome, 'delivered');
  assert.ok(f.state.sentAt - exportedAt < 1000, `synthetic export→send ${f.state.sentAt - exportedAt}ms`);
  await f.relay.deliverThreads([f.thread.id]);
  assert.equal(f.state.sends.length, 1);
  const imported = (await listThreadMessages(f.thread.id, f.env)).filter(row => row.role === 'assistant');
  assert.equal(imported.length, 1); assert.equal(imported[0].parentMessageId, f.parent.id);
  await watch.close();
});

test('a slow unrelated route does not block the import-triggered Fast send', async t => {
  const f = await fixture(t, {slow: true});
  const scan = f.relay.tick(); await f.slowStarted;
  f.publish();
  const batch = await importRemoteMessageChanges({backendId: 'example'}, f.env, f.fetchImpl);
  const started = performance.now();
  await Promise.all([f.relay.deliverThreads(batch.threadIds), f.relay.deliverThreads(batch.threadIds)]);
  assert.equal(f.state.sends.length, 1); assert.ok(performance.now() - started < 1000);
  f.unblock(); await scan;
});

test('parallel background/event imports cannot duplicate a reply', async t => {
  const f = await fixture(t); f.publish({phase: 'final_answer', kind: 'final'});
  await Promise.all(Array.from({length: 5}, () => syncRemoteWhatsAppThreadMessages(f.env, f.fetchImpl, {threadIds: [f.thread.id], push: true})));
  assert.equal((await listThreadMessages(f.thread.id, f.env)).filter(row => row.role === 'assistant').length, 1);
});

test('twenty-second active-work fallback and later Fast are both sent once through the real relay journals', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t, {acknowledgement: true});
  f.relay.scheduleAcknowledgements(); f.state.clock += 19999; t.mock.timers.tick(19999);
  assert.equal(f.state.sends.length,0);
  f.state.clock++;t.mock.timers.tick(1);
  await until(() => f.state.sends.length === 1);
  assert.equal(f.state.sends[0].text, 'Empfangen ✓, ich arbeite daran');
  f.publish();
  const batch = await importRemoteMessageChanges({backendId: 'example'}, f.env, f.fetchImpl);
  await f.relay.deliverThreads(batch.threadIds);
  f.relay.scheduleAcknowledgements(); t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.sends.length, 2); assert.match(f.state.sends[1].text, /Real Fast reply/);
});

test('Fast sent before twenty seconds and known NO_REPLY each suppress the scheduled ack', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const text of ['Fast before the deadline', 'NO_REPLY']) {
    const f = await fixture(t, {acknowledgement: true});
    f.publish({text, phase: text === 'NO_REPLY' ? 'final_answer' : 'commentary'});
    const batch = await importRemoteMessageChanges({backendId: 'example'}, f.env, f.fetchImpl);
    await f.relay.deliverThreads(batch.threadIds);
    f.relay.scheduleAcknowledgements(); f.state.clock += 20000; t.mock.timers.tick(20000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.sends.length, text === 'NO_REPLY' ? 0 : 1);
  }
});

test('a native Fast ready before import cancels the fallback without a provider attempt',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t,{acknowledgement:true});f.state.nativeFastReady=true;
  f.relay.scheduleAcknowledgements();f.state.clock+=20000;t.mock.timers.tick(20000);
  await until(()=>f.state.activityReads>0);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.sends.length,0);
  assert.equal((await listThreadMessages(f.thread.id,f.env)).filter(m=>m.role==='assistant').length,0);
});

test('global uncertain transport barrier blocks the immediate delivery path too', async t => {
  const f = await fixture(t); f.publish();
  const batch = await importRemoteMessageChanges({backendId: 'example'}, f.env, f.fetchImpl);
  f.inbox.prepare('INSERT INTO group_send VALUES(?,?)').run('uncertain-attempt', 'uncertain');
  const result = await f.relay.deliverThreads(batch.threadIds);
  assert.equal(result.ok, false); assert.equal(result.error, 'group_delivery_requires_review');
  assert.equal(f.state.sends.length, 0);
});

test('lost relay response retries the queued thread independently without another provider send', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const cursors = [];
  const api = (url, options) => {
    if (url.includes('/remote-runtime/changes?')) cursors.push(new URL(url, 'http://v1.test').searchParams.get('cursor'));
    return f.api(url, options);
  };
  const watch = startScopedRemoteWatch({api, deliver: async ids => {
    assert.equal((await f.relay.deliverThreads(ids)).ok, true);
    if (++attempts === 1) throw new Error('lost confirmation after durable send');
  }});
  t.after(() => watch.close());
  await until(() => f.state.waiters.length > 0);
  f.publish();
  await until(() => attempts === 2);
  assert.equal(f.state.sends.length, 1);
  assert.equal(cursors.filter(cursor => cursor === 'epoch:0').length, 1, 'notifications keep flowing while the thread retries');
  await watch.close();
});

test('restart recovers queued work from the adapter snapshot after its signal cursor advanced', async t => {
  const f = await fixture(t); f.publish();
  let blocked = false;
  const firstApi = (url, options) => {
    if (url.includes('/remote-runtime/sync?')) {
      blocked = true;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped before import')), {once: true}));
    }
    return f.api(url, options);
  };
  const first = startScopedRemoteWatch({api: firstApi, deliver: ids => f.relay.deliverThreads(ids)});
  await until(() => blocked); await first.close();
  assert.equal(f.state.sends.length, 0);
  const resumed = startScopedRemoteWatch({api: f.api, deliver: async ids => assert.equal((await f.relay.deliverThreads(ids)).ok, true)});
  try {
    await until(() => f.state.acks.length === 1);
    assert.equal(f.state.sends.length, 1);
  } finally {await resumed.close();}
});


test('queued backend input gets one queued notice through the real proxy and relay journals',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t,{acknowledgement:true});f.state.nativePhase='queued';f.state.nativeActive=false;
  f.relay.scheduleAcknowledgements();f.state.clock+=19999;t.mock.timers.tick(19999);
  assert.equal(f.state.sends.length,0);
  f.state.clock++;t.mock.timers.tick(1);
  await until(()=>f.db.prepare('SELECT count(*) n FROM reply_receipts').get().n===1);
  assert.equal(f.state.sends.length,1);assert.match(f.state.sends[0].text,/queued behind the current task/);
  f.state.nativePhase='running';f.state.nativeActive=true;
  f.relay.scheduleAcknowledgements();f.state.clock+=60000;t.mock.timers.tick(60000);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.sends.length,1);
  f.publish({phase:'final_answer',kind:'final',text:'The final answer'});
  const batch=await importRemoteMessageChanges({backendId:'example'},f.env,f.fetchImpl);
  await f.relay.deliverThreads(batch.threadIds);
  assert.equal(f.state.sends.length,2);assert.match(f.state.sends[1].text,/The final answer/);
  assert.equal(f.state.acks.length,1);assert.equal(f.state.acks[0].outcome,'delivered');
});

test('output arriving before the queued deadline cancels the queued notice',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t,{acknowledgement:true});f.state.nativePhase='queued';f.state.nativeActive=false;
  f.relay.scheduleAcknowledgements();
  f.publish();const batch=await importRemoteMessageChanges({backendId:'example'},f.env,f.fetchImpl);
  await f.relay.deliverThreads(batch.threadIds);
  f.state.clock+=20000;t.mock.timers.tick(20000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.sends.length,1);assert.match(f.state.sends[0].text,/Real Fast reply/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM scoped_acknowledgements').get().n,0);
});
