import {DatabaseSync} from 'node:sqlite';
import {outreachError, validOutreachProviderId} from './whatsapp-outreach-policy.js';

// A single protected broker owns this journal for BOTH source accounts. The
// launcher must hold the journal's exclusive Unix socket lease before opening.
export function openOutreachJournal(path, policy, now = Date.now) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS outreach_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outreach_send(
      request_id TEXT PRIMARY KEY, hash TEXT NOT NULL, account_id TEXT NOT NULL,
      recipient TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('sending','sent','uncertain','blocked')),
      attempted_at INTEGER NOT NULL, settled_at INTEGER, provider_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS outreach_resolution(request_id TEXT PRIMARY KEY, outcome TEXT NOT NULL,
      evidence_ref TEXT NOT NULL, resolved_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS outreach_quota ON outreach_send(account_id,attempted_at);`);
  const prior = db.prepare("SELECT value FROM outreach_meta WHERE key='contract'").get();
  if (prior && prior.value !== policy.fingerprint) {
    db.close();
    throw outreachError('journal_contract_changed');
  }
  db.prepare("INSERT OR IGNORE INTO outreach_meta VALUES('contract',?)").run(policy.fingerprint);
  db.prepare("UPDATE outreach_send SET state='uncertain',settled_at=? WHERE state='sending'").run(now());

  const previous = (request, hash) => {
    const row = db.prepare('SELECT * FROM outreach_send WHERE request_id=?').get(request.requestId);
    if (!row) return null;
    if (row.hash !== hash) throw outreachError('request_conflict', 409);
    if (row.state !== 'sent') throw outreachError('delivery_held', 409);
    return {ok: true, ids: [row.provider_id], duplicate: true, state: 'sent'};
  };
  return {
    close: () => db.close(), previous,
    stopped: () => Boolean(db.prepare("SELECT 1 FROM outreach_meta WHERE key='stopped'").get()),
    hasUncertain: () => Boolean(db.prepare("SELECT 1 FROM outreach_send WHERE state='uncertain' LIMIT 1").get()),
    stop(reason) {
      if (!['owner_stop', 'official_cloud_api_approved'].includes(reason)) throw outreachError('stop_invalid', 400);
      db.prepare("INSERT OR IGNORE INTO outreach_meta VALUES('stopped',?)").run(reason);
      return {ok: true, stopped: true};
    },
    receipt(accountId, requestId) {
      const row = db.prepare('SELECT * FROM outreach_send WHERE account_id=? AND request_id=?').get(accountId, requestId);
      if (!row) throw outreachError('receipt_unknown', 404);
      return {ok: true, requestId, state: row.state, ids: row.provider_id ? [row.provider_id] : []};
    },
    reserve(request, hash, at) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = previous(request, hash);
        if (prior) {db.exec('COMMIT'); return prior;}
        if (db.prepare('SELECT 1 FROM outreach_send WHERE recipient=?').get(request.to))
          throw outreachError('recipient_already_claimed', 409);
        const quota = db.prepare('SELECT COUNT(*) AS n FROM outreach_send WHERE account_id=? AND MAX(attempted_at,COALESCE(settled_at,attempted_at))>?')
          .get(request.accountId, at - 86_400_000).n;
        if (quota >= policy.maxNewPer24h) throw outreachError('rolling_quota', 429);
        // Conservatively space ALL campaign attempts, even across source accounts.
        // A slow or timed-out send must not compress spacing after completion.
        const last = db.prepare('SELECT MAX(MAX(attempted_at,COALESCE(settled_at,attempted_at))) AS at FROM outreach_send').get().at;
        if (last !== null && at - last < policy.minSpacingMs) throw outreachError('spacing', 429);
        db.prepare('INSERT INTO outreach_send VALUES(?,?,?,?,?,?,NULL,NULL)')
          .run(request.requestId, hash, request.accountId, request.to, 'sending', at);
        db.exec('COMMIT');
        return null;
      } catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    settle(requestId, providerId, at) {
      db.prepare("UPDATE outreach_send SET state='sent',provider_id=?,settled_at=? WHERE request_id=? AND state='sending'")
        .run(providerId, at, requestId);
    },
    uncertain(requestId, at) {
      db.prepare("UPDATE outreach_send SET state='uncertain',settled_at=? WHERE request_id=? AND state='sending'").run(at, requestId);
    },
    // Offline operator-only reconciliation after checking provider history. A
    // confirmed non-send is held as blocked, never released for another attempt.
    reconcile({requestId, outcome, providerId, evidenceRef}, at) {
      if (!['sent', 'blocked'].includes(outcome) || typeof evidenceRef !== 'string' || !evidenceRef.trim()
          || evidenceRef.length > 200 || (outcome === 'sent' && !validOutreachProviderId(providerId))
          || (outcome === 'blocked' && providerId !== undefined))
        throw outreachError('resolution_invalid', 400);
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM outreach_send WHERE request_id=?').get(requestId);
        if (row?.state !== 'uncertain') throw outreachError('resolution_not_uncertain', 409);
        db.prepare('INSERT INTO outreach_resolution VALUES(?,?,?,?)').run(requestId, outcome, evidenceRef, at);
        db.prepare('UPDATE outreach_send SET state=?,provider_id=?,settled_at=? WHERE request_id=?')
          .run(outcome, providerId || null, at, requestId);
        db.exec('COMMIT');
        return {ok: true, requestId, state: outcome};
      } catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    // Operator-only preactivation import. Never exposed on the send socket. All
    // preexisting recipients, including uncertain attempts, must be represented.
    importBaseline(rows) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          // Quota baselines include first contacts OUTSIDE this campaign too.
          // Importing history never grants permission to send to those numbers.
          if (!row || !/^\d{6,20}@c\.us$/.test(row.to || '') || !policy.accounts.includes(row.accountId)
              || !['sent', 'uncertain', 'blocked'].includes(row.state) || !Number.isSafeInteger(row.at)
              || row.at < 0 || typeof row.requestId !== 'string' || !row.requestId
              || (row.state === 'sent' && !validOutreachProviderId(row.providerId)))
            throw outreachError('baseline_invalid');
          const existing = db.prepare('SELECT * FROM outreach_send WHERE request_id=?').get(row.requestId);
          if (existing) {
            if (existing.recipient !== row.to || existing.account_id !== row.accountId
                || existing.state !== row.state || existing.attempted_at !== row.at
                || existing.provider_id !== (row.providerId || null)) throw outreachError('baseline_conflict', 409);
            continue;
          }
          db.prepare('INSERT INTO outreach_send VALUES(?,?,?,?,?,?,?,?)').run(row.requestId, 'baseline', row.accountId,
            row.to, row.state, row.at, row.state === 'sent' ? row.at : null, row.providerId || null);
        }
        db.exec('COMMIT');
      } catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    status(at) {
      return {counts: db.prepare('SELECT state,COUNT(*) AS count FROM outreach_send GROUP BY state').all(),
        quota: policy.accounts.map(accountId => ({accountId, newLast24h: db.prepare(
          'SELECT COUNT(*) AS n FROM outreach_send WHERE account_id=? AND MAX(attempted_at,COALESCE(settled_at,attempted_at))>?').get(accountId, at-86_400_000).n}))};
    },
  };
}
