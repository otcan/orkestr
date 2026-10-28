import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {scopedRouteMembership} from './whatsapp-scoped-route-membership.js';

export const notificationKey = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Timer-run notifications are scoped to explicit threads: the legacy single
// `threadId`, an explicit `threadIds` list, or `allGroups: true` (every
// configured group thread). Each thread may only notify its own bound chat,
// and every thread must belong to the validated delivery fence.
export function notificationScope(config) {
  const p = config.timerNotifications;
  if (!p?.enabled) return null;
  const invalid = () => { throw new Error('timer_notification_configuration_invalid'); };
  let fenced = null;
  try { fenced = scopedRouteMembership(config); } catch { fenced = null; }
  const groups = config.groups || [];
  const forms = [p.threadId !== undefined, p.threadIds !== undefined, p.allGroups !== undefined].filter(Boolean).length;
  if (forms !== 1 || (p.allGroups !== undefined && p.allGroups !== true)) invalid();
  const ids = p.allGroups ? groups.map(g => g.threadId) : p.threadIds !== undefined ? p.threadIds : [p.threadId];
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) invalid();
  const threads = new Map();
  for (const id of ids) {
    const matches = groups.filter(g => g.threadId === id);
    if (matches.length !== 1 || !fenced?.has(id)) invalid();
    threads.set(id, matches[0].chatId);
  }
  if (!p.proofDbPath || !Number.isFinite(Date.parse(p.since)) || !config.routeControl?.routeId || !config.routeControl?.dbPath) invalid();
  const chats = new Set(threads.values());
  const single = p.threadId !== undefined ? {threadId: p.threadId, chatId: threads.get(p.threadId)} : {};
  return {...p, ...single, threads, maxAgeMs: 900000, allowsChat: chatId => chats.has(chatId)};
}
// With `allGroups: true` and dynamicGroups, a group registered at runtime is a
// configured group too: its timer runs and V2 timer/post replies are scoped to
// it like a static group. `groups` is the live dynamic group view of the
// transport journal (createDynamicGroupView). Each registered thread still only
// notifies its own registered chat; a static thread or chat always wins.
// An explicit `threadId`/`threadIds` scope never grows.
export function liveNotificationScope(scope, groups) {
  if (!scope || scope.allGroups !== true || typeof groups?.dynamic !== 'function') return scope;
  const statics = scope.threads;
  const staticChats = new Set(statics.values());
  const registered = () => new Map(groups.dynamic()
    .filter(g => g.threadId && g.chatId && !statics.has(g.threadId) && !staticChats.has(g.chatId))
    .map(g => [g.threadId, g.chatId]));
  const threads = {
    has: id => statics.has(id) || registered().has(id),
    get: id => statics.has(id) ? statics.get(id) : registered().get(id),
    keys: () => [...statics.keys(), ...registered().keys()],
    values: () => [...statics.values(), ...registered().values()],
    entries: () => [...statics.entries(), ...registered().entries()],
    get size() { return statics.size + registered().size; },
  };
  const allowsChat = chatId => scope.allowsChat(chatId) || [...registered().values()].includes(chatId);
  return {...scope, threads, allowsChat};
}
export function createTimerNotificationProofStore({path, db: supplied, readOnly = false, now = Date.now}) {
  const db = supplied || new DatabaseSync(path, {readOnly});
  if (!readOnly) db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS timer_notification_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_runs(id TEXT PRIMARY KEY,event TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_done(id TEXT PRIMARY KEY,state TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_receipts(id TEXT PRIMARY KEY,provider_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_proofs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,chat_id TEXT NOT NULL,timer_id TEXT NOT NULL,parent_id TEXT NOT NULL,answer_id TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,run_at TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL);`);
  return {
    close() { if (!supplied) db.close(); },
    scannedAt() {return db.prepare("SELECT value FROM timer_notification_meta WHERE key='scanned_at'").get()?.value;},
    scanned(at) {db.prepare("INSERT OR REPLACE INTO timer_notification_meta VALUES('scanned_at',?)").run(at);},
    runs() { return db.prepare('SELECT event FROM timer_notification_runs').all().map(r=>JSON.parse(r.event)); },
    // Runs that still need a decision; finished runs are never re-read.
    pendingRuns() { return db.prepare('SELECT r.event FROM timer_notification_runs r LEFT JOIN timer_notification_done d ON d.id=r.id WHERE d.id IS NULL').all().map(r=>JSON.parse(r.event)); },
    finish(id, state, at) { db.prepare('INSERT OR IGNORE INTO timer_notification_done VALUES(?,?,?)').run(id,state,at); },
    finished(id) { return db.prepare('SELECT state FROM timer_notification_done WHERE id=?').get(id)?.state || null; },
    remember(event) { db.prepare('INSERT OR IGNORE INTO timer_notification_runs VALUES(?,?)').run(event.messageId,JSON.stringify(event)); },
    get(id) { return db.prepare('SELECT * FROM timer_notification_proofs WHERE id=?').get(id); },
    prepare(proof) {
      db.prepare("INSERT OR IGNORE INTO timer_notification_proofs VALUES(?,?,?,?,?,?,?,?,?,?,'prepared')").run(proof.id,proof.threadId,proof.chatId,proof.timerId,proof.parentId,proof.answerId,proof.text,proof.createdAt,proof.runAt,proof.expiresAt);
      return this.get(proof.id);
    },
    prepareBatch(proofs) {
      db.exec('BEGIN IMMEDIATE');
      try {for(const p of proofs)this.prepare(p);db.exec('COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
    },
    mark(id, state) {
      if (!['sent','uncertain','revoked'].includes(state)) throw new Error('timer_notification_invalid_state');
      db.prepare('UPDATE timer_notification_proofs SET state=? WHERE id=?').run(state,id);
    },
    receipt(id, ids) { db.prepare('INSERT OR REPLACE INTO timer_notification_receipts VALUES(?,?)').run(id,JSON.stringify((ids||[]).map(String))); },
    receipts(ids) { return [...new Set(ids.flatMap(id=>JSON.parse(db.prepare('SELECT provider_ids FROM timer_notification_receipts WHERE id=?').get(id)?.provider_ids||'[]')))]; },
    authorize({scope,id,to,text,parentId}) {
      const p = this.get(id);
      if (p && (!Number.isFinite(Date.parse(p.created_at)) || !Number.isFinite(Date.parse(p.expires_at)) || !Number.isFinite(Date.parse(p.run_at)))) throw new Error('timer_notification_proof_denied');
      if (!scope || !p || !scope.threads?.has(p.thread_id) || p.chat_id !== scope.threads.get(p.thread_id) || to !== p.chat_id || p.text !== text || p.parent_id !== parentId
          || !['prepared','sent'].includes(p.state) || Date.parse(p.created_at) < Date.parse(scope.since) || Date.parse(p.run_at) < Date.parse(scope.since)
          || Date.parse(p.expires_at) < now() || Date.parse(p.created_at) > now()) throw new Error('timer_notification_proof_denied');
      return p;
    },
  };
}
