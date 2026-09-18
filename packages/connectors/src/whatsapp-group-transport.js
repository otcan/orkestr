import { findWhatsAppAccountByAnyId } from "./whatsapp-account-identity.js";
import { createLocalWhatsAppChat } from "./whatsapp-local-bridge.js";
import { createExternalWhatsAppChat } from "./whatsapp-thread-groups.js";
import { unknownWhatsAppGroupAccountError } from "./whatsapp-group-create-evidence.js";

const clean = (value) => String(value || "").trim();

export function resolveWhatsAppGroupRuntimeAccounts(input, status = {}, env = process.env) {
  if (!["local", "worker"].includes(clean(status.mode))) return input;
  const accounts = [...(status.accounts || []), ...(status.health?.accounts || [])];
  const resolve = (id) => {
    const requested = clean(id);
    if (!requested) return "";
    const account = findWhatsAppAccountByAnyId(accounts, requested, env);
    if (!account) throw unknownWhatsAppGroupAccountError(input);
    return clean(account.runtimeAccountId || account.accountId || account.id);
  };
  return {
    ...input,
    senderAccountId: resolve(input.senderAccountId),
    responderAccountId: resolve(input.responderAccountId || input.outboundAccountId),
  };
}

// Keep canonical identity in the binding/provisioning ledger; translate only
// the transport request. A remote external bridge owns its own ID namespace.
export function createWhatsAppGroupForStatus(input, status, env = process.env, dependencies = {}) {
  const runtimeInput = resolveWhatsAppGroupRuntimeAccounts(input, status, env);
  return clean(status?.mode) === "local"
    ? (dependencies.createLocal || createLocalWhatsAppChat)({ ...runtimeInput, env })
    : (dependencies.createExternal || createExternalWhatsAppChat)(runtimeInput, env);
}
