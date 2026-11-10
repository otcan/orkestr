// The configured relay journal records admission before task completion. This
// read-only join can preserve that exact admission after a one-message grant
// expires; it never authorizes a new input or changes current participant rules.
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export function hasParticipantRecoveryAdmission(config, input, proofJson, threadId) {
  if (!config.relayJournalPath || config.relayJournalPath === ':memory:') return false;
  let db;
  try {
    db = new DatabaseSync(config.relayJournalPath, {readOnly:true});
    return participantRecoveryAdmission(db,input,proofJson,threadId);
  } catch { return false; }
  finally { db?.close(); }
}

export function participantRecoveryAdmission(db,input,proofJson,threadId) {
  const row = db.prepare(`SELECT a.thread_id,a.message_id,a.proof,a.body_sha256,
      r.thread_id AS routed_thread,r.message_id AS routed_message
      FROM participant_recovery_admissions a JOIN routed r ON r.id=a.id WHERE a.id=?`).get(input.id);
  return Boolean(row && typeof row.message_id==='string' && row.message_id.length>0 && row.message_id.length<=200
      && row.thread_id===threadId && row.routed_thread===threadId
      && row.message_id===row.routed_message && row.proof===proofJson
      && row.body_sha256===crypto.createHash('sha256').update(input.body).digest('hex'));
}
