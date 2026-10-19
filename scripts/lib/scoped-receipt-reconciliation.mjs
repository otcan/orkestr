import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(`receipt_reconciliation_${code}`); };

// Operator-only maintenance: no send, enqueue, configuration or session APIs.
// History must be freshly fetched from the configured authenticated worker.
export function acceptedReceipt(row, evidence, now = Date.now()) {
  if (!row || !['uncertain', 'sent'].includes(row.state)) fail('state');
  const checked = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(checked) || checked > now || now - checked > 60000) fail('stale_evidence');
  if (evidence.chatId !== row.chat_id || evidence.authenticated !== true || evidence.ready !== true) fail('scope');
  const start = Math.floor(Date.parse(row.created_at) / 1000) * 1000;
  if (!Number.isFinite(start)) fail('attempt_time');
  const matches = (evidence.messages || []).filter(m => {
    const at = Date.parse(m.timestamp);
    return m.fromMe === true && m.to === row.chat_id
      && typeof m.id === 'string' && m.id.startsWith(`true_${row.chat_id}_`)
      && at >= start && at <= start + 60000
      && digest([row.chat_id, m.body, row.parent_id]) === row.hash;
  });
  const ids = [...new Set(matches.map(m => m.id))];
  if (ids.length !== 1) fail('ambiguous_or_absent_receipt');
  if (row.state === 'sent' && row.provider_id !== ids[0]) fail('conflicting_receipt');
  return ids[0];
}

export function reconcileAcceptedReceipt({dbPath, fencePath, routeId, requestId, evidence, apply = false, now = Date.now()}) {
  const db = new DatabaseSync(dbPath, {readOnly: !apply});
  try {
    db.prepare('ATTACH DATABASE ? AS fence').run(fencePath);
    if (apply) db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM group_send WHERE id=?').get(requestId);
    const providerId = acceptedReceipt(row, evidence, now);
    const attempt = db.prepare('SELECT * FROM fence.delivery_attempt WHERE id=?').get(requestId);
    const active = db.prepare('SELECT * FROM fence.delivery_route WHERE id=1').get();
    if (!attempt || !active || attempt.route !== routeId || active.route !== routeId
        || attempt.epoch !== active.epoch || attempt.hash !== row.hash
        || !['uncertain', 'sent'].includes(attempt.state)
        || (attempt.state === 'sent' && attempt.provider_id !== providerId)) fail('fence_conflict');
    if (db.prepare('SELECT id FROM group_send WHERE provider_id=? AND id!=?').get(providerId, requestId)
        || db.prepare('SELECT id FROM fence.delivery_attempt WHERE provider_id=? AND id!=?').get(providerId, requestId)) fail('receipt_reused');
    const receipt = {requestId, providerIdDigest: digest(providerId), evidenceDigest: digest(evidence),
      previousTransportState: row.state, previousFenceState: attempt.state, checkedAt: evidence.checkedAt,
      changed: apply && (row.state !== 'sent' || attempt.state !== 'sent')};
    if (apply) {
      // Both journals remain fail-closed if a machine failure separates WAL commits:
      // rerunning this idempotent command repairs a matching partial reconciliation.
      db.exec('CREATE TABLE IF NOT EXISTS receipt_reconciliation(id TEXT PRIMARY KEY,evidence TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO receipt_reconciliation VALUES(?,?)').run(requestId, JSON.stringify(receipt));
      db.prepare("UPDATE fence.delivery_attempt SET state='sent',provider_id=? WHERE id=?").run(providerId, requestId);
      db.prepare("UPDATE group_send SET state='sent',provider_id=? WHERE id=?").run(providerId, requestId);
      db.exec('COMMIT');
    }
    return receipt;
  } catch (e) {
    if (apply) { try { db.exec('ROLLBACK'); } catch {} }
    throw e;
  } finally { db.close(); }
}
