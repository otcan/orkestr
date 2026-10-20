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

export const remoteTimerParentSource = "orkestr-v2-timer";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxTimerTextLength = 500;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Returns the local id to materialize, or "" when the row is not an exact,
// unambiguous V2 timer row for this thread and binding.
export function remoteTimerParentId(thread, remote, remoteMessage, remoteMessages = []) {
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
  if (!chatId || !accountId || remoteMessage.chatId !== chatId || remoteMessage.accountId !== accountId) return "";
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
export async function materializeRemoteTimerParent({ thread, remote, remoteMessage, remoteMessages, localMessages, env }) {
  const publicId = remoteTimerParentId(thread, remote, remoteMessage, remoteMessages);
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
    createdAt: clean(remoteMessage.createdAt),
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: remoteMessage.id,
    remoteSyncedAt: new Date().toISOString(),
  }, env);
  if (!compatibleTimerParent(appended, remote, remoteMessage.id)) return null;
  return { message: appended, created: appended.duplicate !== true };
}
