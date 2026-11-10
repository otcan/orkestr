// The compact notice footer for an operator notice sent through the scoped
// transport's operator send class (`kind: 'operator'`, orkestr-notify's
// fallback when its V2 "Operator" post fails). The V2 path reaches WhatsApp
// through the V1 relay and gets the notice footer there; this direct path must
// look the same: the provider quota lines and the q/load line, nothing else.
//
// Only when the transport config opts into the footer (`appendDebugFooter`),
// the chat is a configured group, and the group's footer-off switch (the same
// flags and env lists as threadSuppressesWhatsAppDebugFooter) is not set.
// Shared groups get it too (owner decision 2026-10-28). Any failure (no
// formatter, no quota) degrades to the honest "no data" lines or the bare
// text; the notice itself is always sent.
import { threadSuppressesWhatsAppDebugFooter } from './whatsapp-mirror-policy.js';
import { threadRequiresTenantIsolation } from '../../core/src/tenant-policy.js';

const QUOTA_TIMEOUT_MS = 1000;

export function operatorNoticeFooterChat(config = {}, chatId = '', env = process.env) {
  const group = (config.groups || []).find(entry => entry?.chatId === chatId);
  if (!group) return false;
  // Tenant isolation, as on the V1 relay path: a non-admin owner (or an
  // isolated security profile on the group) never gets the footer.
  if (threadRequiresTenantIsolation({ ownerUserId: config.ownerUserId || '', securityProfile: group.securityProfile }, env)) return false;
  return !threadSuppressesWhatsAppDebugFooter({ binding: group }, chatId, env);
}

// Never throws: any footer failure returns the bare text so the alert is sent.
export async function operatorNoticeText(options = {}) {
  try { return await noticeTextWithFooter(options); } catch { return options.text; }
}

async function noticeTextWithFooter({ text, to, config = {}, formatter = null, fetchQuota = null, maxLength = Infinity, env = process.env } = {}) {
  if (config.appendDebugFooter !== true || typeof formatter?.whatsappNoticeFooter !== 'function') return text;
  if (!operatorNoticeFooterChat(config, to, env)) return text;
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
