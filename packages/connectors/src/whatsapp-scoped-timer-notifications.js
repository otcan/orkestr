import {createKeyedSerial} from './scoped-relay-serial.js';
import {notificationScope,notificationKey,createTimerNotificationProofStore} from './whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {encodeReplyEntry, replyEntrySendFields, scopedGroupReplyChunks, scopedReplyHeader} from './whatsapp-scoped-group-formatting.js';
import {createRemoteTimerReplies,remoteTimerEventEligible,remoteTimerParentEvent} from './whatsapp-scoped-remote-timer-replies.js';

const sources=new Set(['codex-app-server','codex-rollout','codex-app-server-import','claude-code']);
const visible=m=>!['hidden','internal','private'].includes(m.visibility) && m.signalMode!=='record_only' && m.deliveryMode!=='record_only' && m.notify!==false && m.notificationEligible!==false;
// A scheduler run that produced no deliverable answer within this window is
// closed so it is never re-read; its answer could no longer pass maxAgeMs anyway.
const RUN_TTL_MS=6*60*60*1000;
// V1 notices posted to the thread for a timer: Gmail re-auth, or a timer
// paused because the thread is delegated to the remote runtime (Orkestr V2).
const noticeSources=new Set(['timer_connector_health','timer_delegation_fence']);
const delegationNoticeAllowed=(timer,event)=>event.source==='timer_delegation_fence' && timer?.enabled===false
  && timer.pausedReason==='thread_delegated_to_remote_runtime' && timer.lastDelegationNoticeMessageId===event.messageId;
export function timerRunEligible(timer,event,owner,threadId) {
  if(!timer || timer.ownerUserId!==owner || timer.target!==threadId || timer.targetType!=='thread' || !visible(timer) || timer.blockedReason || timer.disabledReason)return false;
  if(timer.enabled===true)return true;
  // One-shot completion auto-disables its schedule. An explicit later pause or
  // edit still suppresses notification; never resume/rewrite the timer itself.
  return timer.cadence==='once' && timer.enabled===false && timer.nextRunAt===null
    && Date.parse(timer.lastRunAt)===Date.parse(event.ts)
    && (!timer.updatedAt || Date.parse(timer.updatedAt)<=Date.parse(event.ts))
    && !timer.disabledAt;
}
// Delivers a timer run's final answer to the bound group of the thread the
// scheduler ran it in, and nowhere else. Proof chain: scheduler `timer_due`
// event (server receipt) -> its user message id -> the thread's final answer
// whose parentMessageId is that id -> the thread's own bound chat.
export function createScopedTimerNotifications({config,api,send,formatter,env=process.env,now=Date.now,proofStore:suppliedProof,routeFence:suppliedFence,minIntervalMs=0}) {
  const scope=notificationScope(config);
  if(!scope)return {tick:async()=>({enabled:false}),close(){}};
  const proofs=suppliedProof || createTimerNotificationProofStore({path:scope.proofDbPath,now});
  const fence=suppliedFence || createDeliveryRouteFence({dbPath:config.routeControl.dbPath,now});
  const legacySingle=scope.threads.size===1;
  let lastTick=-Infinity,lastStatus=null;
  const threadSerial=createKeyedSerial();
  const allowedTimer=(timer,event,threadId)=>event.type==='thread_signal_appended'
    ? timer?.ownerUserId===config.ownerUserId && timer.target===threadId && timer.targetType==='thread' && visible(timer)
      && (delegationNoticeAllowed(timer,event) || (event.source!=='timer_delegation_fence' && timer.enabled===true && timer.lastAuthNoticeMessageId===event.messageId && timer.blockedReason==='blocked_auth'))
    : timerRunEligible(timer,event,config.ownerUserId,threadId);
  async function thread(threadId) {
    const chatId=scope.threads.get(threadId);
    const {thread:t}=await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if(!t || t.ownerUserId!==config.ownerUserId || t.retired || t.lifecycleState==='retired' || t.binding?.chatId!==chatId || t.binding?.enabled!==true || t.binding?.routeEligible===false || t.binding?.retired || t.binding?.deprecated)
      throw new Error('timer_notification_binding_inactive');
    // The legacy mirror must stay suppressed while this explicit transport owns
    // delivery. Do not reinterpret that transport suppression as message consent.
    if(t.binding.mirrorToWhatsApp!==false)throw new Error('timer_notification_duplicate_route');
    return t;
  }
  async function history(threadId,since) {
    const all=new Map();let before='';
    for(let page=0;page<100;page++) {
      const p=await api(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=200${before?`&before=${before}`:''}`);
      for(const m of p.messages||[])all.set(m.id,m);
      if(!p.hasMoreBefore || (p.messages||[]).some(m=>Date.parse(m.createdAt)<since))return [...all.values()];
      if(!p.oldestCursor || p.oldestCursor===before)break;
      before=p.oldestCursor;
    }
    throw new Error('timer_notification_history_incomplete');
  }
  const remoteReplies=createRemoteTimerReplies({config,api,send,formatter,env,now,proofs,fence,scope,thread,runTtlMs:RUN_TTL_MS});
  async function deliverThread(threadId,allRuns,since,eligible) {
    const chatId=scope.threads.get(threadId);
    const t=await thread(threadId);
    const messages=await history(threadId,Math.min(...allRuns.map(e=>Date.parse(e.ts))));
    let sent=0;
    // Replies to V2 timer turns report their outcome back so the remote input settles.
    for(const event of allRuns.filter(e=>e.type===remoteTimerParentEvent))sent+=await remoteReplies.deliver(threadId,t,event,messages,since);
    const runs=allRuns.filter(e=>e.type!==remoteTimerParentEvent);
    // The owner turned reply mirroring off for this binding: close, never send.
    if(t.binding.mirrorReplies===false){for(const e of runs)proofs.finish(e.messageId,'suppressed',new Date(now()).toISOString());return sent;}
    for(const event of runs) {
      const timer=eligible.find(x=>x.id===event.timerId);
      const notice=event.type==='thread_signal_appended';
      if(!allowedTimer(timer,event,threadId)){proofs.finish(event.messageId,'ineligible',new Date(now()).toISOString());continue;}
      // Prompt-file timer messages carry no text and are omitted from the
      // message listing; the scheduler event is then the parent receipt.
      const listed=messages.find(m=>m.id===event.messageId);
      const parent=listed || (notice ? null : {id:event.messageId,role:'user',source:'timer_due',timerId:event.timerId,ownerUserId:config.ownerUserId,chatId,createdAt:event.ts});
      const parentValid=notice ? parent?.role==='assistant' && noticeSources.has(parent.source) && parent.source===event.source && parent.phase==='signal' && parent.state==='completed' && parent.signalMode==='notify_passively'
        : parent?.role==='user' && parent.source==='timer_due' && parent.timerId===event.timerId;
      if(!parentValid || parent.ownerUserId!==config.ownerUserId || (parent.chatId && parent.chatId!==chatId) || !visible(parent)
        || !Number.isFinite(Date.parse(parent.createdAt)) || Date.parse(parent.createdAt)>now() || Date.parse(parent.createdAt)<since){
        proofs.finish(event.messageId,'unverified',new Date(now()).toISOString());continue;
      }
      const finals=notice ? [] : messages.filter(m=>m.parentMessageId===parent.id && m.role==='assistant' && m.state==='completed'
        && ['final','final_answer'].includes(m.phase) && sources.has(m.source) && (!m.chatId || m.chatId===chatId));
      if(finals.some(m=>String(m.text||'').trim()==='NO_REPLY')){proofs.finish(event.messageId,'no_reply',new Date(now()).toISOString());continue;}
      const answers=notice ? (now()-Date.parse(parent.createdAt)<=scope.maxAgeMs && String(parent.text||'').trim() && String(parent.text).trim()!=='NO_REPLY' ? [parent] : [])
        : finals.filter(m=>visible(m) && String(m.text||'').trim()
          && Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt)>=Math.max(since,Date.parse(parent.createdAt)) && Date.parse(m.createdAt)<=now() && now()-Date.parse(m.createdAt)<=scope.maxAgeMs)
          .sort((a,b)=>Number(a.cursor||0)-Number(b.cursor||0));
      // One notification per scheduler run; do not multiply reconstructed finals.
      const answer=answers.at(-1);
      if(!answer){if(now()-Date.parse(event.ts)>RUN_TTL_MS)proofs.finish(event.messageId,'expired',new Date(now()).toISOString());continue;}
      const baseId='timer:'+notificationKey([threadId,event.messageId]);
      const prior=proofs.get(baseId+':0');
      let chunks;
      if(prior) {
        if(prior.state==='uncertain')throw new Error('timer_notification_delivery_unresolved');
        chunks=[];for(let i=0;;i++){const row=proofs.get(baseId+':'+i);if(!row)break;chunks.push(row.text);}
      } else {
        let current=t;
        try{const {quota}=await api(`/api/quota/providers?ownerUserId=${encodeURIComponent(config.ownerUserId)}`,{timeoutMs:1000});if(quota)current={...current,whatsAppDebugProviderQuota:quota};}catch{}
        chunks=scopedGroupReplyChunks({text:`${scopedReplyHeader({label:timer.label})}\n${answer.text}`,message:{...answer,chatId},thread:current,messages,config,formatter,env,deliveryType:'timer_reply'});
        proofs.prepareBatch(chunks.map((entry,i)=>({id:baseId+':'+i,threadId,chatId,timerId:timer.id,parentId:parent.id,answerId:answer.id,text:encodeReplyEntry(entry),createdAt:answer.createdAt,runAt:event.ts,expiresAt:new Date(Date.parse(answer.createdAt)+scope.maxAgeMs).toISOString()})));
      }
      for(let i=0;i<chunks.length;i++) {
        const id=baseId+':'+i,row=proofs.get(id);if(row.state==='sent' || row.state==='revoked')continue;
        if(Date.parse(row.expires_at)<now()){proofs.mark(id,'revoked');continue;}
        await thread(threadId);fence.assertActive(config.routeControl.routeId);
        const latest=(await api('/api/timers')).timers.find(x=>x.id===timer.id);
        if(!allowedTimer(latest,event,threadId)){proofs.mark(id,'revoked');continue;}
        try {
          const r=await send({chatId,requestId:id,notificationId:id,parentId:parent.id,...replyEntrySendFields(row.text)});
          if(r.ok!==true || !r.ids?.length)throw new Error('unconfirmed');
          proofs.mark(id,'sent');sent++;
        }catch(error){
          if(error?.definitive===true) {
            // Rejected before dispatch: nothing reached the provider. Close the
            // run visibly instead of blocking all delivery as uncertain.
            proofs.mark(id,'revoked');proofs.finish(event.messageId,'rejected',new Date(now()).toISOString());
            throw new Error('timer_notification_send_rejected');
          }
          const recovered=fence.unknown({id,hash:notificationKey([chatId,row.text,parent.id]),route:config.routeControl.routeId});
          if(recovered.providerId){proofs.mark(id,'sent');sent++;}
          else {proofs.mark(id,'uncertain');throw new Error('timer_notification_delivery_unresolved');}
        }
      }
      proofs.finish(event.messageId,'delivered',new Date(now()).toISOString());
    }
    return sent;
  }
  return {
    close(){if(!suppliedProof)proofs.close();if(!suppliedFence)fence.close();},
    async tick({threadIds} = {}) {
      if(!threadIds && lastStatus && now()-lastTick<minIntervalMs)return lastStatus;
      lastTick=now();
      if(fence.current()?.route!==config.routeControl.routeId)return lastStatus={enabled:true,active:false,sent:0};
      const route=fence.assertActive(config.routeControl.routeId);
      if(fence.blocked())throw new Error('timer_notification_delivery_unresolved');
      const since=Math.max(Date.parse(scope.since),Date.parse(route.since));
      if(legacySingle)await thread([...scope.threads.keys()][0]);
      const {timers}=await api('/api/timers');
      const eligible=timers.filter(x=>x.ownerUserId===config.ownerUserId && scope.threads.has(x.target) && x.targetType==='thread');
      // Read scheduler receipts, never infer a timer run from model text.
      const {events}=await api('/api/events?limit=500');
      const scanned=Math.max(since,Date.parse(proofs.scannedAt()||scope.since));
      let gap=null;
      if(events?.length>=500 && Math.min(...events.map(e=>Date.parse(e.ts)||0))>scanned) {
        // Runs inside the gap cannot be proven and are never guessed. A single
        // thread scope fails closed; the multi-thread scope reports the gap and
        // keeps delivering provable runs instead of stalling every group.
        if(legacySingle)throw new Error('timer_notification_event_gap');
        gap={from:new Date(scanned).toISOString(),to:new Date(Math.min(...events.map(e=>Date.parse(e.ts)||0))).toISOString()};
      }
      for(const e of events||[])if(e.type==='timer_due' && e.ownerUserId===config.ownerUserId && scope.threads.has(e.target) && e.targetType==='thread'
        && e.messageId && Date.parse(e.ts)>=since && Date.parse(e.ts)<=now() && eligible.some(x=>x.id===e.timerId && x.target===e.target))proofs.remember(e);
      for(const e of events||[])if(remoteTimerEventEligible(e,config,scope,since,now()))proofs.remember(e);
      for(const e of events||[])if(e.type==='thread_signal_appended' && noticeSources.has(e.source) && e.signalMode==='notify_passively' && e.ownerUserId===config.ownerUserId && scope.threads.has(e.threadId) && Date.parse(e.ts)>=since && Date.parse(e.ts)<=now()) {
        const timer=eligible.find(x=>(e.source==='timer_delegation_fence' ? x.lastDelegationNoticeMessageId : x.lastAuthNoticeMessageId)===e.messageId && x.target===e.threadId);
        if(timer)proofs.remember({...e,target:e.threadId,timerId:timer.id});
      }
      proofs.scanned(new Date(now()).toISOString());
      const pending=proofs.pendingRuns().filter(e=>Date.parse(e.ts)>=since);
      if(!pending.length)return lastStatus={enabled:true,threads:scope.threads.size,runs:0,sent:0,...(gap?{eventGap:gap}:{})};
      const byThread=new Map();
      for(const e of pending){const id=e.target||e.threadId;if(!scope.threads.has(id))continue;if(!byThread.has(id))byThread.set(id,[]);byThread.get(id).push(e);}
      let sent=0;const errors={};
      for(const [threadId,runs] of byThread) {
        if(threadIds && !threadIds.includes(threadId))continue;
        try {sent+=await threadSerial(threadId,()=>deliverThread(threadId,runs,since,eligible));}
        catch(e) {
          // A single-thread scope keeps its original fail-closed behaviour; an
          // unresolved provider delivery always stops every thread.
          if(legacySingle || e.message==='timer_notification_delivery_unresolved')throw e;
          errors[threadId]=/^[a-z_]+$/.test(e.message)?e.message:'notification_operation_failed';
        }
      }
      return lastStatus={enabled:true,threads:scope.threads.size,runs:pending.length,sent,...(gap?{eventGap:gap}:{}),...(Object.keys(errors).length?{errors}:{})};
    },
  };
}
