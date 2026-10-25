// A fallback may claim work only from fresh execution evidence for this input.
export async function acknowledgementActivity({api,group,thread,route,messages,now=Date.now}) {
  if(!route) return {active:false};
  const own=messages.filter(m=>m.parentMessageId===route.message_id && m.role==='assistant');
  if(own.some(m=>String(m.text||'').trim()==='NO_REPLY')) return {active:false,covered:true,reason:'no_reply'};
  if(own.some(m=>m.deliveryState==='delivered' && Array.isArray(m.whatsappMessageIds) && m.whatsappMessageIds.length
      && String(m.text||'').trim())) return {active:false,covered:true,reason:'useful_output_delivered'};
  const b=thread.binding||{};
  if(b.remoteRuntimeEnabled!==false && b.remoteRouterEnabled!==false && (b.remoteThreadId||b.remoteRuntimeThreadId||b.delegatedThreadId)) {
    const value=await api(`/api/connectors/whatsapp/remote-runtime/input-activity?thread=${encodeURIComponent(group.threadId)}&message=${encodeURIComponent(route.message_id)}`,
      {timeoutMs:2000});
    if(value.ok!==true || value.publicThreadId!==group.threadId || value.publicMessageId!==route.message_id)
      return {active:false};
    if(value.fastReady || value.finalReady) return {active:false,covered:true,reason:'native_output_ready'};
    // A fresh HTTP read proves the exact input remains queued; a queued input
    // has no native execution timestamp and must never claim work has started.
    if(value.supported===true && value.phase==='queued') return {active:false,queued:true};
    const age=now()-value.observedAtMs;
    return {active:value.active===true && Number.isSafeInteger(value.observedAtMs) && age>=0 && age<=5000};
  }
  const runtime=await api(`/api/threads/${encodeURIComponent(group.threadId)}/runtime-lite`,{timeoutMs:2000});
  const lifecycle=runtime.turnLifecycle||{};
  const age=now()-Date.parse(lifecycle.updatedAt);
  return {active:runtime.orkestrThreadId===group.threadId && lifecycle.activeMessageId===route.message_id
    && lifecycle.running===true && lifecycle.awaitingApproval!==true && runtime.foregroundWorking===true
    && Number.isFinite(age) && age>=0 && age<=5000};
}
