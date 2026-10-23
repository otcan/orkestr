import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createScopedAcknowledgements} from '../packages/connectors/src/scoped-group-acknowledgements.js';
import {createKeyedSerial} from '../packages/connectors/src/scoped-relay-serial.js';

function fixture(t) {
  const inbox = new DatabaseSync(':memory:'), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE replies(id PRIMARY KEY,state);CREATE TABLE reply_receipts(id PRIMARY KEY,provider_ids);CREATE TABLE reply_sent_text(provider_id PRIMARY KEY,request_id,text,sent_at);');
  const state = {at: 0, sends: [], allowed: true, blocked: false, fail: false};
  const group = {threadId: 'thread', deterministicAcknowledgement: true};
  const config = {acknowledgement: {text: 'Empfangen ✓, ich arbeite daran', since: new Date(0).toISOString()}};
  const input = {id: 'owner-input', chat_id: 'group', created_at: new Date(0).toISOString()};
  const options = {config, inbox, db, groups: new Map([['group', group]]), now: () => state.at, key: v => v,
    serial: createKeyedSerial(), blocked: () => state.blocked, inspect: async () => state.allowed, log() {},
    send: async payload => {
      state.sends.push(payload);
      if (state.fail) throw new Error('uncertain');
      return {ok: true, ids: ['provider-ack']};
    }};
  let ack = createScopedAcknowledgements(options);
  t.after(() => {ack.close(); db.close(); inbox.close();});
  return {input, state, group, config, db, inbox, get ack() {return ack;}, restart() {ack.close(); ack = createScopedAcknowledgements(options);}};
}

test('real send before five seconds suppresses the acknowledgement', async t => {
  const f = fixture(t); f.state.at = 4999;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 0);
  f.ack.mark(f.input.id, 'real_send_attempt'); f.state.at = 5000;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 0);
});

test('no sent real reply at five seconds produces exactly one frozen acknowledgement through restart', async t => {
  const f = fixture(t); f.state.at = 5000;
  await Promise.all(Array.from({length: 10}, () => f.ack.check(f.input)));
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].text, 'Empfangen ✓, ich arbeite daran');
  f.restart(); f.config.acknowledgement.text = 'changed';
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM reply_receipts').get().n, 1);
});

test('acknowledgement then native Fast remains allowed without a second acknowledgement', async t => {
  const f = fixture(t); f.state.at = 5000;
  await f.ack.check(f.input);
  f.ack.mark(f.input.id, 'real_send_attempt');
  // This gate only decides template sends; native delivery has its own journal.
  f.state.sends.push({text: 'A real Fast reply'});
  f.state.at += 60000; await f.ack.check(f.input);
  assert.equal(f.state.sends.length, 2);
});

test('uncertain attempt freezes the same text/request and cannot cause another send while blocked', async t => {
  const f = fixture(t); f.state.at = 5000; f.state.fail = true;
  await assert.rejects(f.ack.check(f.input));
  const first = f.state.sends[0];
  f.restart(); f.config.acknowledgement.text = 'changed'; f.state.blocked = true;
  await f.ack.check(f.input); assert.equal(f.state.sends.length, 1);
  // Definitive transport recovery reuses its idempotent request, never a new ID.
  f.state.blocked = false; f.state.fail = false; await f.ack.check(f.input);
  assert.deepEqual(f.state.sends[1], first);
});

test('known NO_REPLY, third-party author, opt-out, stale input and revoked binding are silent', async t => {
  for (const mode of ['no_reply', 'participant', 'optout', 'stale', 'revoked']) {
    const f = fixture(t); f.state.at = 5000;
    if (mode === 'no_reply') f.ack.mark(f.input.id, 'no_reply');
    if (mode === 'participant') {
      f.inbox.exec('CREATE TABLE group_input_author(id PRIMARY KEY,proof);');
      f.inbox.prepare('INSERT INTO group_input_author VALUES(?,?)').run(f.input.id, '{}');
    }
    if (mode === 'optout') f.group.deterministicAcknowledgement = false;
    if (mode === 'stale') f.state.at = 300001;
    if (mode === 'revoked') f.state.allowed = false;
    await f.ack.check(f.input); assert.equal(f.state.sends.length, 0, mode);
  }
});
