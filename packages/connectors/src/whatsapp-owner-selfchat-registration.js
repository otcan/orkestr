import { getThread, isThreadRetired } from '../../core/src/threads.js';
import { threadUsesApiAgent } from '../../core/src/tenant-api-agent.js';
import { dataPaths, ensureDataDirs } from '../../storage/src/paths.js';
import { readJson, writeJson } from '../../storage/src/store.js';
import { normalizeWhatsAppPersistentBinding } from './whatsapp-binding-registry.js';
import { validWhatsAppConnectorAccountId } from './whatsapp-account-registry.js';
import { ownerSelfChatScope } from './whatsapp-owner-selfchat-scope.js';
import { ownerSelfChatClient } from './whatsapp-owner-selfchat-client.js';
import { selfChatError, selfChatHash } from './whatsapp-owner-selfchat-journal.js';

export async function planOwnerSelfChatRegistration(env=process.env) {
  const scope=ownerSelfChatScope(env);
  if(!scope || scope.transport!=='owner-selfchat-socket' || !scope.threadIds.includes(scope.homeThreadId)
      || !validWhatsAppConnectorAccountId(scope.accountId) || ['sender','main','receiver'].includes(scope.accountId)
      || !/^\d+@c\.us$/.test(scope.chatId)) throw selfChatError('selfchat_registration_scope_invalid');
  const threads=[];
  for(const id of scope.threadIds) {
    const thread=await getThread(id,env);
    if(!thread || thread.ownerUserId!==scope.ownerUserId || isThreadRetired(thread) || threadUsesApiAgent(thread,env))
      throw selfChatError('selfchat_registration_thread_invalid');
    threads.push({id:thread.id,bindingHash:selfChatHash(thread.binding || {})});
  }
  const state=await readJson(dataPaths(env).whatsapp,{});
  const bindingId=`owner-selfchat:${scope.accountId}`;
  const priorAccount=(state.connectorAccounts || []).find(a=>(a.accountId || a.id)===scope.accountId);
  const priorBinding=(state.bindings || []).find(b=>b.id===bindingId);
  if(priorAccount && priorAccount.sessionRef!==`owner-selfchat:${scope.accountId}`)
    throw selfChatError('selfchat_registration_account_conflict');
  if(priorBinding && (priorBinding.chatId!==scope.chatId || priorBinding.ownerUserId!==scope.ownerUserId))
    throw selfChatError('selfchat_registration_binding_conflict');
  if((state.bindings || []).some(b=>b.id!==bindingId && b.chatId===scope.chatId && !b.deletedAt && b.enabled!==false))
    throw selfChatError('selfchat_registration_chat_already_bound');
  const account={id:scope.accountId,accountId:scope.accountId,connector:'whatsapp',kind:'connector_account',
    ownerUserId:scope.ownerUserId,displayName:'Owner self-chat',runtimeAccountId:scope.accountId,
    sessionRef:`owner-selfchat:${scope.accountId}`,autostart:false,capabilities:['status','receive','send_text'],status:'configured'};
  const binding=normalizeWhatsAppPersistentBinding({id:bindingId,level:'chat',threadId:scope.homeThreadId,
    ownerUserId:scope.ownerUserId,chatId:scope.chatId,accountId:scope.accountId,
    responderConnectorAccountId:scope.accountId,senderAccountId:scope.accountId,
    senderContactId:scope.chatId,responderContactId:scope.chatId,
    ownerContactIds:[scope.chatId],ownerParticipantIds:[scope.chatId],
    authorizedContactIds:[scope.chatId],additionalParticipantsEnabled:false,additionalParticipantIds:[],
    privateOwnerChat:true,inboundSecurityMode:'owner-only',enabled:true,routeEligible:true,
    mirrorToWhatsApp:false,suppressWhatsAppUpdates:true}, {},env);
  return {version:1,scopeRevision:scope.revision,stateHash:selfChatHash(state),threads,account,binding,
    priorAccount:priorAccount || null,priorBinding:priorBinding || null};
}

// Operator-only action after review. No upsert of a thread, primary binding,
// global sender, participant list, campaign queue or existing outbox is done.
export async function applyOwnerSelfChatRegistration(plan,env=process.env,{approved=false}={}) {
  if(!approved) throw selfChatError('selfchat_registration_approval_required');
  const client=ownerSelfChatClient(env),health=await client?.call({operation:'health'});
  if(!health?.ready || !health.identityVerified || health.accountId!==client.scope.accountId)
    throw selfChatError('selfchat_registration_identity_required');
  const fresh=await planOwnerSelfChatRegistration(env);
  if(fresh.stateHash!==plan.stateHash || fresh.scopeRevision!==plan.scopeRevision
      || selfChatHash(fresh.threads)!==selfChatHash(plan.threads)) throw selfChatError('selfchat_registration_plan_stale');
  const paths=await ensureDataDirs(env),state=await readJson(paths.whatsapp,{});
  if(selfChatHash(state)!==plan.stateHash) throw selfChatError('selfchat_registration_plan_stale');
  // Recompute intended records; do not trust a caller-edited plan's payload.
  await writeJson(paths.whatsapp,{...state,
    connectorAccounts:[...(state.connectorAccounts || []).filter(a=>(a.accountId || a.id)!==fresh.account.id),fresh.account],
    bindings:[...(state.bindings || []).filter(b=>b.id!==fresh.binding.id),fresh.binding]});
  return {ok:true,accountId:fresh.account.id,bindingId:fresh.binding.id,scopeRevision:fresh.scopeRevision};
}

export async function retireOwnerSelfChatRegistration(env=process.env,{approved=false}={}) {
  if(!approved) throw selfChatError('selfchat_registration_approval_required');
  const scope=ownerSelfChatScope(env);
  if(!scope) throw selfChatError('selfchat_registration_scope_invalid');
  const paths=dataPaths(env),state=await readJson(paths.whatsapp,{});
  // Retain account and delivery records; make only the supplemental entry inert.
  await writeJson(paths.whatsapp,{...state,bindings:(state.bindings || []).map(b=>
    b.id===`owner-selfchat:${scope.accountId}` && b.ownerUserId===scope.ownerUserId && b.chatId===scope.chatId
      ? {...b,enabled:false,routeEligible:false,retired:true}:b)});
  return {ok:true};
}
