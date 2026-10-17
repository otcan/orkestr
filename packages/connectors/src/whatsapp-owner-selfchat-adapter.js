import { createOwnerSelfChatTransportPolicy,ownerSelfChatTransportContract } from './whatsapp-owner-selfchat-transport.js';
import { assertOwnerSelfChatIdentity } from './whatsapp-owner-selfchat-identity.js';
import { assertOwnerSelfChatBridgePolicy } from './whatsapp-owner-selfchat-bridge-policy.js';
import { selfChatError,selfChatHash } from './whatsapp-owner-selfchat-journal.js';
import { normalizeAttestedSelfChatHistory,assertLiveAccountApproval } from './whatsapp-owner-selfchat-attestation.js';
import { verifyLiveOwnerSelfChatAccount } from './whatsapp-owner-selfchat-live-verification.js';

// invoke is a fixed, operator-installed wrapper runner. Requests cannot choose
// its executable, environment, account, service, journal path or credential.
export function createOwnerSelfChatAdapter({ config, journal, invoke, preflight }) {
  if(config.maxSendAttempts!==undefined && (!Number.isSafeInteger(config.maxSendAttempts) || config.maxSendAttempts<0))
    throw selfChatError('selfchat_send_limit_invalid');
  const policy=createOwnerSelfChatTransportPolicy({...config, identityVerified:true, verifiedOwnChatId:config.chatId});
  let tail=Promise.resolve();
  let statusAt=0;
  let closed=false;
  let identityRefreshFailed=false;
  const activeIdentity=()=>{
    if(closed)return false;
    if(config.identityVerificationMode!=='live-account')return true;
    try {
      const identity=journal.meta('identity');
      assertOwnerSelfChatIdentity(config,identity,identity?.runtimeId);return true;
    } catch { return false; }
  };
  const serial=work => { const next=tail.catch(()=>{}).then(work); tail=next; return next; };
  async function ready() {
    if(config.eligible!==true)throw selfChatError('selfchat_identity_or_eligibility_unverified');
    if(identityRefreshFailed)throw selfChatError('selfchat_account_evidence_refresh_failed');
    const runtimeId=await preflight();
    if(config.identityVerificationMode==='live-account') {
      // An altered scope/owner/runtime must fail before refreshing evidence.
      const identity=journal.meta('identity');
      const approval=assertLiveAccountApproval(config,runtimeId);
      if(!identity || identity.runtimeId!==runtimeId || identity.ownerUserId!==config.ownerUserId
          || identity.accountId!==config.accountId || identity.chatId!==config.chatId
          || identity.approvalHash!==selfChatHash(approval))throw selfChatError('selfchat_identity_or_eligibility_unverified');
      // Refresh before a wrapper call can outlive otherwise-valid evidence.
      // Expiry and approval checks still run before dispatch and after history.
      if(Date.parse(identity.evidenceExpiresAt)-Date.now()<=10000) {
        try {
          await verifyLiveOwnerSelfChatAccount({config,journal,runner:{preflight,
            invoke:(argv,options)=>invoke(argv,{...options,isActive:()=>!closed && options.isActive()})}});
        } catch {
          // Polling must not turn a failed identity check into a retry loop.
          identityRefreshFailed=true;throw selfChatError('selfchat_account_evidence_refresh_failed');
        }
      }
    }
    assertOwnerSelfChatIdentity(config,journal.meta('identity'),runtimeId);
    if(Date.now()-statusAt>30000) {
      const status=await invoke(['status'],{runtimeId,isActive:activeIdentity});
      if(status?.authenticated!==true || status.ready!==true || status.state!=='ready')
        throw selfChatError('selfchat_bridge_not_ready');
      assertOwnerSelfChatBridgePolicy(status,config.bridgeBuildHash);
      statusAt=Date.now();
    }
  }
  const base={accountId:config.accountId,chatId:config.chatId};
  const contract=ownerSelfChatTransportContract(config);
  const sendPolicyVerified=()=>{
    const p=config.verifiedSendPolicy;
    return p?.runtimeId===journal.meta('identity')?.runtimeId && p.attempts===1
      && p.textOnly===true && Number.isInteger(p.maxTextLength) && p.maxTextLength>=3000;
  };
  return {
    close:()=>{closed=true;},
    request: request => serial(async () => {
      if(closed) throw selfChatError('selfchat_adapter_closed');
      if (request.accountId!==base.accountId || request.chatId!==base.chatId || request.contract!==contract)
        throw selfChatError('owner_selfchat_transport_scope_denied',403);
      await ready();
      if(closed) throw selfChatError('selfchat_adapter_closed');
      if (request.operation==='health') return {ok:true,accountId:base.accountId,identityVerified:true,
        readReady:!journal.unresolved(),ready:!journal.unresolved() && sendPolicyVerified(),
        blocked:journal.unresolved()?'selfchat_delivery_uncertain':sendPolicyVerified()?'':'selfchat_provider_send_policy_unverified'};
      if (request.operation==='ack') {
        if (!config.threadIds.includes(request.threadId) || typeof request.messageId!=='string' || !request.messageId)
          throw selfChatError('selfchat_thread_denied',403);
        journal.ack(request.id,{threadId:request.threadId,messageId:request.messageId});
        return {ok:true};
      }
      if(request.operation==='routes') return {ok:true,routes:journal.routes()};
      const command=policy.command(request);
      if (request.operation==='history') {
        if (journal.unresolved()) throw selfChatError('selfchat_delivery_uncertain');
        const payload=await invoke(command,{runtimeId:journal.meta('identity').runtimeId,isActive:activeIdentity});
        if (payload?.ok!==true || payload.chatId!==base.chatId || !Array.isArray(payload.messages))
          throw selfChatError('selfchat_history_invalid',502);
        const normalized=normalizeAttestedSelfChatHistory({config,identity:journal.meta('identity'),payload});
        const rows=[...normalized.messages].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
        const anchor=journal.meta('historyAnchor');
        const limit=Number(command[2]);
        // The wrapper has no pagination. Never silently skip a gap of >50
        // messages, including the first poll after activation.
        if (rows.length>=limit && !(anchor ? rows.some(m=>m.id===anchor)
          : rows.some(m=>Date.parse(m.timestamp)<=Date.parse(config.activatedAt))))
          throw selfChatError('selfchat_history_gap');
        const candidates=policy.inbound(rows,{outboundIds:journal.outboundIds(),
          consumedIds:[...journal.consumedIds(),journal.meta('identity').proofId],deliveryUnresolved:false});
        const messages=journal.offer(candidates);
        if (rows.length && typeof rows.at(-1).id==='string') journal.setMeta('historyAnchor',rows.at(-1).id);
        return {ok:true,messages};
      }
      if (!config.threadIds.includes(request.threadId)) throw selfChatError('selfchat_thread_denied',403);
      // Operator attestation is pinned to this existing process. The wrapper's
      // own retry loop cannot be controlled by an HTTP client or journal.
      if(!sendPolicyVerified())
        throw selfChatError('selfchat_provider_send_policy_unverified');
      if(!journal.routes().some(r=>r.threadId===request.threadId && r.messageId===request.parentMessageId))
        throw selfChatError('selfchat_reply_parent_required',403);
      const payload={...base,text:request.text,threadId:request.threadId,parentMessageId:request.parentMessageId};
      const prior=journal.reserve(request.requestId,payload,config.maxSendAttempts ?? null);
      if (prior.duplicate) return {ok:true,ids:prior.ids,duplicate:true};
      try {
        if(closed) throw selfChatError('selfchat_adapter_closed');
        const result=await invoke(command,{runtimeId:journal.meta('identity').runtimeId,isActive:activeIdentity});
        if (result?.ok!==true) throw selfChatError('selfchat_delivery_uncertain');
        journal.sent(request.requestId,result.ids);
        return {ok:true,ids:result.ids};
      } catch {
        journal.uncertain(request.requestId);
        // Suppress wrapper stderr and payloads: they can contain message text.
        throw selfChatError('selfchat_delivery_uncertain');
      }
    }),
  };
}
