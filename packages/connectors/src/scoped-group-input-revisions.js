// Forward the owner's WhatsApp edits and deletions of routed inputs to V1,
// which hands them to the runtime. Each change is forwarded at most once.
import crypto from 'node:crypto';

const BATCH = 16;
const definite = status => status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);

// Runs from the relay tick after routing, so a change never overtakes its
// input. Never throws: a failure is logged and the change is retried later.
export async function forwardInputRevisions({inbox, db, api, log = () => {}, errorCode = error => String(error?.message || 'unknown')}) {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS input_revisions_forwarded(id TEXT PRIMARY KEY,outcome TEXT NOT NULL)');
    // An older worker has no such table yet, and a read-only inbox cannot create it.
    if (!inbox.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_input_revision'").get()) return 0;
    let forwarded = 0;
    for (const row of inbox.prepare('SELECT * FROM group_input_revision ORDER BY created_at,rowid').all()) {
      if (forwarded >= BATCH) break;
      if (db.prepare('SELECT 1 FROM input_revisions_forwarded WHERE id=?').get(row.id)) continue;
      const route = db.prepare('SELECT thread_id,message_id FROM routed WHERE id=?').get(row.input_id);
      // Not routed yet: the next tick finds it once the input has been admitted.
      if (!route) continue;
      const revisionId = `wa:${crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 48)}`;
      try {
        await api(`/api/threads/${encodeURIComponent(route.thread_id)}/messages/${encodeURIComponent(route.message_id)}/scoped-relay-revision`,
          {method: 'POST', body: {revisionId, kind: row.kind, ...(row.kind === 'edit' ? {text: row.body} : {})}});
        db.prepare('INSERT OR IGNORE INTO input_revisions_forwarded VALUES(?,?)').run(row.id, 'forwarded');
        forwarded++;
        log({event: 'input_revision_forwarded', threadId: route.thread_id, kind: row.kind});
      } catch (error) {
        const status = Number(error?.statusCode || error?.status || 0);
        log({event: 'input_revision_failed', threadId: route.thread_id, kind: row.kind, code: errorCode(error), status});
        if (definite(status)) db.prepare('INSERT OR IGNORE INTO input_revisions_forwarded VALUES(?,?)').run(row.id, 'refused');
      }
    }
    return forwarded;
  } catch (error) {
    log({event: 'input_revision_error', code: errorCode(error)});
    return 0;
  }
}
