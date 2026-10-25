// Progress policy and a durable per-input budget for local V1 commentary.
// Remote adapter exports keep their own acknowledgement and pacing contract.
export const progressPhases = new Set(['commentary', 'awaiting_approval']);
const sources = new Set(['codex-rollout', 'codex-app-server', 'codex-app-server-import', 'claude-code']);
const intervalMs = 60_000;
const remoteProgress = m => m.source === 'rust-v2-adapter' && m.remoteKind === 'progress'
  && typeof m.remoteMessageId === 'string' && Boolean(m.remoteMessageId.trim()) && !m.remoteMirrorAck?.outcome;

export function progressPolicy(config, startedAt) {
  for (const value of [config, ...(config.groups || [])]) {
    if (value.forwardProgressUpdates !== undefined && typeof value.forwardProgressUpdates !== 'boolean')
      throw new Error('group_progress_flag_invalid');
  }
  const configuredSince = Date.parse(config.forwardProgressSince || '');
  if (config.forwardProgressUpdates === true && !Number.isFinite(configuredSince))
    throw new Error('group_progress_cutoff_required');
  const since = Number.isFinite(configuredSince) ? configuredSince : startedAt;
  return (message, group, suppressUpdates = false) =>
    (group.forwardProgressUpdates ?? config.forwardProgressUpdates ?? true)
    && progressPhases.has(message.phase) && (sources.has(message.source) || remoteProgress(message))
    && !(suppressUpdates && message.phase === 'commentary')
    && Number.isFinite(Date.parse(message.createdAt)) && Date.parse(message.createdAt) >= since;
}

export function createProgressBudget(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS scoped_progress_state(
      input_id TEXT PRIMARY KEY,last_sent_ms INTEGER,inflight_id TEXT);
    CREATE TABLE IF NOT EXISTS scoped_progress_seen(
      input_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(input_id,message_id));`);
  const seen = db.prepare('SELECT 1 FROM scoped_progress_seen WHERE input_id=? AND message_id=?');
  return {
    select(inputId, messages) {
      const pending = messages.filter(m => String(m.text || '').trim() && String(m.text).trim() !== 'NO_REPLY'
        && !seen.get(inputId, m.id));
      if (!pending.length) return null;
      const state = db.prepare('SELECT * FROM scoped_progress_state WHERE input_id=?').get(inputId);
      if (state?.inflight_id) {
        const inflight = pending.find(m => m.id === state.inflight_id);
        if (!inflight) throw new Error('group_progress_inflight_missing');
        return inflight;
      }
      if (state?.last_sent_ms != null && now() - state.last_sent_ms < intervalMs) return null;
      // First acknowledgement goes on the first poll. Later polls choose the
      // newest note, so old updates never drip out after newer work.
      const selected = state?.last_sent_ms != null ? pending.at(-1) : pending[0];
      db.prepare(`INSERT INTO scoped_progress_state(input_id,inflight_id) VALUES(?,?)
        ON CONFLICT(input_id) DO UPDATE SET inflight_id=excluded.inflight_id`).run(inputId, selected.id);
      return selected;
    },
    delivered(inputId, selected, messages) {
      const state = db.prepare('SELECT * FROM scoped_progress_state WHERE input_id=?').get(inputId);
      if (state?.inflight_id !== selected.id) throw new Error('group_progress_receipt_mismatch');
      const through = messages.findIndex(m => m.id === selected.id);
      if (through < 0) throw new Error('group_progress_message_missing');
      db.exec('BEGIN IMMEDIATE');
      try {
        const mark = db.prepare('INSERT OR IGNORE INTO scoped_progress_seen VALUES(?,?)');
        for (const message of messages.slice(0, through + 1)) mark.run(inputId, message.id);
        db.prepare('UPDATE scoped_progress_state SET last_sent_ms=?,inflight_id=NULL WHERE input_id=?').run(now(), inputId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
