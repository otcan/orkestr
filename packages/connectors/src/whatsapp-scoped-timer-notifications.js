import {notificationScope,notificationKey,createTimerNotificationProofStore} from './whatsapp-timer-notification-proof.js';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {scopedGroupReplyChunks} from './whatsapp-scoped-group-formatting.js';

const sources=new Set(['codex-app-server','codex-rollout','codex-app-server-import','claude-code']);
const visible=m=>!['hidden','internal','private'].includes(m.visibility) && m.signalMode!=='record_only' && m.deliveryMode!=='record_only' && m.notify!==false && m.notificationEligible!==false;
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
export function createScopedTimerNotifications({config,api,send,formatter,env=process.env,now=Date.now,proofStore:suppliedProof,routeFence:suppliedFence}) {
  const scope=notificationScope(config);
  if(!scope)return {tick:async()=>({enabled:false}),close(){}};
  const proofs=suppliedProof || createTimerNotificationProofStore({path:scope.proofDbPath,now});
  const fence=suppliedFence || createDeliveryRouteFence({dbPath:config.routeControl.dbPath,now});
  async function thread() {
    const {thread:t}=await api(`/api/threads/${encodeURIComponent(scope.threadId)}`);
    if(!t || t.ownerUserId!==config.ownerUserId || t.retired || t.lifecycleState==='retired' || t.binding?.chatId!==scope.chatId || t.binding?.enabled!==true || t.binding?.routeEligible===false || t.binding?.retired || t.binding?.deprecated)
      throw new Error('timer_notification_binding_inactive');
    // The legacy mirror must stay suppressed while this explicit transport owns
    // delivery. Do not reinterpret that transport suppression as message consent.
    if(t.binding.mirrorToWhatsApp!==false)throw new Error('timer_notification_duplicate_route');
    return t;
  }
  async function history(since) {
    const all=new Map();let before='';
    for(let page=0;page<100;page++) {
      const p=await api(`/api/threads/${encodeURIComponent(scope.threadId)}/messages?limit=200${before?`&before=${before}`:''}`);
      for(const m of p.messages||[])all.set(m.id,m);
      if(!p.hasMoreBefore || (p.messages||[]).some(m=>Date.parse(m.createdAt)<since))return [...all.values()];
      if(!p.oldestCursor || p.oldestCursor===before)break;
      before=p.oldestCursor;
    }
    throw new Error('timer_notification_history_incomplete');
  }
  return {
    close(){if(!suppliedProof)proofs.close();if(!suppliedFence)fence.close();},
    async tick() {
      if(fence.current()?.route!==config.routeControl.routeId)return {enabled:true,active:false,sent:0};
      const route=fence.assertActive(config.routeControl.routeId);
      if(fence.blocked())throw new Error('timer_notification_delivery_unresolved');
      const since=Math.max(Date.parse(scope.since),Date.parse(route.since));
      await thread();
      const {timers}=await api('/api/timers');
      const eligible=timers.filter(t=>t.ownerUserId===config.ownerUserId && t.target===scope.threadId && t.targetType==='thread');
      // Read scheduler receipts, never infer a timer run from model text.
      const {events}=await api('/api/events?limit=500');
      const scanned=Math.max(since,Date.parse(proofs.scannedAt()||scope.since));
      if(events?.length>=500 && Math.min(...events.map(e=>Date.parse(e.ts)||0))>scanned)throw new Error('timer_notification_event_gap');
      for(const e of events||[])if(e.type==='timer_due' && e.ownerUserId===config.ownerUserId && e.target===scope.threadId && e.targetType==='thread'
        && e.messageId && Date.parse(e.ts)>=since && Date.parse(e.ts)<=now() && eligible.some(t=>t.id===e.timerId))proofs.remember(e);
      proofs.scanned(new Date(now()).toISOString());
      const runs=proofs.runs().filter(e=>Date.parse(e.ts)>=since);
      if(!runs.length)return {enabled:true,runs:0,sent:0};
      const messages=await history(Math.min(...runs.map(e=>Date.parse(e.ts))));
      let sent=0;
      for(const event of runs) {
        const timer=eligible.find(t=>t.id===event.timerId);
        if(!timerRunEligible(timer,event,config.ownerUserId,scope.threadId))continue;
        const parent=messages.find(m=>m.id===event.messageId);
        if(!parent || parent.role!=='user' || parent.source!=='timer_due' || parent.timerId!==event.timerId || parent.ownerUserId!==config.ownerUserId
          || parent.chatId!==scope.chatId || !visible(parent) || !Number.isFinite(Date.parse(parent.createdAt)) || Date.parse(parent.createdAt)>now() || Date.parse(parent.createdAt)<since)continue;
        const answers=messages.filter(m=>m.parentMessageId===parent.id && m.role==='assistant' && m.state==='completed'
          && ['final','final_answer'].includes(m.phase) && sources.has(m.source) && visible(m) && String(m.text||'').trim() && String(m.text).trim()!=='NO_REPLY'
          && Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt)>=Math.max(since,Date.parse(parent.createdAt)) && Date.parse(m.createdAt)<=now() && now()-Date.parse(m.createdAt)<=scope.maxAgeMs)
          .sort((a,b)=>Number(a.cursor||0)-Number(b.cursor||0));
        // One notification per scheduler run; do not multiply reconstructed finals.
        const answer=answers.at(-1);if(!answer)continue;
        const baseId='timer:'+notificationKey([scope.threadId,event.messageId]);
        const prior=proofs.get(baseId+':0');
        let chunks;
        if(prior) {
          if(prior.state==='uncertain')throw new Error('timer_notification_delivery_unresolved');
          chunks=[];for(let i=0;;i++){const row=proofs.get(baseId+':'+i);if(!row)break;chunks.push(row.text);}
        } else {
          let t=await thread();
          try{const {quota}=await api(`/api/quota/providers?ownerUserId=${encodeURIComponent(config.ownerUserId)}`,{timeoutMs:1000});if(quota)t={...t,whatsAppDebugProviderQuota:quota};}catch{}
          const label=String(timer.label||'Scheduled task').replace(/[\r\n]/g,' ').slice(0,120);
          chunks=scopedGroupReplyChunks({text:`[Timer: ${label}]\n${answer.text}`,message:{...answer,chatId:scope.chatId},thread:t,messages,config,formatter,env,deliveryType:'router_update'});
          proofs.prepareBatch(chunks.map((text,i)=>({id:baseId+':'+i,threadId:scope.threadId,chatId:scope.chatId,timerId:timer.id,parentId:parent.id,answerId:answer.id,text,createdAt:answer.createdAt,runAt:event.ts,expiresAt:new Date(Date.parse(answer.createdAt)+scope.maxAgeMs).toISOString()})));
        }
        for(let i=0;i<chunks.length;i++) {
          const id=baseId+':'+i,row=proofs.get(id);if(row.state==='sent' || row.state==='revoked')continue;
          if(Date.parse(row.expires_at)<now()){proofs.mark(id,'revoked');continue;}
          await thread();fence.assertActive(config.routeControl.routeId);
          const latest=(await api('/api/timers')).timers.find(t=>t.id===timer.id);
          if(!timerRunEligible(latest,event,config.ownerUserId,scope.threadId)){proofs.mark(id,'revoked');continue;}
          try {
            const r=await send({chatId:scope.chatId,requestId:id,notificationId:id,parentId:parent.id,text:row.text});
            if(r.ok!==true || !r.ids?.length)throw new Error('unconfirmed');
            proofs.mark(id,'sent');sent++;
          }catch{
            const recovered=fence.unknown({id,hash:notificationKey([scope.chatId,row.text,parent.id]),route:config.routeControl.routeId});
            if(recovered.providerId){proofs.mark(id,'sent');sent++;}
            else {proofs.mark(id,'uncertain');throw new Error('timer_notification_delivery_unresolved');}
          }
        }
      }
      return {enabled:true,runs:runs.length,sent};
    },
  };
}
