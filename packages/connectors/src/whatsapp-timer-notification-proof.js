import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const notificationKey = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function notificationScope(config) {
  const p = config.timerNotifications;
  if (!p?.enabled) return null;
  const group = config.groups?.find(g => g.threadId === p.threadId);
  if (!group || !p.proofDbPath || !Number.isFinite(Date.parse(p.since)) || !config.routeControl?.routeId || !config.routeControl?.dbPath || config.routeControl.threadId !== p.threadId)
    throw new Error('timer_notification_configuration_invalid');
  return {...p, chatId: group.chatId, maxAgeMs: 900000};
}
export function createTimerNotificationProofStore({path, db: supplied, readOnly = false, now = Date.now}) {
  const db = supplied || new DatabaseSync(path, {readOnly});
  if (!readOnly) db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS timer_notification_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_runs(id TEXT PRIMARY KEY,event TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timer_notification_proofs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,chat_id TEXT NOT NULL,timer_id TEXT NOT NULL,parent_id TEXT NOT NULL,answer_id TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,run_at TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL);`);
  return {
    close() { if (!supplied) db.close(); },
    scannedAt() {return db.prepare("SELECT value FROM timer_notification_meta WHERE key='scanned_at'").get()?.value;},
    scanned(at) {db.prepare("INSERT OR REPLACE INTO timer_notification_meta VALUES('scanned_at',?)").run(at);},
    runs() { return db.prepare('SELECT event FROM timer_notification_runs').all().map(r=>JSON.parse(r.event)); },
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
    authorize({scope,id,to,text,parentId}) {
      const p = this.get(id);
      if (p && (!Number.isFinite(Date.parse(p.created_at)) || !Number.isFinite(Date.parse(p.expires_at)) || !Number.isFinite(Date.parse(p.run_at)))) throw new Error('timer_notification_proof_denied');
      if (!scope || !p || p.thread_id !== scope.threadId || p.chat_id !== scope.chatId || to !== scope.chatId || p.text !== text || p.parent_id !== parentId
          || !['prepared','sent'].includes(p.state) || Date.parse(p.created_at) < Date.parse(scope.since) || Date.parse(p.run_at) < Date.parse(scope.since)
          || Date.parse(p.expires_at) < now() || Date.parse(p.created_at) > now()) throw new Error('timer_notification_proof_denied');
      return p;
    },
  };
}
