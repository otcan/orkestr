// First-run onboarding: bind the default thread to the paired account's own
// WhatsApp chat ("Message yourself"). This path is separate from the shared
// thread-groups route on purpose: it never reads configured default/owner
// participant lists, rejects any participant fields, uses exactly the account
// pinned at pairing, and refuses if that account is no longer linked and ready
// or not accessible to the requesting principal.
import { getThread, updateThread } from "../../core/src/threads.js";
import { defaultWhatsAppReplyPrefix } from "../../core/src/whatsapp-defaults.js";
import { assertWhatsAppConnectorAccountAccess } from "./whatsapp-account-registry.js";
import { dualWriteWhatsAppParticipantIdentity } from "./whatsapp-participant-identity.js";

const clean = (value) => String(value || "").trim();

export class PrivateChatError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Fields that would let a caller add people or pick another account.
const forbiddenFields = [
  "participantIds", "participants", "adminParticipantIds", "promoteParticipantsAsAdmins",
  "receivingAccountId", "inboundAccountId", "senderAccountId", "replyAccountId", "bridgeAccountId",
  "responderAccountId", "outboundAccountId", "forceNew",
];

// Validates the request body; returns the pinned identity.
export function privateChatRequest(body = {}) {
  const present = forbiddenFields.filter((key) => Object.prototype.hasOwnProperty.call(body || {}, key));
  if (present.length) throw new PrivateChatError("whatsapp_private_chat_fields_not_allowed", 400);
  const threadId = clean(body.threadId);
  if (!threadId) throw new PrivateChatError("thread_id_required", 400);
  const pairedAccountId = clean(body.pairedAccountId);
  const pairedContactId = clean(body.pairedContactId);
  if (!pairedAccountId || !/@c\.us$/i.test(pairedContactId)) throw new PrivateChatError("whatsapp_paired_account_required", 400);
  return { threadId, pairedAccountId, pairedContactId, name: clean(body.name).slice(0, 100) };
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

// Resolves the pinned account from the live bridge status and checks that the
// principal may use it (registered owner, or the instance admin for
// unregistered built-in bridge slots).
export function pairedAccountForPrivateChat(status = {}, { pairedAccountId, pairedContactId }, { principal = {}, registeredAccounts = [], env = process.env } = {}) {
  if (!["local", "worker"].includes(clean(status.mode))) throw new PrivateChatError("whatsapp_private_chat_requires_built_in_bridge", 409);
  const account = statusAccounts(status).find((item) => [item.runtimeAccountId, item.accountId, item.id].map(clean).includes(pairedAccountId));
  if (!accountUsable(account)) throw new PrivateChatError("whatsapp_paired_account_unavailable", 409);
  const accountId = clean(account.runtimeAccountId || account.accountId || account.id);
  const registered = registeredAccounts.find((item) => [item.accountId, item.id, item.runtimeAccountId].map(clean).some((id) => id && [accountId, clean(account.accountId)].includes(id)));
  try {
    assertWhatsAppConnectorAccountAccess(registered || {}, principal, "wa_onboarding_private_chat", env);
  } catch {
    throw new PrivateChatError("whatsapp_paired_account_forbidden", 403);
  }
  const contactId = clean(account.contactId);
  if (!/@c\.us$/i.test(contactId)) throw new PrivateChatError("whatsapp_paired_account_unavailable", 409);
  if (contactId !== pairedContactId) throw new PrivateChatError("whatsapp_paired_account_changed", 409);
  return { accountId, contactId };
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
    reused,
    privateOwnerChat: true,
    thread: updated || (await getThread(thread.id, env)),
    chat: { id: contactId, name: binding.displayName, isGroup: false, privateOwnerChat: true },
    binding,
  };
}
