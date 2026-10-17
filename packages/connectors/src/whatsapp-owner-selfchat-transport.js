// Pure policy for a separately authorized self-chat transport. No credentials,
// sockets, subprocesses, account registration or live requests are created here.
export function createOwnerSelfChatTransportPolicy(config = {}) {
  const { accountId, chatId, verifiedOwnChatId, activatedAt } = config;
  const cutoff = Date.parse(activatedAt);
  if (config.enabled !== true || config.identityVerified !== true
      || !accountId || chatId !== verifiedOwnChatId
      || !/^\d+@(?:c\.us|lid)$/.test(chatId || '') || !Number.isFinite(cutoff)) {
    throw new Error('owner_selfchat_transport_not_verified');
  }
  const deny = () => { throw new Error('owner_selfchat_transport_scope_denied'); };
  return {
    // An operator-owned adapter may execute only these fixed wrapper commands.
    // It must use argv (never a shell) and must not expose status pairing fields.
    command(request = {}) {
      if (request.accountId !== accountId || request.chatId !== chatId) return deny();
      if (request.operation === 'history') {
        if (request.mark_seen !== false) return deny();
        const limit = request.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) return deny();
        return ['history', chatId, String(limit)];
      }
      if (request.operation === 'send_text') {
        // Durable reservation and uncertain-send reconciliation are required in
        // the adapter before executing this plan, not supplied by caller flags.
        if (typeof request.text !== 'string' || !request.text.trim()
            || request.text.length > 3000 || request.attachmentPaths?.length) return deny();
        return ['send-text', chatId, request.text];
      }
      return deny();
    },
    // fromMe alone does not distinguish the owner from this agent. Suppress all
    // ingestion while delivery outcome is unknown; never guess by message text.
    inbound(messages, { outboundIds = [], consumedIds = [], deliveryUnresolved = true } = {}) {
      if (deliveryUnresolved) return [];
      const seen = new Set([...outboundIds, ...consumedIds]);
      return (Array.isArray(messages) ? messages : []).filter(message => {
        if (typeof message.id !== 'string' || !message.id || message.id.startsWith('summary:')
            || seen.has(message.id) || message.fromMe !== true
            || message.from !== chatId || message.to !== chatId
            || typeof message.body !== 'string' || !message.body.trim()
            || !Number.isFinite(Date.parse(message.timestamp))
            || Date.parse(message.timestamp) <= cutoff) return false;
        seen.add(message.id);
        return true;
      });
    },
  };
}
