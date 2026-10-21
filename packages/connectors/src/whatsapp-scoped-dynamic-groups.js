// Dynamic group registration for the scoped group transport and relay.
//
// The static allowlist (`groups`) stays hash-bound to the transport journal.
// With `dynamicGroups: {enabled: true, since}` in the config, groups may also
// be registered at runtime, without a contract migration or a restart, in the
// journal's `group_registered` table. The relay is the only registrar: it
// registers an owner group thread only when V1 shows all of the following:
// - it belongs to the configured owner and is not retired;
// - its WhatsApp binding is enabled, names a group chat and has the legacy
//   mirror off;
// - its runtime is delegated to a remote (V2) backend;
// - it was created after `since`.
// It removes the registration again when any of that stops being true (for
// example an archived test chat). Every input is still checked against the
// thread binding by the relay before it is routed. Messages sent before a
// group was registered are never imported.
import {DatabaseSync} from 'node:sqlite';

export const DYNAMIC_GROUPS_TABLE = `CREATE TABLE IF NOT EXISTS group_registered(
  chat_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, name TEXT NOT NULL,
  registered_at TEXT NOT NULL, removed_at TEXT, reason TEXT)`;
const GROUP_CHAT = /^\d+(?:-\d+)?@g\.us$/;
const THREAD_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const fail = code => { throw new Error(`dynamic_groups_${code}`); };

// Optional block; absent means the transport and relay behave exactly as before.
export function validateDynamicGroups(config) {
  const block = config?.dynamicGroups;
  if (block === undefined) return null;
  if (!block || typeof block !== 'object' || block.enabled !== true || !Number.isFinite(Date.parse(block.since))) fail('configuration_invalid');
  const journals = block.journals === undefined ? [] : block.journals;
  if (!Array.isArray(journals) || journals.some(path => typeof path !== 'string' || !path.startsWith('/'))) fail('configuration_invalid');
  return {since: Date.parse(block.since), journals};
}

function tableExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_registered'").get());
}

// Live view of the registered groups of one journal. `db` may be read-only
// (relay, wrapper); then a journal without the table simply has none.
export function createDynamicGroupView(db, {static: staticGroups = new Map(), now = Date.now} = {}) {
  let cached = null, cachedAt = 0;
  const load = () => {
    if (cached && now() - cachedAt < 1000) return cached;
    const rows = tableExists(db)
      ? db.prepare('SELECT chat_id,thread_id,name,registered_at FROM group_registered WHERE removed_at IS NULL').all() : [];
    cached = new Map(rows.filter(row => !staticGroups.has(row.chat_id)).map(row => [row.chat_id,
      {chatId: row.chat_id, threadId: row.thread_id, name: row.name, registeredAt: row.registered_at, dynamic: true}]));
    cachedAt = now();
    return cached;
  };
  return {
    get: chatId => staticGroups.get(chatId) || load().get(chatId),
    has: chatId => staticGroups.has(chatId) || load().has(chatId),
    keys: () => [...staticGroups.keys(), ...load().keys()],
    dynamic: () => [...load().values()],
    get size() { return staticGroups.size + load().size; },
    refresh() { cached = null; },
  };
}

// The registrar's write side for one journal.
export function createDynamicGroupRegistry(path, {now = Date.now, staticGroups = []} = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000;${DYNAMIC_GROUPS_TABLE}`);
  const statics = new Map(staticGroups.map(g => [g.chatId, g]));
  return {
    register({chatId, threadId, name}) {
      if (!GROUP_CHAT.test(chatId || '') || !THREAD_ID.test(threadId || '')) fail('group_invalid');
      if (statics.has(chatId)) return {registered: false, reason: 'static'};
      const label = String(name || threadId).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || threadId;
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT * FROM group_registered WHERE chat_id=?').get(chatId);
        if (current && current.removed_at === null) {
          db.exec('COMMIT');
          if (current.thread_id !== threadId) fail('chat_conflict');
          return {registered: false, reason: 'present'};
        }
        const other = db.prepare('SELECT 1 FROM group_registered WHERE thread_id=? AND removed_at IS NULL').get(threadId)
          || [...statics.values()].some(g => g.threadId === threadId);
        if (other) { db.exec('COMMIT'); fail('thread_conflict'); }
        const at = new Date(now()).toISOString();
        db.prepare(`INSERT INTO group_registered(chat_id,thread_id,name,registered_at,removed_at,reason) VALUES(?,?,?,?,NULL,NULL)
          ON CONFLICT(chat_id) DO UPDATE SET thread_id=excluded.thread_id,name=excluded.name,registered_at=excluded.registered_at,removed_at=NULL,reason=NULL`)
          .run(chatId, threadId, label, at);
        db.exec('COMMIT');
        return {registered: true, at};
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already committed */ }
        throw error;
      }
    },
    remove(chatId, reason) {
      const result = db.prepare("UPDATE group_registered SET removed_at=?,reason=? WHERE chat_id=? AND removed_at IS NULL")
        .run(new Date(now()).toISOString(), String(reason || 'removed').slice(0, 64), chatId);
      return {removed: result.changes > 0};
    },
    active() {
      return db.prepare('SELECT chat_id,thread_id FROM group_registered WHERE removed_at IS NULL').all()
        .map(row => ({chatId: row.chat_id, threadId: row.thread_id}));
    },
    close() { db.close(); },
  };
}

// Which V1 threads should have a registered group right now (pure).
export function eligibleGroups(threads, {ownerUserId, since}) {
  const out = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const b = thread?.binding || {};
    const created = Date.parse(thread?.createdAt || '');
    const remote = String(b.remoteThreadId || b.remoteRuntimeThreadId || b.delegatedThreadId || '').trim();
    if (thread?.ownerUserId !== ownerUserId || thread?.retired === true || thread?.lifecycleState === 'retired') continue;
    if (String(b.connector || 'whatsapp').toLowerCase() !== 'whatsapp' || b.enabled === false || b.retired || b.deprecated) continue;
    if (!GROUP_CHAT.test(String(b.chatId || '')) || b.mirrorToWhatsApp !== false) continue;
    if (!remote || b.remoteRuntimeEnabled === false || b.remoteRouterEnabled === false) continue;
    if (!Number.isFinite(created) || created < since || !THREAD_ID.test(String(thread.id || ''))) continue;
    if (out.has(b.chatId)) continue;
    out.set(b.chatId, {chatId: b.chatId, threadId: thread.id, name: String(b.displayName || thread.name || thread.id)});
  }
  return out;
}
