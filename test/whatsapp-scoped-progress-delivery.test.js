import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

const started = Date.parse('2026-01-02T00:00:00Z');
const note = (id, cursor, more = {}) => ({id, cursor, role: 'assistant', state: 'completed', source: 'claude-code',
  phase: 'commentary', parentMessageId: 'input-1', text: id, createdAt: new Date(started).toISOString(), ...more});

function fixture(t, {global = true, group, suppress = false} = {}) {
  const inboxDb = new DatabaseSync(':memory:'), relayDb = new DatabaseSync(':memory:');
  inboxDb.exec(`CREATE TABLE group_input(id,chat_id,body,created_at);CREATE TABLE group_send(state);
    INSERT INTO group_input VALUES('wa-1','example-group','hello','2026-01-02');`);
  const state = {at: started, messages: [], sends: [], attempts: [], fail: false, suppress};
  const config = {ownerUserId: 'admin', forwardProgressSince: '2026-01-01T00:00:00Z',
    ...(global === undefined ? {} : {forwardProgressUpdates: global}),
    groups: [{chatId: 'example-group', threadId: 'example-thread', name: 'Example',
      ...(group === undefined ? {} : {forwardProgressUpdates: group})}]};
  const api = async url => {
    if (url.endsWith('/input')) return {message: {id: 'input-1'}};
    if (url.includes('/messages?')) return {messages: state.messages};
    if (url.endsWith('/scoped-relay-files')) return {files: []};
    return {thread: {ownerUserId: 'admin', binding: {enabled: true, chatId: 'example-group',
      suppressWhatsAppUpdates: state.suppress}}};
  };
  const create = () => createScopedGroupRelay({config, api, inboxDb, relayDb, now: () => state.at, env: {},
    send: async payload => {
      state.attempts.push(payload);
      if (state.fail) throw new Error('transport_disconnected');
      state.sends.push({...payload, at: state.at});
      return {ok: true, ids: [`provider-${state.sends.length}`]};
    }});
  let relay = create();
  t.after(() => {relay.close(); inboxDb.close(); relayDb.close();});
  return {state, relayDb, config, get relay() {return relay;}, restart() {relay.close(); relay = create();}};
}

test('Claude started acknowledgement goes on first poll, later notes coalesce at one per minute, final is immediate', async t => {
  const f = fixture(t);
  f.state.at += 3000;
  f.state.messages = [note('Claude Code started working on your request.', 1), note('Checking files.', 2)];
  await f.relay.tick();
  assert.equal(f.state.sends.length, 1);
  assert.match(f.state.sends[0].text, /started working/);
  assert.equal(f.state.sends[0].at - started, 3000);
  f.state.at += 59_999;
  f.state.messages.push(note('Finishing the check.', 3));
  await f.relay.tick();
  assert.equal(f.state.sends.length, 1);
  f.state.at++;
  await f.relay.tick();
  assert.equal(f.state.sends.length, 2);
  assert.match(f.state.sends[1].text, /Finishing/);
  f.state.at += 60_000;
  await f.relay.tick();
  assert.equal(f.state.sends.length, 2, 'coalesced older commentary never returns');
  f.state.messages.push(note('Done.', 4, {phase: 'final_answer'}));
  assert.equal((await f.relay.tick()).completed, 1);
  assert.equal(f.state.sends.length, 3);
});

test('restart preserves the minute budget and retries the same in-flight message before newer notes', async t => {
  const f = fixture(t);
  f.state.messages = [note('Started.', 1)];
  await f.relay.tick();
  f.restart();
  f.state.at += 1000;
  f.state.messages.push(note('Working.', 2));
  await f.relay.tick();
  assert.equal(f.state.sends.length, 1);
  f.state.at += 59_000;
  f.state.fail = true;
  assert.equal((await f.relay.tick()).ok, false);
  const frozenRequest = f.state.attempts.at(-1).requestId;
  f.state.messages.push(note('Newer note.', 3));
  f.state.fail = false;
  f.restart();
  await f.relay.tick();
  assert.equal(f.state.sends.at(-1).requestId, frozenRequest);
  assert.match(f.state.sends.at(-1).text, /Working/);
  await f.relay.tick();
  assert.equal(f.state.sends.length, 2);
});

test('questions and approval requests bypass the commentary interval and binding suppression', async t => {
  const f = fixture(t);
  f.state.messages = [note('Started.', 1)];
  await f.relay.tick();
  f.state.suppress = true;
  f.state.messages.push(note('Another note.', 2), note('Approve this operation.', 3, {phase: 'awaiting_approval'}));
  await f.relay.tick();
  assert.equal(f.state.sends.length, 2);
  assert.match(f.state.sends.at(-1).text, /Approve/);
  f.state.messages.push(note('Which file?', 4, {phase: 'question'}));
  await f.relay.tick();
  assert.equal(f.state.sends.length, 3);
  assert.match(f.state.sends.at(-1).text, /Which/);
});

for (const [global, group, expected] of [[false, true, 1], [true, false, 0], [false, undefined, 0]]) {
  test(`group flag ${group} overrides global ${global}`, async t => {
    const f = fixture(t, {global, group});
    f.state.messages = [note('Started.', 1)];
    await f.relay.tick();
    assert.equal(f.state.sends.length, expected);
  });
}

test('default-on progress uses process activation cutoff without replaying old commentary', async t => {
  const f = fixture(t);
  delete f.config.forwardProgressUpdates;
  delete f.config.forwardProgressSince;
  f.restart();
  f.state.messages = [note('Old.', 1, {createdAt: new Date(started - 1).toISOString()}), note('Started.', 2)];
  await f.relay.tick();
  assert.equal(f.state.sends.length, 1);
  assert.match(f.state.sends[0].text, /Started/);
});

test('silent commentary spends no budget and a ready final supersedes a failed commentary attempt', async t => {
  const f = fixture(t);
  f.state.messages = [note('NO_REPLY', 1)];
  await f.relay.tick();
  assert.equal(f.state.sends.length, 0);
  f.state.messages.push(note('Started.', 2));
  f.state.fail = true;
  await f.relay.tick();
  f.state.fail = false;
  f.state.messages.push(note('Done.', 3, {phase: 'final_answer'}));
  assert.equal((await f.relay.tick()).completed, 1);
  assert.equal(f.state.sends.length, 1);
  assert.match(f.state.sends[0].text, /Done/);
});
