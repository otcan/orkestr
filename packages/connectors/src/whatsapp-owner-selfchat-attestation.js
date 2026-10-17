import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';
import { assertOwnerSelfChatBridgePolicy } from './whatsapp-owner-selfchat-bridge-policy.js';
import { ownerSelfChatTransportContract } from './whatsapp-owner-selfchat-transport.js';

// Optional operator-approved replacement for the message challenge. The root
// configuration attests a reviewed implementation invariant: ready requires
// the SDK's current own ID to equal the protected configured self-chat ID.
// This proves account identity and authorization, NOT fresh human presence.
export function assertLiveAccountApproval(config, runtimeId, now=Date.now()) {
  const a=config.liveAccountAttestation;
  if(config.identityVerificationMode!=='live-account' || a?.approved!==true || a.version!==1
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(a.approvalRef || '')
      || !Number.isFinite(Date.parse(a.approvedAt)) || Date.parse(a.approvedAt)>now
      || !runtimeId || a.runtimeId!==runtimeId || a.accountId!==config.accountId
      || a.chatId!==config.chatId || !/^\d+@c\.us$/.test(config.chatId || '')
      || a.bridgeBuildHash!==config.bridgeBuildHash
      || a.transportContract!==ownerSelfChatTransportContract(config)
      || a.readyRequiresConfiguredIdentity!==true)
    throw selfChatError('selfchat_live_account_approval_required');
  return a;
}

export function attestOwnerSelfChatAccount({config,status,runtimeId,now=Date.now()}) {
  const approval=assertLiveAccountApproval(config,runtimeId,now);
  if(config.eligible!==true || status?.authenticated!==true || status.ready!==true || status.state!=='ready')
    throw selfChatError('selfchat_bridge_not_ready');
  const policy=assertOwnerSelfChatBridgePolicy(status,config.bridgeBuildHash);
  return {accountId:config.accountId,chatId:config.chatId,runtimeId,
    method:'live-account',humanPresenceVerified:false,verifiedAt:new Date(now).toISOString(),
    approvalHash:selfChatHash(approval),policyHash:selfChatHash(policy)};
}

// The wrapper fetched this exact self-chat under the authenticated account.
// For the separately approved compatibility mode only, an own message whose
// recipient is the exact phone-based self ID may use WhatsApp's LID sender.
// Do not learn/store a global alias or accept LID recipients. Keep raw evidence.
export function normalizeAttestedSelfChatHistory({config,identity,payload}) {
  if(config.identityVerificationMode!=='live-account')return payload;
  const approval=assertLiveAccountApproval(config,identity?.runtimeId);
  if(identity?.method!=='live-account' || identity.approvalHash!==selfChatHash(approval))
    throw selfChatError('selfchat_identity_or_eligibility_unverified');
  if(approval.allowOwnHistoryLidSender!==true)return payload;
  if(payload?.ok!==true || payload.chatId!==config.chatId || !Array.isArray(payload.messages))
    throw selfChatError('selfchat_history_invalid');
  return {...payload,messages:payload.messages.map(message=>
    message.fromMe===true && message.to===config.chatId && /^\d+@lid$/.test(message.from || '')
      ? {...message,providerFrom:message.from,from:config.chatId,
        ownerSelfChatSenderEvidence:'authenticated-self-history'} : message)};
}
