import { getThread, listThreadMessages, isThreadRetired } from '../../core/src/threads.js';
import { threadUsesApiAgent } from '../../core/src/tenant-api-agent.js';
import { ownerSelfChatReplyRoute } from './whatsapp-owner-selfchat-scope.js';
import { ownerSelfChatClient } from './whatsapp-owner-selfchat-client.js';
import { homeChatReplyText, recordHomeChatReply } from './whatsapp-home-chat.js';
import { threadAllowsWhatsAppMirroring } from './whatsapp-outbound-mirror.js';
import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';

export function createOwnerSelfChatPump({env,routeInbound,client=ownerSelfChatClient(env)}) {
  if(!client) throw selfChatError('selfchat_transport_not_configured');
  let active=false;
  return async function tick() {
    if(active) return {busy:true}; active=true;
    try {
      // Configuration is rechecked on each tick, including every reply.
      const current=ownerSelfChatClient(env);
      if(!current || current.scope.revision!==client.scope.revision) throw selfChatError('selfchat_scope_changed');
      const {scope}=client,counts={inbound:0,replies:0};
      for(const id of scope.threadIds) {
        const thread=await getThread(id,env);
        if(!thread || thread.ownerUserId!==scope.ownerUserId || isThreadRetired(thread) || threadUsesApiAgent(thread,env))
          throw selfChatError('selfchat_thread_ineligible');
      }
      const history=await client.call({operation:'history',mark_seen:false,limit:50});
      for(const message of history.messages) {
        const result=await routeInbound({accountId:scope.accountId,chatId:scope.chatId,
          eventId:message.id,from:message.from,to:message.to,fromMe:true,
          text:message.body,timestamp:message.timestamp},env);
        const messageId=result.message?.id || result.event?.messageId;
        if(!scope.threadIds.includes(result.threadId) || !messageId) throw selfChatError('selfchat_route_not_acknowledged');
        await client.call({operation:'ack',id:message.id,threadId:result.threadId,messageId});counts.inbound++;
      }
      const {routes}=await client.call({operation:'routes'});
      for(const threadId of scope.threadIds) {
        const thread=await getThread(threadId,env);
        const messages=await listThreadMessages(threadId,env);
        const parents=new Set(routes.filter(r=>r.threadId===threadId).map(r=>r.messageId));
        for(const message of messages) {
          if(message.role!=='assistant' || message.state!=='completed'
              || !['final_answer','final',''].includes(message.phase || '') || !parents.has(message.parentMessageId)
              || !message.text?.trim() || message.text.trim()==='NO_REPLY' || message.attachments?.length) continue;
          const parent=messages.find(m=>m.id===message.parentMessageId);
          const route=ownerSelfChatReplyRoute(parent,thread,env);
          if(!route.allowed || !parent.ownerSelfChatDedicatedTransport) continue;
          // An explicit exception is limited to authenticated scoped replies.
          // The original group suppression is never edited or lifted.
          if(!threadAllowsWhatsAppMirroring(thread) && !scope.allowSuppressedThreadReplies) continue;
          if(thread.binding?.enabled===false || thread.binding?.retired===true) continue;
          const text=homeChatReplyText(message.text,thread);
          const chunks=[];
          for(let i=0;i<text.length;i+=2800) chunks.push(text.slice(i,i+2800));
          for(const [index,chunk] of chunks.entries()) {
            if(ownerSelfChatClient(env)?.scope.revision!==scope.revision) throw selfChatError('selfchat_scope_changed');
            const liveThread=await getThread(threadId,env);
            if(!ownerSelfChatReplyRoute(parent,liveThread,env).allowed || isThreadRetired(liveThread)
                || liveThread.binding?.enabled===false) throw selfChatError('selfchat_scope_changed');
            const receipt=await client.call({operation:'send_text',threadId,parentMessageId:parent.id,
              requestId:`reply:${selfChatHash([scope.accountId,threadId,message.id,index])}`,text:chunk});
            await recordHomeChatReply({chatId:scope.chatId,threadId,messageIds:receipt.ids},env);
            if(!receipt.duplicate) counts.replies++;
          }
        }
      }
      return counts;
    } finally {active=false;}
  };
}
