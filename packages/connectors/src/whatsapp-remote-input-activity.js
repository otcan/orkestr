// Exact-input, fresh execution hints. This read never creates or steers a turn.
import {getThread} from '../../core/src/threads.js';
import {backendForBinding,remoteEndpointUrl,remoteHeaders,remoteWhatsAppRuntimeBinding} from './whatsapp-remote-runtime.js';

export async function remoteInputActivity({threadId,publicMessageId},env=process.env,fetchImpl=fetch,{readThread=getThread,now=Date.now}={}) {
  const thread=await readThread(threadId,env);
  const remote=remoteWhatsAppRuntimeBinding(thread,env);
  if(!thread || !remote) return {ok:true,supported:false,active:false};
  const backend=backendForBinding(remote.binding,env);
  const url=remoteEndpointUrl(backend,`threads/${encodeURIComponent(remote.remoteThreadId)}/activity?publicMessageId=${encodeURIComponent(publicMessageId)}`);
  const response=await fetchImpl(url,{headers:remoteHeaders(backend),signal:AbortSignal.timeout(Math.min(backend.timeoutMs,1500))});
  if(response.status===404) return {ok:true,supported:false,active:false};
  if(!response.ok) throw new Error('remote_activity_unavailable');
  const value=await response.json();
  if(value.ok!==true || value.version!==1 || value.publicThreadId!==thread.id || value.publicMessageId!==publicMessageId)
    throw new Error('remote_activity_scope_mismatch');
  const fresh=Number.isSafeInteger(value.observedAtMs) && now()-value.observedAtMs>=0 && now()-value.observedAtMs<=5000;
  return {ok:true,supported:true,publicThreadId:thread.id,publicMessageId,
    active:fresh && value.active===true && value.phase==='running',fastReady:value.fastReady===true,finalReady:value.finalReady===true,
    observedAtMs:value.observedAtMs};
}
