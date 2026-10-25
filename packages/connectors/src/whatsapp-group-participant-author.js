// Explicit per-group inbound authorization. Participant identities never become
// owners, change reply destinations, or authorize commands in other threads.
const pn = value => typeof value === 'string' && /^\d+@c\.us$/.test(value);
const time = value => Date.parse(value);
const invalid = () => { throw new Error('group_participant_configuration_invalid'); };

export function createGroupParticipantPolicy(config, now = Date.now) {
  const rules = config.participantAuthors ?? [];
  if (!Array.isArray(rules)) invalid();
  const byGroup = new Map();
  for (const rule of rules) {
    const group = config.groups?.find(group => group.chatId === rule?.chatId);
    if (!rule || !group || group.threadId !== rule.threadId || byGroup.has(rule.chatId)
        || !Array.isArray(rule.ids) || !rule.ids.length || new Set(rule.ids).size !== rule.ids.length
        || rule.ids.some(id => !pn(id) || id === config.ownChatId)
        || !Number.isFinite(time(rule.since)) || !Number.isFinite(time(config.activatedAt))
        || time(rule.since) < time(config.activatedAt)
        || Object.keys(rule).some(key => !['chatId', 'threadId', 'ids', 'since'].includes(key))) invalid();
    byGroup.set(rule.chatId, {...rule, ids: new Set(rule.ids)});
  }
  function allows(proof, input) {
    const rule = byGroup.get(input.chat_id);
    return !!rule && proof?.version === 1 && proof.chatId === input.chat_id
      && proof.threadId === rule.threadId && proof.inputId === input.id
      && proof.createdAt === input.created_at && rule.ids.has(proof.phoneId)
      && (proof.authorId === proof.phoneId || /^\d+@lid$/.test(proof.authorId || ''))
      && Number.isFinite(time(input.created_at)) && time(input.created_at) > time(rule.since)
      && time(input.created_at) <= now() + 5000;
  }
  return {
    count: rules.length, accountId: config.workerAccountId || "main",
    allows,
    async identify(client, message, chatId) {
      const rule = byGroup.get(chatId), authorId = message?.author;
      const timestamp = Number(message?.timestamp) * 1000;
      if (!rule || message?.fromMe !== false || typeof authorId !== 'string'
          || !Number.isFinite(timestamp) || timestamp <= time(rule.since) || timestamp > now() + 5000) return null;
      let phoneId = rule.ids.has(authorId) ? authorId : null;
      if (!phoneId && /^\d+@lid$/.test(authorId) && typeof client.getContactLidAndPhone === 'function') {
        let timer;
        try {
          const rows = await Promise.race([
            client.getContactLidAndPhone([authorId]),
            new Promise(resolve => { timer = setTimeout(() => resolve([]), 3000); }),
          ]);
          if (Array.isArray(rows) && rows.length === 1 && rows[0]?.lid === authorId && rule.ids.has(rows[0]?.pn)) phoneId = rows[0].pn;
        } catch { /* Unavailable or ambiguous provider mapping fails closed. */ }
        finally { clearTimeout(timer); }
      }
      if (!phoneId) return null;
      return {version: 1, inputId: message.id._serialized, chatId, threadId: rule.threadId,
        authorId, phoneId, createdAt: new Date(timestamp).toISOString()};
    },
  };
}

export function participantInputMetadata({proof, input, group, thread, policy}) {
  const binding = thread.binding;
  if (!policy.allows(proof, input) || proof.threadId !== group.threadId
      || binding?.allowOtherPeople !== true || binding.mirrorToWhatsApp !== false || !Array.isArray(binding.authorizedContactIds)
      || !binding.authorizedContactIds.includes(proof.phoneId))
    throw new Error('group_participant_binding_denied');
  return {
    connector: 'whatsapp', accountId: policy.accountId, chatId: input.chat_id, externalId: input.id,
    from: proof.authorId, originOwner: false, controlAllowed: false, parseCommands: false,
    senderParticipantId: proof.authorId, senderTrustLevel: 'trusted', senderEffectiveRole: 'trusted',
    senderPolicyMode: 'this-thread-only', scopedParticipant: proof,
    externalPrincipal: {connector: 'whatsapp', accountId: policy.accountId, chatId: input.chat_id,
      senderId: proof.authorId, participantId: proof.authorId, bindingId: group.threadId},
  };
}
