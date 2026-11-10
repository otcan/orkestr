import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createInputRevisionObserver, revisedInputCandidates} from '../packages/connectors/src/whatsapp-scoped-input-revisions.js';
import {forwardInputRevisions} from '../packages/connectors/src/scoped-group-input-revisions.js';
import {handleInboundRevision} from '../packages/connectors/src/whatsapp-local-bridge.js';

const GROUP = '120000000001@g.us';

function journal(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE group_input_author(id TEXT PRIMARY KEY,proof TEXT NOT NULL);`);
  const insert = db.prepare('INSERT INTO group_input VALUES(?,?,?,?)');
  insert.run('owner-1', GROUP, 'original', '2026-01-01T00:00:00Z');
  insert.run('member-1', GROUP, 'member text', '2026-01-01T00:00:01Z');
  db.prepare('INSERT INTO group_input_author VALUES(?,?)').run('member-1', '{}');
  return db;
}
const observer = db => createInputRevisionObserver({db, groups: new Map([[GROUP, {threadId: 'thread-1'}]]), now: () => Date.parse('2026-01-02T00:00:00Z')});
const edited = (patch = {}) => ({id: {_serialized: 'owner-1', remote: GROUP}, fromMe: true, to: GROUP, latestEditSenderTimestampMs: 1700000000000, ...patch});
const rows = db => db.prepare('SELECT id,input_id,kind,body FROM group_input_revision').all().map(row => ({...row}));

test('a genuine edit of the owners input is recorded once', t => {
  const db = journal(t), o = observer(db);
  assert.equal(o.record(edited(), {kind: 'edit', newBody: 'corrected', prevBody: 'original'}), true);
  assert.equal(o.record(edited(), {kind: 'edit', newBody: 'corrected', prevBody: 'original'}), false, 'a replay adds nothing');
  assert.deepEqual(rows(db), [{id: 'owner-1:edit:1700000000000', input_id: 'owner-1', kind: 'edit', body: 'corrected'}]);
});

test('a later edit of the same message is its own revision', t => {
  const db = journal(t), o = observer(db);
  o.record(edited(), {kind: 'edit', newBody: 'second', prevBody: 'original'});
  o.record(edited({latestEditSenderTimestampMs: 1700000000500}), {kind: 'edit', newBody: 'third', prevBody: 'second'});
  assert.deepEqual(rows(db).map(row => row.body), ['second', 'third']);
});

test('a body change WhatsApp did not mark as an edit is ignored', t => {
  const db = journal(t), o = observer(db);
  assert.equal(o.record(edited({latestEditSenderTimestampMs: undefined}), {kind: 'edit', newBody: 'filled in', prevBody: ''}), false);
  assert.equal(o.record(edited(), {kind: 'edit', newBody: 'original', prevBody: 'original'}), false);
  assert.equal(o.record(edited(), {kind: 'edit', newBody: '   ', prevBody: 'original'}), false);
  assert.equal(o.record(edited(), {kind: 'edit', newBody: 'x'.repeat(28673), prevBody: 'original'}), false);
  assert.deepEqual(rows(db), []);
});

test('only the owners journaled inputs in a configured group can change', t => {
  const db = journal(t), o = observer(db);
  const change = {kind: 'edit', newBody: 'x', prevBody: 'y'};
  assert.equal(o.record(edited({id: {_serialized: 'member-1', remote: GROUP}}), change), false, 'a participant input');
  assert.equal(o.record(edited({id: {_serialized: 'unknown', remote: GROUP}}), change), false, 'never journaled');
  assert.equal(o.record(edited({id: {_serialized: 'owner-1', remote: '120000000002@g.us'}}), change), false, 'another group');
  assert.equal(o.record(edited(), {kind: 'pin'}), false);
  assert.deepEqual(rows(db), []);
});

test('a revocation is matched through the key of the message it removed', t => {
  const db = journal(t), o = observer(db);
  const revoke = {id: {_serialized: 'revocation-stanza', remote: GROUP}, fromMe: true, to: GROUP, protocolMessageKey: {_serialized: 'owner-1'}};
  assert.deepEqual(revisedInputCandidates(revoke), ['owner-1', 'revocation-stanza']);
  assert.equal(o.record(revoke, {kind: 'delete'}), true);
  assert.equal(o.record(revoke, {kind: 'delete'}), false);
  assert.deepEqual(rows(db), [{id: 'owner-1:delete', input_id: 'owner-1', kind: 'delete', body: null}]);
});

test('a group admin removing the owners message is not the owner deleting it', t => {
  const db = journal(t), o = observer(db);
  assert.equal(o.record(edited({subtype: 'admin_revoke'}), {kind: 'delete'}), false);
  assert.equal(o.record(edited({_data: {subtype: 'admin_revoke'}}), {kind: 'delete'}), false);
  assert.deepEqual(rows(db), []);
});

function relay(t, respond = async () => ({ok: true})) {
  const inbox = journal(t);
  observer(inbox).record(edited(), {kind: 'edit', newBody: 'corrected', prevBody: 'original'});
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE routed(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)');
  const calls = [];
  const forward = () => forwardInputRevisions({inbox, db, api: async (url, options) => { calls.push({url, options}); return respond(); }});
  return {inbox, db, calls, forward};
}
const routeInput = db => db.prepare('INSERT INTO routed(id,thread_id,message_id) VALUES(?,?,?)').run('owner-1', 'thread-1', 'public-1');

test('a change waits for its input to be routed, then is forwarded exactly once', async t => {
  const {db, calls, forward} = relay(t);
  assert.equal(await forward(), 0);
  assert.equal(calls.length, 0);
  routeInput(db);
  assert.equal(await forward(), 1);
  assert.equal(await forward(), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/threads/thread-1/messages/public-1/scoped-relay-revision');
  assert.equal(calls[0].options.body.kind, 'edit');
  assert.equal(calls[0].options.body.text, 'corrected');
  assert.match(calls[0].options.body.revisionId, /^wa:[0-9a-f]{48}$/);
});

test('a failure retries and a definite refusal does not', async t => {
  let answer = Object.assign(new Error('unavailable'), {status: 502});
  const {db, calls, forward} = relay(t, async () => { if (answer) throw answer; return {ok: true}; });
  routeInput(db);
  await forward();
  await forward();
  assert.equal(calls.length, 2, 'a transient failure is retried');
  answer = Object.assign(new Error('scoped_relay_revision_target_invalid'), {status: 409});
  await forward();
  await forward();
  assert.equal(calls.length, 3, 'a definite refusal is final');
});

test('a journal from an older worker has nothing to forward', async t => {
  const inbox = journal(t), db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.equal(await forwardInputRevisions({inbox, db, api: async () => assert.fail('no call')}), 0);
});

test('the legacy router leaves a change alone', async () => {
  assert.deepEqual(await handleInboundRevision('account', edited(), {kind: 'edit'}, {}), {skipped: 'not_scoped'});
});
