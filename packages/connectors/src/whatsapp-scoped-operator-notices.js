// Operator notices: short host alerts (disk, memory, health watchers) posted by
// the operator into explicitly listed owner groups, with no parent message and
// no timer proof. This is a separate, narrow send class of the scoped transport:
//   - opt-in config `operatorNotifications: {enabled: true, chatIds: [...], maxPerHour}`;
//   - every chat must be a statically configured scoped group;
//   - the request id must be `opnotice:<id>`; no parent, thread or notification id;
//   - text only, journaled like every other send (parent `operator-notice`), deduped by
//     request id, uncertain results block retries, and a per-hour cap bounds a runaway sender.
// It never reads messages, never marks anything seen and never counts as owner input.
export const OPERATOR_NOTICE_PARENT = 'operator-notice';
const REQUEST_ID = /^opnotice:[A-Za-z0-9._-]{8,150}$/;
const BODY_KEYS = ['accountId', 'to', 'text', 'requestId', 'operatorNotice'];

export function validateOperatorNotifications(config) {
  const p = config.operatorNotifications;
  if (p === undefined || p === null || p.enabled !== true) return null;
  const invalid = () => { throw new Error('operator_notifications_configuration_invalid'); };
  const known = new Set((config.groups || []).map(g => g.chatId));
  const max = p.maxPerHour === undefined ? 60 : p.maxPerHour;
  if (!Array.isArray(p.chatIds) || !p.chatIds.length || new Set(p.chatIds).size !== p.chatIds.length
      || p.chatIds.some(id => typeof id !== 'string' || !known.has(id))
      || !Number.isInteger(max) || max < 1 || max > 600
      || Object.keys(p).some(k => !['enabled', 'chatIds', 'maxPerHour'].includes(k))) invalid();
  const chats = new Set(p.chatIds);
  return { allowsChat: chatId => chats.has(chatId), maxPerHour: max, chatCount: chats.size };
}

// HTTP-level shape of a send-text body for an operator notice.
export function operatorNoticeBodyValid(policy, body, accountId) {
  return Boolean(policy) && body?.operatorNotice === true && policy.allowsChat(body.to) && body.accountId === accountId
    && typeof body.text === 'string' && Boolean(body.text.trim()) && REQUEST_ID.test(body.requestId || '')
    && Object.keys(body).every(k => BODY_KEYS.includes(k));
}

export function operatorNoticeRequestValid(policy, to, request) {
  return Boolean(policy) && request?.operatorNotice === true && policy.allowsChat(to) && REQUEST_ID.test(request.requestId || '')
    && request.parentId === undefined && request.notificationId === undefined && request.threadId === undefined;
}
