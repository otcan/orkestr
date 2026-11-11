// The owner's WhatsApp edits and deletions of inputs this transport journaled.
// Evidence only: the relay forwards a row. Nothing here runs a model or sends.
import crypto from 'node:crypto';

// A side table, for the same reason as group_input_media: group_input keeps
// the exact shape every earlier build writes positionally.
export const INPUT_REVISION_TABLE = 'CREATE TABLE IF NOT EXISTS group_input_revision(id TEXT PRIMARY KEY,input_id TEXT NOT NULL,chat_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT,created_at TEXT NOT NULL)';

const MAX_BODY_BYTES = 28672;
const serialized = value => (typeof value === 'string' ? value : value?._serialized) || '';

// A revoke can report the revocation's own id; `protocolMessageKey` then names
// the message it removed. Only an id already journaled as an input can match.
export function revisedInputCandidates(message, change = {}) {
  return [...new Set([serialized(message?.protocolMessageKey), serialized(change.revoked?.id), serialized(message?.id)].filter(Boolean))];
}

function revisionChat(message) {
  return serialized(message?.id?.remote) || (message?.fromMe === true ? message?.to : message?.from) || '';
}

export function createInputRevisionObserver({db, groups, now = Date.now, report = () => {}}) {
  db.exec(INPUT_REVISION_TABLE);
  const inputIn = (chatId, ids) => {
    for (const id of ids) {
      const row = db.prepare('SELECT id FROM group_input WHERE id=? AND chat_id=?').get(id, chatId);
      if (row) return row.id;
    }
    return null;
  };
  // `change:body` also fires when WhatsApp Web fills in a message, so only a
  // provider edit marker counts as the owner changing what they sent.
  function editOf(message, change, inputId) {
    const {newBody, prevBody} = change;
    if (typeof newBody !== 'string' || !newBody.trim() || newBody === prevBody || Buffer.byteLength(newBody) > MAX_BODY_BYTES) return null;
    const edited = message?.latestEditSenderTimestampMs || message?._data?.latestEditSenderTimestampMs;
    if (!edited && !message?.latestEditMsgKey && !message?._data?.latestEditMsgKey) {
      report({event: 'group_input_edit_without_marker', chatId: revisionChat(message)});
      return null;
    }
    const version = edited || crypto.createHash('sha256').update(newBody).digest('hex').slice(0, 32);
    return {id: `${inputId}:edit:${version}`, body: newBody};
  }
  return {
    record(message, change = {}) {
      if (change.kind !== 'edit' && change.kind !== 'delete') return false;
      const chatId = revisionChat(message);
      if (!groups.has(chatId)) return false;
      const inputId = inputIn(chatId, revisedInputCandidates(message, change));
      if (!inputId) return false;
      // A participant's input carries an author proof; only the owner's may change here.
      if (db.prepare('SELECT 1 FROM group_input_author WHERE id=?').get(inputId)) return false;
      // A group admin removing the owner's message is not the owner deleting it.
      const subtype = message?.subtype || message?._data?.subtype;
      if (change.kind === 'delete' && subtype === 'admin_revoke') return false;
      const revision = change.kind === 'edit' ? editOf(message, change, inputId) : {id: `${inputId}:delete`, body: null};
      if (!revision) return false;
      const result = db.prepare('INSERT OR IGNORE INTO group_input_revision(id,input_id,chat_id,kind,body,created_at) VALUES(?,?,?,?,?,?)')
        .run(revision.id, inputId, chatId, change.kind, revision.body, new Date(now()).toISOString());
      return Boolean(result.changes);
    },
  };
}
