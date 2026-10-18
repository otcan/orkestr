// Explicit secondary owner identities. These authorize inbound authors only;
// they never change the connected reply account or permitted group recipients.
export function createGroupOwnerAuthorPolicy(config, now = Date.now) {
  const rule = config.additionalOwnerAuthors;
  if (rule === undefined) return {contract: null, count: 0, async accepts() { return false; }};
  if (!rule || !Array.isArray(rule.ids) || rule.ids.length !== 1
      || rule.ids.some(id => !/^\d+@c\.us$/.test(id) || id === config.ownChatId)
      || !Number.isFinite(Date.parse(rule.since))
      || Date.parse(rule.since) < Date.parse(config.activatedAt)
      || Object.keys(rule).some(k => !['ids', 'since'].includes(k))) {
    throw new Error('group_transport_owner_author_configuration_invalid');
  }
  const ids = new Set(rule.ids);
  return {
    contract: [rule.ids, rule.since], count: ids.size,
    async accepts(client, message) {
      if (message?.fromMe !== false || Number(message.timestamp) * 1000 <= Date.parse(rule.since)
          || Number(message.timestamp) * 1000 > now() + 5000) return false;
      const author = message.author;
      if (typeof author !== 'string') return false;
      if (ids.has(author)) return true;
      if (!/^\d+@lid$/.test(author) || typeof client.getContactLidAndPhone !== 'function') return false;
      // Provider mapping must bind this exact LID to the explicitly approved PN.
      // No name matching, forwarded/quoted author fallback or persistent cache.
      let timer;
      try {
        const rows = await Promise.race([
          client.getContactLidAndPhone([author]),
          new Promise(resolve => { timer = setTimeout(() => resolve([]), 3000); }),
        ]);
        return Array.isArray(rows) && rows.length === 1 && rows[0]?.lid === author && ids.has(rows[0]?.pn);
      } catch { return false; }
      finally { clearTimeout(timer); }
    },
  };
}
