import {dataPaths} from '../../storage/src/paths.js';
import {readJson} from '../../storage/src/store.js';
import {classifyWhatsAppInboundRequest, classifyWhatsAppMembershipChangeRequest, evaluateWhatsAppInboundSecurity,
  isWhatsAppParticipantBlocked} from './whatsapp-inbound-security.js';
import {sameOwnedWhatsAppAccount} from './whatsapp-account-scope.js';
import {createTimerAccountLookup} from './whatsapp-remote-timer-accounts.js';
import {normalizeWhatsAppParticipantIdentityConfig, whatsappParticipantIdentityV2Enabled} from './whatsapp-participant-identity.js';

const deny = () => { throw Object.assign(new Error('group_participant_security_denied'), {statusCode: 403}); };

// Invoked by the authenticated thread API, not by a browser/bridge identity
// supplied as an owner. The normal WhatsApp block lists and identity policy are
// evaluated on the server; neither the relay nor a caller can assert trust.
export async function checkScopedParticipant(thread, input, env = process.env, {fetchImpl = fetch} = {}) {
  const proof = input.scopedParticipant;
  const b = thread.binding || {};
  if (!proof || proof.version !== 1 || proof.threadId !== thread.id || proof.chatId !== b.chatId
      || proof.inputId !== input.externalId || proof.authorId !== input.from
      || input.chatId !== b.chatId || b.enabled !== true || b.routeEligible === false
      || b.retired || b.deprecated || thread.retired || thread.lifecycleState === 'retired'
      || b.allowOtherPeople !== true || b.mirrorToWhatsApp !== false
      || !/^\d+@c\.us$/.test(proof.phoneId || '')
      || !(proof.authorId === proof.phoneId || /^\d+@lid$/.test(proof.authorId || ''))
      || !Array.isArray(b.authorizedContactIds) || !b.authorizedContactIds.includes(proof.phoneId)
      || !input.accountId || !(b.responderAccountId || b.senderAccountId || b.inboundAccountId)
      || !Number.isFinite(Date.parse(proof.createdAt)) || Date.parse(proof.createdAt) > Date.now() + 5000) deny();
  // Missing/corrupt/unreadable state is not evidence that no block exists.
  const state = await readJson(dataPaths(env).whatsapp, null);
  if (!state || typeof state !== 'object' || Array.isArray(state)) deny();
  // Only membership/access changes are hard-refused for an admitted member.
  // The keyword classification is advisory metadata for the thread's model:
  // pasted profiles and lists ("Fix & Run ... Ads") must not silently drop input.
  if (classifyWhatsAppMembershipChangeRequest(input.text).change) deny();
  // Reuse the timer path's fresh registry/verified bridge snapshot. The caller
  // cannot assert an alias, physical identity, owner, or participant grant.
  const lookup = createTimerAccountLookup(env, fetchImpl);
  const equivalent = async (expected, received) => {
    if (sameOwnedWhatsAppAccount(thread, expected, received, [], env)) return true;
    const accounts = await lookup();
    return sameOwnedWhatsAppAccount(thread, expected, received, accounts, env) ||
      (accounts.length > 0 && sameOwnedWhatsAppAccount(thread, expected, received, await lookup(true), env));
  };
  let policyAccountId = input.accountId;
  try {
    if (!await equivalent(b.responderAccountId || b.senderAccountId || b.inboundAccountId, input.accountId)) deny();
    // Existing identity grants may name either selector. Evaluate their exact
    // immutable account scope only after proving the receiving account is the
    // same owned identity; never rewrite the grants or fallback from invalid ones.
    const identity = whatsappParticipantIdentityV2Enabled(env) ? normalizeWhatsAppParticipantIdentityConfig(b) : null;
    if (identity) {
      if (!await equivalent(identity.accountId, input.accountId)) deny();
      policyAccountId = identity.accountId;
    }
  } catch { deny(); }
  const classified = classifyWhatsAppInboundRequest(input.text);
  for (const from of new Set([proof.authorId, proof.phoneId])) {
    if (isWhatsAppParticipantBlocked({binding: b, state, chatId: b.chatId, from, env})) deny();
    // Identity, grants and blocks only; the text was judged above.
    const decision = evaluateWhatsAppInboundSecurity({binding: b, thread, state, env,
      input: {from, fromMe: false, accountId: policyAccountId, chatId: b.chatId, text: ''}});
    if (!decision.allowed) deny();
  }
  const labels = b.additionalParticipantLabels && typeof b.additionalParticipantLabels === 'object' ? b.additionalParticipantLabels : {};
  const senderLabel = String(labels[proof.authorId] || labels[proof.phoneId] || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
  return {allowed: true, ...(senderLabel ? {senderLabel} : {}), senderTrustLevel: 'trusted', senderEffectiveRole: 'trusted',
    senderPolicyMode: 'this-thread-only', originOwner: false, controlAllowed: false, parseCommands: false,
    securityClassification: classified};
}
