// Optional owner-only entry to existing threads. No connector or binding is created here.
import { createHash } from 'node:crypto';

export function ownerSelfChatScope(env = process.env) {
  try {
    const s = JSON.parse(env.ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE || 'null');
    if (s?.enabled !== true || !['ownerUserId', 'accountId', 'chatId', 'homeThreadId'].every(k => typeof s[k] === 'string' && s[k].trim())
        || !Array.isArray(s.threadIds) || !s.threadIds.length || s.threadIds.some(id => typeof id !== 'string' || !id.trim())) return null;
    const scope = { ownerUserId:s.ownerUserId, accountId:s.accountId, chatId:s.chatId,
      homeThreadId:s.homeThreadId, threadIds:[...new Set(s.threadIds)].sort(),
      ...(s.transport === 'owner-selfchat-socket' ? {transport:s.transport,
        socketPath:s.socketPath,activatedAt:s.activatedAt,
        allowSuppressedThreadReplies:s.allowSuppressedThreadReplies===true} : {}) };
    if (scope.transport && (!scope.socketPath?.startsWith('/') || !Number.isFinite(Date.parse(scope.activatedAt)))) return null;
    return { ...scope, revision:createHash('sha256').update(JSON.stringify(scope)).digest('hex') };
  } catch { return null; }
}

export function ownerSelfChatIngress(scope, input, homeThread, binding) {
  return Boolean(scope && binding?.privateOwnerChat === true && binding.enabled !== false
    && homeThread?.id === scope.homeThreadId && homeThread.ownerUserId === scope.ownerUserId
    && input.accountId === scope.accountId && input.chatId === scope.chatId && binding.chatId === scope.chatId
    && (input.fromMe === true || input.fromMe === 'true'));
}

export function ownerSelfChatReplyRoute(parent, thread, env = process.env) {
  const origin = parent?.ownerSelfChatRevision ? { revision:parent.ownerSelfChatRevision, homeThreadId:parent.ownerSelfChatHomeThreadId } : null;
  if (!origin) return { applies:false };
  const scope = ownerSelfChatScope(env);
  const allowed = Boolean(scope && parent.source === 'whatsapp_inbound'
    && thread?.ownerUserId === scope.ownerUserId && scope.threadIds.includes(thread.id)
    && origin.revision === scope.revision && origin.homeThreadId === scope.homeThreadId
    && parent.accountId === scope.accountId && parent.chatId === scope.chatId);
  return { applies:true, allowed, accountId:allowed ? scope.accountId : '', chatId:allowed ? scope.chatId : '' };
}
