import {DatabaseSync} from 'node:sqlite';

const fail = code => { throw new Error(`delivery_route_${code}`); };
// Shared by both account transports. Operator-only activation; never a provider
// restriction detector. Evidence must come from the supported operator check.
export function createDeliveryRouteFence({dbPath, db: supplied, now = Date.now}) {
  const db = supplied || new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS delivery_route(id INTEGER PRIMARY KEY CHECK(id=1),route TEXT NOT NULL,epoch INTEGER NOT NULL,since TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_attempt(id TEXT PRIMARY KEY,hash TEXT NOT NULL,route TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,provider_id TEXT);`);
  const current = () => db.prepare('SELECT * FROM delivery_route WHERE id=1').get();
  const blocked = () => Boolean(db.prepare("SELECT 1 FROM delivery_attempt WHERE state IN ('sending','uncertain') LIMIT 1").get());
  const assertActive = route => {
    const r = current(); if (!r || r.route !== route) fail('inactive'); return r;
  };
  return {
    current, blocked, assertActive,
    close() { if (!supplied) db.close(); },
    activate({from = null, to, evidence}) {
      if (!to || !evidence || evidence.routeId !== to || !['restrictionCleared','authenticated','ready','identityVerified','oldRouteStopped','legacyRouterDisabled','transportJournalsClear'].every(k => evidence[k] === true)) fail('evidence_required');
      const checked = Date.parse(evidence.checkedAt);
      if (!Number.isFinite(checked) || checked > now() || now() - checked > 300000) fail('stale_evidence');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = current();
        if ((prior?.route || null) !== from || from === to) fail('compare_failed');
        if (blocked()) fail('delivery_unresolved');
        const initial=from===null && evidence.preserveExistingSince;
        if(initial && (!Number.isFinite(Date.parse(initial)) || Date.parse(initial)>now()))fail('invalid_initial_cutoff');
        const r = {route: to, epoch: (prior?.epoch || 0) + 1, since: initial || new Date(now()).toISOString()};
        db.prepare('INSERT OR REPLACE INTO delivery_route VALUES(1,?,?,?)').run(r.route,r.epoch,r.since);
        db.exec('COMMIT'); return r;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    reserve({id, hash, route, createdAt}) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = assertActive(route), prior = db.prepare('SELECT * FROM delivery_attempt WHERE id=?').get(id);
        if (prior) {
          if (prior.hash !== hash) fail('payload_conflict');
          if (prior.state !== 'sent') fail('delivery_unresolved');
          db.exec('COMMIT'); return {duplicate:true,providerId:prior.provider_id};
        }
        if (blocked()) fail('delivery_unresolved');
        if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < Date.parse(r.since)) fail('before_cutover');
        db.prepare("INSERT INTO delivery_attempt VALUES(?,?,?,?, 'sending',NULL)").run(id,hash,route,r.epoch);
        db.exec('COMMIT'); return {duplicate:false};
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    sent(id, providerId) {
      if (!providerId) fail('receipt_required');
      const changed=db.prepare("UPDATE delivery_attempt SET state='sent',provider_id=? WHERE id=? AND state='sending'").run(providerId,id);
      if (!changed.changes) fail('reservation_required');
    },
    uncertain(id) { db.prepare("UPDATE delivery_attempt SET state='uncertain' WHERE id=? AND state='sending'").run(id); },
    recover(route) { db.prepare("UPDATE delivery_attempt SET state='uncertain' WHERE route=? AND state='sending'").run(route); },
  };
}
