// Parents for replies to V2 timer turns relayed by the multi-chat adapter.
//
// A V2-owned timer fires inside the remote runtime, so V1 never saw an input.
// The runtime exports a synthetic user row for that turn (source
// "orkestr-v2-timer", publicMessageId "v2timer-<id>") followed by the normal
// assistant reply. V1 materializes exactly one local, completed user message
// with id = publicMessageId so the reply has a mapped parent, is mirrored like
// any other reply, and its mirror ack reports parentPublicMessageId.
//
// The materialized message is history only: it is "completed", carries no
// WhatsApp connector, chat or account, and is never queued, forwarded to the
// remote runtime, or mirrored to WhatsApp.
import { appendThreadMessage } from "../../core/src/threads.js";
import { appendEvent } from "../../storage/src/store.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { readWhatsAppConnectorAccounts } from "./whatsapp-account-registry.js";
import { whatsappAccountLookupKeys } from "./whatsapp-account-identity.js";
import { verifiedTimerAccounts } from "./whatsapp-remote-timer-accounts.js";

export const remoteTimerParentSource = "orkestr-v2-timer";
// Server receipt for a materialized parent; the scoped relay's timer
// notifications deliver the reply to the bound chat from this proof chain.
export const remoteTimerParentEvent = "whatsapp_remote_timer_parent_materialized";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxTimerTextLength = 500;
const postAuthors = new Set(["coordinator", "operator", "assistant_question"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sameTimerAccount(thread, expected, received, accounts, env) {
  expected = clean(expected);
  received = clean(received);
  if (!expected || !received) return false;
  if (expected === received) return true;
  // Both selectors must identify the same unique, active registry record.
  // Never infer an alias from a role name or select the first matching account.
  const matches = selector => accounts.filter(account => !account.deletedAt &&
    !["disabled", "revoked"].includes(account.status) &&
    whatsappAccountLookupKeys(account, env).some(key => key.toLowerCase() === selector.toLowerCase()));
  const left = matches(expected), right = matches(received);
  return left.length === 1 && right.length === 1 && left[0] === right[0] &&
    resourceOwnerUserId(left[0], env) === resourceOwnerUserId(thread, env);
}

// Returns the local id to materialize, or "" when the row is not an exact,
// unambiguous V2 timer row for this thread and binding.
export function remoteTimerParentId(thread, remote, remoteMessage, remoteMessages = [], { accounts = [], env = process.env } = {}) {
  const id = remoteMessage?.id;
  if (typeof id !== "string" || !uuidPattern.test(id)) return "";
  const publicId = `v2timer-${id}`;
  if (remoteMessage.role !== "user" || remoteMessage.source !== remoteTimerParentSource ||
      remoteMessage.origin !== "timer" || remoteMessage.publicThreadId !== thread?.id ||
      remoteMessage.publicMessageId !== publicId) return "";
  const text = clean(remoteMessage.text);
  if (!text || text.length > maxTimerTextLength) return "";
  const binding = remote?.binding || {};
  const accountId = binding.responderAccountId || binding.outboundAccountId || binding.accountId;
  const chatId = binding.chatId;
  if (!chatId || remoteMessage.chatId !== chatId ||
      !sameTimerAccount(thread, accountId, remoteMessage.accountId, accounts, env)) return "";
  if (remoteMessages.filter((row) => row?.publicMessageId === publicId).length !== 1 ||
      remoteMessages.filter((row) => (row?.id || row?.messageId) === id).length !== 1) return "";
  return publicId;
}

function compatibleTimerParent(local, remote, remoteMessageId) {
  return local?.role === "user" && local.source === remoteTimerParentSource &&
    local.remoteBackend === remote.backendId && local.remoteThreadId === remote.remoteThreadId &&
    local.remoteMessageId === remoteMessageId;
}

// Maps (or creates once) the local parent for a V2 timer row. Returns the local
// message and whether it was created, or null when the row does not qualify.
export async function materializeRemoteTimerParent({ thread, remote, remoteMessage, remoteMessages, localMessages, env, fetchImpl = fetch }) {
  const binding = remote?.binding || {};
  const accountId = binding.responderAccountId || binding.outboundAccountId || binding.accountId;
  const accounts = accountId === remoteMessage.accountId ? [] : await readWhatsAppConnectorAccounts(env);
  let publicId = remoteTimerParentId(thread, remote, remoteMessage, remoteMessages, { accounts, env });
  if (!publicId && accountId !== remoteMessage.accountId && accounts.length) {
    // A legacy registry may store only the runtime alias. Resolve its current
    // physical identity through the existing read-only bridge status path.
    const { getWhatsAppStatus } = await import("./whatsapp.js");
    const status = await getWhatsAppStatus(env, fetchImpl, { readOnly: true });
    publicId = remoteTimerParentId(thread, remote, remoteMessage, remoteMessages,
      { accounts: verifiedTimerAccounts(accounts, status, env), env });
  }
  if (!publicId) return null;
  const existing = localMessages.find((message) => message.id === publicId);
  if (existing) return compatibleTimerParent(existing, remote, remoteMessage.id) ? { message: existing, created: false } : null;
  const appended = await appendThreadMessage(thread.id, {
    requestedMessageId: publicId,
    role: "user",
    source: remoteTimerParentSource,
    state: "completed",
    text: clean(remoteMessage.text),
    timerId: clean(remoteMessage.timerSourceId),
    // Conversation posts (timerId "post") name their author so the relay
    // labels them as coordinator or system messages, not timers.
    ...(postAuthors.has(clean(remoteMessage.postAuthor)) ? { postAuthor: clean(remoteMessage.postAuthor) } : {}),
    createdAt: clean(remoteMessage.createdAt),
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: remoteMessage.id,
    remoteSyncedAt: new Date().toISOString(),
  }, env);
  if (!compatibleTimerParent(appended, remote, remoteMessage.id)) return null;
  const created = appended.duplicate !== true;
  if (created) {
    await appendEvent({
      type: remoteTimerParentEvent,
      threadId: thread.id,
      target: thread.id,
      targetType: "thread",
      ownerUserId: thread.ownerUserId || "",
      messageId: appended.id,
      remoteBackend: remote.backendId,
      remoteThreadId: remote.remoteThreadId,
      remoteMessageId: remoteMessage.id,
      timerSourceId: clean(remoteMessage.timerSourceId),
    }, env).catch(() => {});
  }
  return { message: appended, created };
}
