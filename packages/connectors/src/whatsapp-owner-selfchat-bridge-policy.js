import { selfChatError } from './whatsapp-owner-selfchat-journal.js';

// A running, reviewed transport must report these effective invariants. A unit
// environment/default guess or operator attestation alone is insufficient.
export function assertOwnerSelfChatBridgePolicy(status, expectedBuildHash) {
  const policy=status?.ownerSelfChatPolicy;
  if(!/^[a-f0-9]{64}$/.test(expectedBuildHash || '') || policy?.buildHash!==expectedBuildHash
      || policy?.version!==1 || policy.transportOnly!==true || policy.sendAttempts!==1
      || policy.textOnly!==true || policy.maxTextLength!==3000 || policy.markSeen!==false
      || policy.automaticRouting!==false || policy.strictBearer!==true)
    throw selfChatError('selfchat_live_bridge_policy_unverified');
  return policy;
}
