import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';
import { assertOwnerSelfChatBridgePolicy } from './whatsapp-owner-selfchat-bridge-policy.js';
import { ownerSelfChatTransportContract } from './whatsapp-owner-selfchat-transport.js';

// Optional operator-approved replacement for the message challenge. The root
// configuration authorizes only the named owner/account/thread scope. Identity
// then requires fresh challenge-bound SDK account and bidirectional ID evidence.
// This proves account identity and authorization, NOT fresh human presence.
export function assertLiveAccountApproval(config, runtimeId, now=Date.now()) {
  const a=config.liveAccountAttestation;
  if(config.identityVerificationMode!=='live-account' || a?.approved!==true || a.version!==2
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(a.approvalRef || '')
      || !Number.isFinite(Date.parse(a.approvedAt)) || Date.parse(a.approvedAt)>now
      || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt)<=now
      || a.ownerUserId!==config.ownerUserId || !config.ownerUserId
      || !runtimeId || a.runtimeId!==runtimeId || a.accountId!==config.accountId
      || a.chatId!==config.chatId || !/^\d+@c\.us$/.test(config.chatId || '')
      || a.bridgeBuildHash!==config.bridgeBuildHash
      || a.transportContract!==ownerSelfChatTransportContract(config))
    throw selfChatError('selfchat_live_account_approval_required');
  return a;
}

export function attestOwnerSelfChatAccount({config,evidence,runtimeId,challenge,requestedAt,now=Date.now()}) {
  const approval=assertLiveAccountApproval(config,runtimeId,now);
  if(config.eligible!==true || evidence?.authenticated!==true || evidence.ready!==true || evidence.state!=='ready')
    throw selfChatError('selfchat_bridge_not_ready');
  const started=Date.parse(requestedAt),checked=Date.parse(evidence.checkedAt);
  if(!/^[a-f0-9]{32}$/.test(challenge || '') || evidence.challenge!==challenge
      || evidence.ok!==true || evidence.version!==1 || !Number.isFinite(started)
      || !Number.isFinite(checked) || started>now || now-started>30_000
      || checked<started || checked>now || now-checked>30_000
      || evidence.ownChatId!==config.chatId || !/^\d+@lid$/.test(evidence.ownLid || '')
      || evidence.mappingSource!=='whatsapp-sdk-bidirectional' || evidence.serverRefreshVerified!==false)
    throw selfChatError('selfchat_account_evidence_invalid');
  const policy=assertOwnerSelfChatBridgePolicy(evidence,config.bridgeBuildHash);
  return {accountId:config.accountId,chatId:config.chatId,runtimeId,
    ownerUserId:config.ownerUserId,ownLid:evidence.ownLid,
    method:'live-account',humanPresenceVerified:false,verifiedAt:new Date(now).toISOString(),
    evidenceCheckedAt:evidence.checkedAt,evidenceExpiresAt:new Date(checked+30_000).toISOString(),
    evidenceHash:selfChatHash(evidence),evidenceChallengeHash:selfChatHash(challenge),
    approvalHash:selfChatHash(approval),policyHash:selfChatHash(policy)};
}

// The wrapper fetched this exact self-chat under the authenticated account.
// For the separately approved compatibility mode only, an own message whose
// sender AND recipient match the verified own PN/LID pair. No alias is inferred
// from fromMe/history. Outbound addressing stays on the configured phone ID.
export function normalizeAttestedSelfChatHistory({config,identity,payload}) {
  if(config.identityVerificationMode!=='live-account')return payload;
  const approval=assertLiveAccountApproval(config,identity?.runtimeId);
  if(identity?.method!=='live-account' || identity.approvalHash!==selfChatHash(approval)
      || identity.ownerUserId!==config.ownerUserId || identity.chatId!==config.chatId
      || !/^\d+@lid$/.test(identity.ownLid || '') || !Number.isFinite(Date.parse(identity.evidenceExpiresAt))
      || Date.parse(identity.evidenceExpiresAt)<=Date.now())
    throw selfChatError('selfchat_identity_or_eligibility_unverified');
  if(approval.allowVerifiedOwnIdAliases!==true)return payload;
  if(payload?.ok!==true || payload.chatId!==config.chatId || !Array.isArray(payload.messages))
    throw selfChatError('selfchat_history_invalid');
  const ownIds=new Set([config.chatId,identity.ownLid]);
  return {...payload,messages:payload.messages.map(message=>
    message.fromMe===true && ownIds.has(message.to) && ownIds.has(message.from)
      && (message.from===identity.ownLid || message.to===identity.ownLid)
      ? {...message,providerFrom:message.from,providerTo:message.to,from:config.chatId,to:config.chatId,
        ownerSelfChatSenderEvidence:'verified-whatsapp-id-mapping'} : message)};
}
