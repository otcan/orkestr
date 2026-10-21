// Owner-authorized group creation on a scoped native worker.
//
// The scoped worker normally never creates chats. With
//
//   "groupCreate": {"enabled": true, "authorizedAt": "<ISO>", "ownerParticipantIds": ["<owner number>@c.us"]}
//
// in its config it creates one kind of group: the owner's own numbers only.
// The worker account is the creator; every other participant must be one of
// `ownerParticipantIds`. The request is the V1 `POST /chats` body:
// - its `operationId` is the idempotency key, journaled in `group_create`;
// - a repeated id returns the recorded group;
// - an unconfirmed attempt is settled by reading the account's groups back:
//   exactly one new group with this title and these participants, created
//   after the attempt started;
// - an unsettled id is refused for that id only and never blocks other
//   creates or any send.
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createWhatsAppGroupWithClient} from './whatsapp-group-create-client.js';
import {adaptWhatsAppGroupCreateResult} from './whatsapp-group-create-evidence.js';

const OWNER_ID = /^\d{5,24}@c\.us$/;
const OPERATION_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const GROUP_ID = /^\d+(?:-\d+)?@g\.us$/;
const TABLE = `CREATE TABLE IF NOT EXISTS group_create(id TEXT PRIMARY KEY, hash TEXT NOT NULL, name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','created','unsettled')), group_id TEXT, started_at TEXT NOT NULL, settled_at TEXT)`;
const deny = (code, statusCode = 403) => { throw Object.assign(new Error(`scoped_group_create_${code}`), {statusCode}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean))];

// Returns null without the block (the default: no group creation at all).
export function validateScopedGroupCreate(config = {}) {
  const block = config.groupCreate;
  if (block === undefined) return null;
  const owners = unique(block?.ownerParticipantIds);
  if (!block || block.enabled !== true || !Number.isFinite(Date.parse(block.authorizedAt))
      || !owners.length || owners.length > 8 || owners.some(id => !OWNER_ID.test(id) || id === config.ownChatId))
    deny('configuration_invalid', 500);
  return {owners: new Set(owners)};
}

// The narrow request shape the policy admits (V1 thread-groups `POST /chats`).
export function scopedGroupCreateRequest(policy, workerAccountId, body = {}) {
  if (!policy) return null;
  const allowed = ['name', 'senderAccountId', 'accountId', 'responderAccountId', 'participantIds', 'adminParticipantIds',
    'promoteParticipantsAsAdmins', 'generatePicture', 'deferSetup', 'operationId', 'correlationId'];
  if (Object.keys(body || {}).some(key => !allowed.includes(key))) return null;
  const name = String(body.name || '').trim();
  const participants = unique(body.participantIds);
  const admins = unique(body.adminParticipantIds);
  const accounts = unique([body.senderAccountId || body.accountId, body.responderAccountId]);
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (!OPERATION_ID.test(String(body.operationId || ''))) return null;
  if (!participants.length || participants.some(id => !policy.owners.has(id))) return null;
  if (admins.some(id => !participants.includes(id))) return null;
  if (accounts.some(id => id !== workerAccountId)) return null;
  return {name, participants: participants.sort(), admins: body.promoteParticipantsAsAdmins === true ? participants : admins,
    operationId: String(body.operationId)};
}

export function createScopedGroupCreator({config, dbPath = config.journalPath, now = Date.now, lookupDelayMs = 2000}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000;${TABLE}`);
  let tail = Promise.resolve();
  const serial = work => { const next = tail.catch(() => {}).then(work); tail = next; return next; };

  // Exactly one own group with this title and these participants, created
  // after the attempt started and not recorded for another operation.
  async function readBack(client, request, startedAt) {
    if (typeof client?.getChats !== 'function') return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, lookupDelayMs));
      try {
        const found = (await client.getChats()).filter(chat => {
          const id = chat?.id?._serialized;
          const created = Number(chat?.groupMetadata?.creation || chat?.timestamp || 0) * 1000;
          const members = new Set((chat?.groupMetadata?.participants || chat?.participants || []).map(p => p?.id?._serialized).filter(Boolean));
          return chat?.isGroup === true && GROUP_ID.test(id || '') && chat.name === request.name
            && created >= startedAt - 5000 && request.participants.every(p => members.has(p))
            && !db.prepare("SELECT 1 FROM group_create WHERE group_id=? AND id<>?").get(id, request.operationId);
        });
        if (found.length === 1) return found[0].id._serialized;
        if (found.length > 1) return null;
      } catch { /* a failed read proves nothing; retry */ }
    }
    return null;
  }

  // Owner members become admins and may post; failures are reported, never retried as a create.
  async function finish(client, groupId, request) {
    const setup = {admins: false, open: false};
    try {
      const chat = await client.getChatById(groupId);
      if (request.admins.length && typeof chat?.promoteParticipants === 'function') {
        await chat.promoteParticipants(request.admins); setup.admins = true;
      }
      if (typeof chat?.setMessagesAdminsOnly === 'function') { await chat.setMessagesAdminsOnly(false); setup.open = true; }
    } catch { /* recorded below */ }
    return setup;
  }

  const answer = (groupId, request, extra = {}) => ({
    ok: true, chat: {id: groupId, name: request.name, isGroup: true, generated: true},
    chatId: groupId, participantIds: request.participants, adminParticipantIds: request.admins, ...extra,
  });

  return {
    create(client, request, workerAccountId) {
      return serial(async () => {
        const material = hash([request.name, request.participants]);
        const previous = db.prepare('SELECT * FROM group_create WHERE id=?').get(request.operationId);
        if (previous) {
          if (previous.hash !== material) deny('request_conflict', 409);
          if (previous.state === 'created') return answer(previous.group_id, request, {duplicate: true, senderAccountId: workerAccountId, responderAccountId: workerAccountId});
          const found = await readBack(client, request, Date.parse(previous.started_at));
          if (!found) {
            db.prepare("UPDATE group_create SET state='unsettled' WHERE id=?").run(request.operationId);
            deny('outcome_unsettled', 409);
          }
          db.prepare("UPDATE group_create SET state='created',group_id=?,settled_at=? WHERE id=?").run(found, new Date(now()).toISOString(), request.operationId);
          return answer(found, request, {reconciled: true, setup: await finish(client, found, request), senderAccountId: workerAccountId, responderAccountId: workerAccountId});
        }
        const startedAt = now();
        db.prepare("INSERT INTO group_create(id,hash,name,state,group_id,started_at) VALUES(?,?,?,'creating',NULL,?)")
          .run(request.operationId, material, request.name, new Date(startedAt).toISOString());
        let groupId = '';
        try {
          const result = await createWhatsAppGroupWithClient(client, request.name, request.participants, {announce: false},
            {operationId: request.operationId, correlationId: request.operationId});
          const evidence = adaptWhatsAppGroupCreateResult(result);
          groupId = evidence.ok && GROUP_ID.test(evidence.groupId) ? evidence.groupId : '';
        } catch (error) {
          // Not dispatched: nothing exists, the id may be retried.
          if (error?.groupCreateFailure?.externalOutcome === 'not_created') {
            db.prepare('DELETE FROM group_create WHERE id=? AND state=?').run(request.operationId, 'creating');
            throw error;
          }
        }
        if (!groupId) groupId = await readBack(client, request, startedAt) || '';
        if (!groupId) {
          db.prepare("UPDATE group_create SET state='unsettled' WHERE id=?").run(request.operationId);
          deny('outcome_unsettled', 409);
        }
        db.prepare("UPDATE group_create SET state='created',group_id=?,settled_at=? WHERE id=?").run(groupId, new Date(now()).toISOString(), request.operationId);
        return answer(groupId, request, {setup: await finish(client, groupId, request), senderAccountId: workerAccountId, responderAccountId: workerAccountId});
      });
    },
    close() { db.close(); },
  };
}
