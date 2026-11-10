import crypto from 'node:crypto';
// Current binding/member checks apply to initial input and every completion.
import {participantInputMetadata} from './whatsapp-group-participant-author.js';
import {participantRecoveryAdmission} from './whatsapp-participant-recovery-admission.js';

export function createParticipantInput({inbox,db,participants,api,threadFor}) {
  return async function inputThread(input, group) {
    const thread = await threadFor(group);
    const hasAuthors = inbox.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_input_author'").get();
    if (participants.count && !hasAuthors) throw new Error('group_participant_journal_required');
    const author = hasAuthors ? inbox.prepare('SELECT proof FROM group_input_author WHERE id=?').get(input.id) : null;
    const proof = author ? JSON.parse(author.proof) : null;
    const historicalAdmitted = proof?.recoveryGrantSha256
      && participantRecoveryAdmission(db,input,author.proof,group.threadId);
    const policy = historicalAdmitted ? {accountId:participants.accountId,allows:participants.allowsRoutedRecovery} : participants;
    const metadata = author ? participantInputMetadata({proof, input, group, thread, policy}) : {};
    if (author) {
      const check = await api(`/api/threads/${encodeURIComponent(group.threadId)}/whatsapp-participant-check`, {method: 'POST', body: {...metadata, text: input.body}});
      if (check.allowed !== true) throw new Error('group_participant_security_denied');
      // The external member check may await I/O; expiry/revocation must still
      // hold when a first input is admitted. Routed completions use their receipt.
      if(!policy.allows(proof,input))throw new Error('group_participant_binding_denied');
    }
    return {thread, metadata};
  }
}

export function recordScopedInputAdmission({db,inbox,input,group,messageId,metadata}) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO routed(id,thread_id,message_id) VALUES(?,?,?)').run(input.id, group.threadId, messageId);
        if(metadata.scopedParticipant?.recoveryGrantSha256) {
          const author=inbox.prepare('SELECT proof FROM group_input_author WHERE id=?').get(input.id);
          db.prepare('INSERT OR IGNORE INTO participant_recovery_admissions(id,thread_id,message_id,proof,body_sha256) VALUES(?,?,?,?,?)')
            .run(input.id,group.threadId,messageId,author.proof,crypto.createHash('sha256').update(input.body).digest('hex'));
        }
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
}
