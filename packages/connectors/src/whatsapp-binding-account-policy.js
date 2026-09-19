import { findWhatsAppAccountByAnyId, whatsappAccountLookupKeys } from "./whatsapp-account-identity.js";

const clean = (value) => String(value || "").trim();

// Account evidence is supplied by connector state/status, never inbound payloads
// or the binding's arbitrary accountIds field. Reply identity does not grant
// permission to receive on a different account.
export function whatsappBindingInboundAccountPolicy(input = {}, binding = {}, state = {}, env = process.env) {
  const accountId = clean(input.accountId);
  const senderAccountId = clean(binding.senderAccountId) || clean(binding.inboundAccountId);
  if (!accountId || !senderAccountId) return { allowed: true };
  const accounts = (Array.isArray(state.connectorAccounts) ? state.connectorAccounts : [])
    .filter(account => account && typeof account === "object" && !account.deletedAt);
  const keys = (id) => {
    const account = findWhatsAppAccountByAnyId(accounts, id, env);
    return new Set([id, ...whatsappAccountLookupKeys(account || { accountId: id }, env)]
      .map(value => clean(value).toLowerCase()).filter(Boolean));
  };
  const expected = keys(senderAccountId);
  if ([...keys(accountId)].some(key => expected.has(key))) return { allowed: true };
  return { allowed: false, reason: "non_sender_account", expectedAccountId: senderAccountId.toLowerCase() };
}
