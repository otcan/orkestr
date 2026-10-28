// The compact notice footer for an operator notice sent through the scoped
// transport's operator send class (`kind: 'operator'`, orkestr-notify's
// fallback when its V2 "Operator" post fails). The V2 path reaches WhatsApp
// through the V1 relay and gets the notice footer there; this direct path must
// look the same: the provider quota lines and the q/load line, nothing else.
//
// Only when the transport config opts into the footer (`appendDebugFooter`)
// and the chat is owner-only: a chat listed in `participantAuthors`, or whose
// group entry names a non-owner member, never gets one. Any failure (no
// formatter, no quota) degrades to the honest "no data" lines or the bare text;
// the notice itself is always sent.
import { threadHasNonOwnerMembers } from './whatsapp-footer-audience.js';

const QUOTA_TIMEOUT_MS = 1000;

export function operatorNoticeChatOwnerOnly(config = {}, chatId = '') {
  if ((config.participantAuthors || []).some(entry => entry?.chatId === chatId)) return false;
  const group = (config.groups || []).find(entry => entry?.chatId === chatId);
  if (!group) return false;
  return !threadHasNonOwnerMembers({ binding: group });
}

export async function operatorNoticeText({ text, to, config = {}, formatter = null, fetchQuota = null, maxLength = Infinity, env = process.env } = {}) {
  if (config.appendDebugFooter !== true || typeof formatter?.whatsappNoticeFooter !== 'function') return text;
  if (!operatorNoticeChatOwnerOnly(config, to)) return text;
  let thread = { id: 'operator-notice', ownerUserId: config.ownerUserId || '', binding: { chatId: to } };
  if (typeof fetchQuota === 'function' && config.ownerUserId) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fetchQuota(config.ownerUserId)),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), QUOTA_TIMEOUT_MS); }),
      ]);
      if (result?.quota) thread = { ...thread, whatsAppDebugProviderQuota: result.quota };
    } catch { /* no quota: the footer shows "no data" */ } finally { clearTimeout(timer); }
  }
  const body = typeof formatter.stripWhatsAppDebugFooter === 'function' ? formatter.stripWhatsAppDebugFooter(text) : text;
  const footer = formatter.whatsappNoticeFooter({ message: { role: 'assistant', kind: 'notice' }, thread, messages: [],
    deliveryType: 'router_update', env: { ...env, ORKESTR_WHATSAPP_DEBUG_FOOTER: '1' } });
  const withFooter = `${body}\n\n${footer}`;
  return withFooter.length <= maxLength ? withFooter : text;
}
