import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const selfChatHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const selfChatError = (code, statusCode = 409) => Object.assign(new Error(code), { statusCode, retryable:false });

// No automatic recovery of pending sends: a crash after provider acceptance is
// indistinguishable from a crash before it. Preserve the reservation forever.
export class OwnerSelfChatJournal {
  constructor(filename, binding) {
    if (filename !== ':memory:') {
      const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      const st = fs.fstatSync(fd); fs.closeSync(fd);
      if (!st.isFile() || (st.mode & 0o077)) throw selfChatError('selfchat_journal_permissions');
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (key TEXT PRIMARY KEY, hash TEXT NOT NULL,
        state TEXT NOT NULL, ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'offered', route TEXT);
    `);
    const hash = selfChatHash(binding);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('binding', JSON.stringify(hash));
    if (this.meta('binding') !== hash) { this.close(); throw selfChatError('selfchat_journal_binding_changed'); }
  }
  meta(key) { const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unresolved() { return Boolean(this.db.prepare("SELECT 1 FROM sends WHERE state != 'sent' LIMIT 1").get()); }
  reserve(key, payload) {
    if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(key || '')) throw selfChatError('selfchat_request_id_required',400);
    const hash=selfChatHash(payload);
    return this.transaction(() => {
      const prior=this.db.prepare('SELECT * FROM sends WHERE key=?').get(key);
      if (prior) {
        if (prior.hash !== hash) throw selfChatError('selfchat_request_id_conflict');
        if (prior.state !== 'sent') throw selfChatError('selfchat_delivery_uncertain');
        return { duplicate:true, ids:JSON.parse(prior.ids) };
      }
      if (this.unresolved()) throw selfChatError('selfchat_delivery_uncertain');
      this.db.prepare("INSERT INTO sends (key,hash,state,created_at) VALUES (?,?,'pending',?)")
        .run(key,hash,new Date().toISOString());
      return { duplicate:false };
    });
  }
  sent(key, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id.startsWith('summary:')))
      throw selfChatError('selfchat_receipt_missing');
    this.db.prepare("UPDATE sends SET state='sent',ids=? WHERE key=? AND state='pending'").run(JSON.stringify(ids),key);
  }
  uncertain(key) { this.db.prepare("UPDATE sends SET state='uncertain' WHERE key=? AND state='pending'").run(key); }
  outboundIds() { return this.db.prepare("SELECT ids FROM sends WHERE state='sent'").all().flatMap(row=>JSON.parse(row.ids)); }
  consumedIds() { return this.db.prepare("SELECT id FROM inbound WHERE state='consumed'").all().map(row=>row.id); }
  routes() { return this.db.prepare("SELECT id,route FROM inbound WHERE state='consumed'").all().map(row=>({id:row.id,...JSON.parse(row.route)})); }
  offer(messages) {
    this.transaction(() => {
      for (const message of messages) this.db.prepare('INSERT OR IGNORE INTO inbound (id,body) VALUES (?,?)').run(message.id,JSON.stringify(message));
    });
    return this.pending();
  }
  pending() { return this.db.prepare("SELECT body FROM inbound WHERE state='offered' ORDER BY rowid").all().map(row=>JSON.parse(row.body)); }
  ack(id, route) {
    const prior=this.db.prepare('SELECT * FROM inbound WHERE id=?').get(id);
    if (!prior) throw selfChatError('selfchat_unknown_input');
    if (prior.state==='consumed' && prior.route!==JSON.stringify(route)) throw selfChatError('selfchat_input_route_conflict');
    this.db.prepare("UPDATE inbound SET state='consumed',route=? WHERE id=?").run(JSON.stringify(route),id);
  }
  close() { this.db.close(); }
}
