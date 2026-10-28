import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createScopedAcknowledgements} from '../packages/connectors/src/scoped-group-acknowledgements.js';
import {createKeyedSerial} from '../packages/connectors/src/scoped-relay-serial.js';
import {ACKNOWLEDGEMENT_TEXTS, detectLanguage} from '../packages/connectors/src/acknowledgement-language.js';

function fixture(t) {
  const inbox = new DatabaseSync(':memory:'), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE replies(id PRIMARY KEY,state);CREATE TABLE reply_receipts(id PRIMARY KEY,provider_ids);CREATE TABLE reply_sent_text(provider_id PRIMARY KEY,request_id,text,sent_at);');
  const state = {at: 0, sends: [], allowed: true, active: true, ready: false, blocked: false, fail: false};
  const group = {threadId: 'thread', deterministicAcknowledgement: true};
  const config = {acknowledgement: {text: 'Empfangen ✓, ich arbeite daran', language: 'de', since: new Date(0).toISOString()}};
  const input = {id: 'owner-input', chat_id: 'group', created_at: new Date(0).toISOString()};
  const options = {config, inbox, db, groups: new Map([['group', group]]), now: () => state.at, key: v => v,
    serial: createKeyedSerial(), blocked: () => state.blocked, inspect: async () => {
      state.inspections=(state.inspections||0)+1;
      if(state.onInspect)await state.onInspect(state.inspections);
      return {active:state.allowed && state.active, queued:state.allowed && state.queued, covered:state.ready, reason:'native_output_ready'};
    }, log() {},
    send: async payload => {
      state.sends.push(payload);
      if (state.fail) throw new Error('uncertain');
      return {ok: true, ids: ['provider-ack']};
    }};
  let ack = createScopedAcknowledgements(options);
  t.after(() => {ack.close(); db.close(); inbox.close();});
  return {input, state, group, config, db, inbox, get ack() {return ack;}, restart() {ack.close(); ack = createScopedAcknowledgements(options);}};
}

test('real send before twenty seconds suppresses the acknowledgement', async t => {
  const f = fixture(t); f.state.at = 19999;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 0);
  f.ack.mark(f.input.id, 'real_send_attempt'); f.state.at = 20000;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 0);
});

test('no sent real reply at twenty seconds produces exactly one frozen acknowledgement through restart', async t => {
  const f = fixture(t); f.state.at = 20000;
  await Promise.all(Array.from({length: 10}, () => f.ack.check(f.input)));
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].text, 'Empfangen ✓, ich arbeite daran');
  f.restart(); f.config.acknowledgement.text = 'changed';
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM reply_receipts').get().n, 1);
});

test('acknowledgement then native Fast remains allowed without a second acknowledgement', async t => {
  const f = fixture(t); f.state.at = 20000;
  await f.ack.check(f.input);
  f.ack.mark(f.input.id, 'real_send_attempt');
  // This gate only decides template sends; native delivery has its own journal.
  f.state.sends.push({text: 'A real Fast reply'});
  f.state.at += 60000; await f.ack.check(f.input);
  assert.equal(f.state.sends.length, 2);
});

test('uncertain attempt freezes the same text/request and cannot cause another send while blocked', async t => {
  const f = fixture(t); f.state.at = 20000; f.state.fail = true;
  await assert.rejects(f.ack.check(f.input));
  const first = f.state.sends[0];
  f.restart(); f.config.acknowledgement.text = 'changed'; f.state.blocked = true;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 1);
  // Definitive transport recovery reuses its idempotent request, never a new ID.
  f.state.blocked = false; f.state.fail = false; await f.ack.check(f.input);
  assert.deepEqual(f.state.sends[1], first);
});

test('known NO_REPLY, third-party author, opt-out, stale input and revoked binding are silent', async t => {
  for (const mode of ['no_reply', 'participant', 'optout', 'progress_optout', 'stale', 'revoked']) {
    const f = fixture(t); f.state.at = 20000;
    if (mode === 'no_reply') f.ack.mark(f.input.id, 'no_reply');
    if (mode === 'participant') {
      f.inbox.exec('CREATE TABLE group_input_author(id PRIMARY KEY,proof);');
      f.inbox.prepare('INSERT INTO group_input_author VALUES(?,?)').run(f.input.id, '{}');
    }
    if (mode === 'optout') f.group.deterministicAcknowledgement = false;
    if (mode === 'progress_optout') f.group.forwardProgressUpdates = false;
    if (mode === 'stale') f.state.at = 300001;
    if (mode === 'revoked') f.state.allowed = false;
    await f.ack.check(f.input); assert.equal(f.state.sends.length, 0, mode);
  }
});

test('fallback needs active work and a Fast-ready signal cancels it before any send',async t=>{
  const f=fixture(t);f.state.at=20000;f.state.active=false;
  await f.ack.check(f.input);assert.equal(f.state.sends.length,0);
  f.state.active=true;f.state.ready=true;
  await f.ack.check(f.input);assert.equal(f.state.sends.length,0);
  f.restart();f.state.ready=false;
  await f.ack.check(f.input);assert.equal(f.state.sends.length,0,'cancel remains durable');
});

test('Fast becoming ready while the fallback waits its send turn prevents the fallback',async t=>{
  const f=fixture(t);f.state.at=20000;
  f.state.onInspect=async count=>{if(count===2)f.state.ready=true;};
  await f.ack.check(f.input);assert.equal(f.state.sends.length,0);
  assert.equal(f.state.inspections,2);
});

test('the scheduled twenty-second fallback is cancelled immediately by real output',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);f.ack.schedule([f.input]);
  f.state.at=19999;t.mock.timers.tick(19999);
  f.ack.mark(f.input.id,'real_send_attempt');
  f.state.at=20000;t.mock.timers.tick(1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.sends.length,0);
});


test('queued input gets one truthful notice at twenty seconds, preserved through admission and restart',async t=>{
  const f=fixture(t);f.state.active=false;f.state.queued=true;f.state.at=19999;
  f.input.body='Can you check the schedule for me please?';
  await f.ack.check(f.input);assert.equal(f.state.sends.length,0);
  f.state.at=20000;
  await Promise.all(Array.from({length:10},()=>f.ack.check(f.input)));
  assert.equal(f.state.sends.length,1);
  assert.equal(f.state.sends[0].text,"Received, queued behind the current task in this chat; I'll answer when it finishes.");
  f.restart();f.state.active=true;f.state.queued=false;f.state.at=60000;
  await f.ack.check(f.input);assert.equal(f.state.sends.length,1,'admission must not produce a second notice');
  assert.equal(f.db.prepare('SELECT count(*) n FROM reply_receipts').get().n,1);
});

test('queued notice uses the explicitly configured acknowledgement language',async t=>{
  const f=fixture(t);f.state.active=false;f.state.queued=true;f.state.at=20000;
  f.config.acknowledgement.queuedText='Empfangen, die Nachricht wartet hinter der aktuellen Aufgabe in diesem Chat. Ich antworte, sobald diese abgeschlossen ist.';
  f.restart();await f.ack.check(f.input);
  assert.equal(f.state.sends[0].text,f.config.acknowledgement.queuedText);
});

test('queued fallback is canceled by delivered output or Fast ready, including while waiting for send',async t=>{
  for(const mode of ['delivered','fast','during_send']){
    const f=fixture(t);f.state.active=false;f.state.queued=true;f.state.at=20000;
    if(mode==='delivered')f.ack.mark(f.input.id,'real_send_attempt');
    if(mode==='fast')f.state.ready=true;
    if(mode==='during_send')f.state.onInspect=async count=>{if(count===2)f.state.ready=true;};
    await f.ack.check(f.input);assert.equal(f.state.sends.length,0,mode);
  }
});

test('acknowledgements follow the language of the message they answer, not one configured language',async t=>{
  // biofuture 2026-10-27: an English chat got the German queue notice and ack.
  const cases=[
    ['active','Did you send the meeting request to John?',ACKNOWLEDGEMENT_TEXTS.en.text],
    ['queued','Here is the calendar link, can you check it?',ACKNOWLEDGEMENT_TEXTS.en.queuedText],
    ['queued','Bunu bir kontrol eder misin lütfen?',ACKNOWLEDGEMENT_TEXTS.tr.queuedText],
    ['active','Kannst du das bitte noch prüfen?','Empfangen ✓, ich arbeite daran'],
  ];
  for(const [state,body,expected] of cases){
    const f=fixture(t);f.state.at=20000;f.input.body=body;
    f.config.acknowledgement.queuedText='Empfangen, die Nachricht wartet hinter der aktuellen Aufgabe in diesem Chat. Ich antworte, sobald diese abgeschlossen ist.';
    if(state==='queued'){f.state.active=false;f.state.queued=true;}
    f.restart();await f.ack.check(f.input);
    assert.equal(f.state.sends[0].text,expected,body);
  }
});

test('an ambiguous message uses the chat language, then the policy language, then English',async t=>{
  for(const [groupLanguage,policyLanguage,expected] of [['en','de',ACKNOWLEDGEMENT_TEXTS.en.text],
    [undefined,'de','Empfangen ✓, ich arbeite daran'],['tr',undefined,ACKNOWLEDGEMENT_TEXTS.tr.text],
    [undefined,undefined,ACKNOWLEDGEMENT_TEXTS.en.text],['xx',undefined,ACKNOWLEDGEMENT_TEXTS.en.text]]){
    const f=fixture(t);f.state.at=20000;f.input.body='Dev + live';
    if(groupLanguage)f.group.language=groupLanguage;
    if(policyLanguage)f.config.acknowledgement.language=policyLanguage;else delete f.config.acknowledgement.language;
    f.restart();await f.ack.check(f.input);
    assert.equal(f.state.sends[0].text,expected,`${groupLanguage}/${policyLanguage}`);
  }
});

test('a configured text without a language never overrides another language',async t=>{
  const f=fixture(t);f.state.at=20000;delete f.config.acknowledgement.language;f.input.body='Kannst du das bitte prüfen?';
  f.config.acknowledgement.text='Custom wording';f.restart();await f.ack.check(f.input);
  assert.equal(f.state.sends[0].text,ACKNOWLEDGEMENT_TEXTS.de.text);
});

test('an unknown policy language is refused at startup',t=>{
  assert.throws(()=>fixture(t).config && createScopedAcknowledgements({config:{acknowledgement:{text:'x',since:new Date(0).toISOString(),language:'xx'}},
    db:new DatabaseSync(':memory:')}),/group_acknowledgement_language_invalid/);
});

test('language detection is conservative',()=>{
  assert.equal(detectLanguage('Dev + live please'),null);
  assert.equal(detectLanguage('ok'),null);
  assert.equal(detectLanguage('Did you deploy? Aysegul cannot login'),'en');
  assert.equal(detectLanguage('Toplantı saatini değiştirebilir misin?'),'tr');
  assert.equal(detectLanguage('Ich habe das noch nicht gesehen'),'de');
});
