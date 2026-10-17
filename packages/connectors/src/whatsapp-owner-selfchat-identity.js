import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';
import { assertLiveAccountApproval } from './whatsapp-owner-selfchat-attestation.js';

export function verifyOwnerSelfChatIdentity({ config, history, status, runtimeId, nonce, issuedAt, now = Date.now() }) {
  if (status?.authenticated !== true || status?.ready !== true || status?.state !== 'ready')
    throw selfChatError('selfchat_bridge_not_ready');
  if (!/^\d+@c\.us$/.test(config.chatId || '') || !runtimeId
      || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)
      || !Number.isFinite(Date.parse(issuedAt)) || now < Date.parse(issuedAt) || now-Date.parse(issuedAt)>600_000)
    throw selfChatError('selfchat_identity_challenge_invalid');
  if (history?.ok !== true || history.chatId !== config.chatId || !Array.isArray(history.messages))
    throw selfChatError('selfchat_identity_history_invalid');
  const text=`orkestr-selfchat-verify ${nonce}`;
  const proof=history.messages.find(m=>m.fromMe===true && m.from===config.chatId && m.to===config.chatId
    && m.body===text && typeof m.id==='string' && m.id && !m.id.startsWith('summary:')
    && Date.parse(m.timestamp)>Date.parse(issuedAt) && Date.parse(m.timestamp)<=now+5_000);
  if (!proof) throw selfChatError('selfchat_identity_proof_not_found');
  return { accountId:config.accountId, chatId:config.chatId, runtimeId, proofId:proof.id,
    verifiedAt:new Date(now).toISOString(), challengeHash:selfChatHash(nonce) };
}

export function assertOwnerSelfChatIdentity(config, identity, runtimeId) {
  if (config.eligible !== true || !identity || identity.accountId!==config.accountId
      || identity.chatId!==config.chatId || identity.runtimeId!==runtimeId)
    throw selfChatError('selfchat_identity_or_eligibility_unverified');
  if(config.identityVerificationMode==='live-account') {
    const approval=assertLiveAccountApproval(config,runtimeId);
    if(identity.method!=='live-account' || identity.humanPresenceVerified!==false
        || identity.approvalHash!==selfChatHash(approval) || identity.proofId || identity.challengeHash)
      throw selfChatError('selfchat_identity_or_eligibility_unverified');
  } else if(identity.method==='live-account' || (config.identityVerificationMode
      && config.identityVerificationMode!=='message-challenge')) {
    throw selfChatError('selfchat_identity_or_eligibility_unverified');
  }
}
