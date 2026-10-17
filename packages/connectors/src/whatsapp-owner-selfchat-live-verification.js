import { randomBytes } from 'node:crypto';
import { assertLiveAccountApproval,attestOwnerSelfChatAccount } from './whatsapp-owner-selfchat-attestation.js';
import { selfChatError,selfChatHash } from './whatsapp-owner-selfchat-journal.js';

// Machine-only challenge-response over the existing authenticated wrapper.
// It never generates a WhatsApp message or substitutes for human presence.
export async function verifyLiveOwnerSelfChatAccount({config,journal,runner,now=Date.now,
  createChallenge=()=>randomBytes(16).toString('hex')}) {
  if(config.eligible!==true)throw selfChatError('selfchat_identity_or_eligibility_unverified');
  const runtimeId=await runner.preflight();
  const approval=assertLiveAccountApproval(config,runtimeId,now());
  const approvalHash=selfChatHash(approval);
  const challenge=createChallenge(),requestedAt=new Date(now()).toISOString();
  if(!/^[a-f0-9]{32}$/.test(challenge))throw selfChatError('selfchat_account_evidence_invalid');
  journal.beginIdentityEvidence(challenge,runtimeId,approvalHash,requestedAt);
  const isActive=()=>{
    if(config.eligible!==true)return false;
    try { return selfChatHash(assertLiveAccountApproval(config,runtimeId,now()))===approvalHash
      && now()-Date.parse(requestedAt)<=30_000; } catch { return false; }
  };
  const evidence=await runner.invoke(['identity',challenge],{runtimeId,isActive});
  if(await runner.preflight()!==runtimeId)throw selfChatError('selfchat_runtime_changed');
  const identity=attestOwnerSelfChatAccount({config,evidence,runtimeId,challenge,requestedAt,now:now()});
  journal.acceptIdentityEvidence(challenge,identity,requestedAt);
  return identity;
}
