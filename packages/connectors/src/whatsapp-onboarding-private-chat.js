// First-run onboarding: bind the default thread to the paired account's own
// WhatsApp chat ("Message yourself"). Nobody else is ever added: configured
// default/owner participant lists are deliberately ignored, the account is the
// exact one paired in the wizard, and the request is refused if that account
// is no longer linked and ready.
import { getThread, updateThread } from "../../core/src/threads.js";
import { defaultWhatsAppReplyPrefix } from "../../core/src/whatsapp-defaults.js";
import { dualWriteWhatsAppParticipantIdentity } from "./whatsapp-participant-identity.js";

const clean = (value) => String(value || "").trim();

export class PrivateChatError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function statusAccounts(status = {}) {
  return [...(Array.isArray(status.accounts) ? status.accounts : []), ...(Array.isArray(status.health?.accounts) ? status.health.accounts : [])];
}

function accountUsable(account) {
  return Boolean(account) &&
    (account.ready === true || account.state === "ready") &&
    account.state !== "auth_failure" &&
    account.runtimeUsable !== false &&
    account.chatOpsReady !== false;
}

// Resolves the account pinned by the wizard; throws PrivateChatError otherwise.
export function pairedAccountForPrivateChat(status = {}, { pairedAccountId = "", pairedContactId = "" } = {}) {
  const accountId = clean(pairedAccountId);
  if (!accountId) throw new PrivateChatError("whatsapp_paired_account_required", 400);
  if (!["local", "worker"].includes(clean(status.mode))) throw new PrivateChatError("whatsapp_private_chat_requires_built_in_bridge", 409);
  const account = statusAccounts(status).find((item) => [item.accountId, item.id, item.runtimeAccountId].map(clean).includes(accountId));
  if (!accountUsable(account)) throw new PrivateChatError("whatsapp_paired_account_unavailable", 409);
  const contactId = clean(account.contactId);
  if (!/@c\.us$/i.test(contactId)) throw new PrivateChatError("whatsapp_paired_account_unavailable", 409);
  const expected = clean(pairedContactId);
  if (expected && expected !== contactId) throw new PrivateChatError("whatsapp_paired_account_changed", 409);
  return { accountId: clean(account.runtimeAccountId || account.accountId || account.id), contactId };
}

// Binds the thread to the account's own chat, owner-only. Idempotent for the same chat.
export async function bindThreadToPrivateOwnerChat(thread, { accountId, contactId, name = "" }, env = process.env) {
  const current = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  if (clean(current.chatId) && clean(current.chatId) !== contactId) throw new PrivateChatError("whatsapp_thread_already_bound", 409);
  const binding = dualWriteWhatsAppParticipantIdentity({
    ...current,
    connector: "whatsapp",
    chatId: contactId,
    displayName: clean(name) || clean(thread.name) || thread.id,
    enabled: true,
    allowOtherPeople: false,
    additionalParticipantsEnabled: false,
    additionalParticipantIds: [],
    additionalParticipantLabels: {},
    ownerParticipantIds: [contactId],
    inboundSecurityMode: "owner-only",
    mirrorToWhatsApp: current.mirrorToWhatsApp !== false,
    replyPrefix: clean(current.replyPrefix) || defaultWhatsAppReplyPrefix(),
    senderAccountId: accountId,
    responderAccountId: accountId,
    outboundAccountId: accountId,
    senderContactId: contactId,
    responderContactId: contactId,
    privateOwnerChat: true,
    generated: false,
    updatedAt: new Date().toISOString(),
  }, env);
  const reused = clean(current.chatId) === contactId;
  const updated = await updateThread(thread.id, { binding, bindingName: binding.displayName }, env);
  return {
    ok: true,
    created: false,
    reused,
    privateOwnerChat: true,
    thread: updated || (await getThread(thread.id, env)),
    chat: { id: contactId, name: binding.displayName, isGroup: false, privateOwnerChat: true },
    binding,
  };
}
