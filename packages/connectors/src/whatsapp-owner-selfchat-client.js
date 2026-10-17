import { ownerSelfChatScope } from './whatsapp-owner-selfchat-scope.js';
import { ownerSelfChatSocketRequest } from './whatsapp-owner-selfchat-socket.js';
import { selfChatError } from './whatsapp-owner-selfchat-journal.js';
import { ownerSelfChatTransportContract } from './whatsapp-owner-selfchat-transport.js';

export function ownerSelfChatClient(env=process.env, request=ownerSelfChatSocketRequest) {
  const scope=ownerSelfChatScope(env);
  if(!scope || scope.transport!=='owner-selfchat-socket') return null;
  return {scope, call: body=>request(scope.socketPath,{...body,accountId:scope.accountId,chatId:scope.chatId,
    contract:ownerSelfChatTransportContract(scope)})};
}

export async function ownerSelfChatStatusForInput(input, env=process.env) {
  const client=ownerSelfChatClient(env);
  if(!client || input.accountId!==client.scope.accountId) return null;
  if(input.chatId!==client.scope.chatId) throw selfChatError('selfchat_chat_denied',403);
  const status=await client.call({operation:'health'});
  if(!status.ready || !status.identityVerified) throw selfChatError('selfchat_transport_not_ready');
  return {ok:true,mode:'owner-selfchat-socket',accounts:[{id:client.scope.accountId,
    accountId:client.scope.accountId,runtimeAccountId:client.scope.accountId,
    contactId:client.scope.chatId,ready:true,authenticated:true,state:'ready'}]};
}
