import {dataPaths} from '../../storage/src/paths.js';
import {readJson} from '../../storage/src/store.js';
import {classifyWhatsAppInboundRequest, evaluateWhatsAppInboundSecurity, isWhatsAppParticipantBlocked} from './whatsapp-inbound-security.js';

const deny = () => { throw Object.assign(new Error('group_participant_security_denied'), {statusCode: 403}); };

// Invoked by the authenticated thread API, not by a browser/bridge identity
// supplied as an owner. The normal WhatsApp block lists and identity policy are
// evaluated on the server; neither the relay nor a caller can assert trust.
export async function checkScopedParticipant(thread, input, env = process.env) {
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
      || !input.accountId || input.accountId !== (b.responderAccountId || b.senderAccountId || b.inboundAccountId)
      || !Number.isFinite(Date.parse(proof.createdAt)) || Date.parse(proof.createdAt) > Date.now() + 5000) deny();
  // Missing/corrupt/unreadable state is not evidence that no block exists.
  const state = await readJson(dataPaths(env).whatsapp, null);
  if (!state || typeof state !== 'object' || Array.isArray(state)) deny();
  const classified = classifyWhatsAppInboundRequest(input.text);
  if (classified.malicious) deny();
  for (const from of new Set([proof.authorId, proof.phoneId])) {
    if (isWhatsAppParticipantBlocked({binding: b, state, chatId: b.chatId, from, env})) deny();
    const decision = evaluateWhatsAppInboundSecurity({binding: b, thread, state, env,
      input: {from, fromMe: false, accountId: input.accountId, chatId: b.chatId, text: input.text}});
    if (!decision.allowed) deny();
  }
  return {allowed: true, senderTrustLevel: 'trusted', senderEffectiveRole: 'trusted',
    senderPolicyMode: 'this-thread-only', originOwner: false, controlAllowed: false, parseCommands: false,
    securityClassification: classified};
}
