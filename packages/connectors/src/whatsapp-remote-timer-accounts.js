// Enrich legacy registry aliases with the authenticated bridge's current account
// identity. Preserve records and ownership; never deduplicate colliding aliases.
import { canonicalWhatsAppAccountId, whatsappAccountLookupKeys } from "./whatsapp-account-identity.js";

export function verifiedTimerAccounts(registryAccounts, status = {}, env = process.env) {
  if (status.ok === false) return registryAccounts;
  const observed = Array.isArray(status.accounts) ? status.accounts : [];
  return registryAccounts.map(account => {
    const keys = new Set(whatsappAccountLookupKeys(account, env).map(key => key.toLowerCase()));
    const matches = observed.filter(candidate => candidate.ready === true && candidate.runtimeUsable !== false &&
      candidate.chatOpsReady !== false && whatsappAccountLookupKeys(candidate, env).some(key => keys.has(key.toLowerCase())));
    if (matches.length !== 1) return account;
    const canonical = canonicalWhatsAppAccountId(matches[0], env);
    if (!canonical) return account;
    return { ...account, id: canonical, accountId: canonical,
      runtimeAccountId: account.runtimeAccountId || account.accountId || account.id,
      legacyRoleAliases: [...(account.legacyRoleAliases || []), account.accountId, account.id].filter(Boolean) };
  });
}
