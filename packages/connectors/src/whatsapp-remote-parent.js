// A remote runtime may commit an input before its POST response is lost. Recover
// only that input's acknowledgement; this does not authorize another submission.
export function remoteParentRecoveryCandidate(thread, remote, remoteMessage, localMessages, remoteMessages) {
  const id = remoteMessage?.id || remoteMessage?.messageId;
  const publicId = remoteMessage?.publicMessageId;
  if (typeof id !== "string" || !id || typeof publicId !== "string" || !publicId) return null;
  if (remoteMessage.origin === "v1_local") return localInputRecoveryCandidate(thread, remoteMessage, localMessages, remoteMessages, id, publicId);
  if (remoteMessage.role !== "user" || remoteMessage.publicThreadId !== thread.id ||
      remoteMessage.source !== "whatsapp_inbound" || remoteMessage.connector !== "whatsapp") return null;
  // Ambiguous identities in one response cannot establish a parent mapping.
  if (remoteMessages.filter(row => row?.publicMessageId === publicId).length !== 1 ||
      remoteMessages.filter(row => (row?.id || row?.messageId) === id).length !== 1) return null;
  const local = localMessages.find(row => row.id === publicId);
  const accountId = remote.binding.responderAccountId || remote.binding.outboundAccountId || remote.binding.accountId;
  const chatId = remote.binding.chatId;
  if (!local || local.role !== "user" || local.source !== "whatsapp_inbound" || local.connector !== "whatsapp" ||
      local.remoteMessageId || local.remoteBackend !== remote.backendId || local.remoteThreadId !== remote.remoteThreadId ||
      !chatId || !accountId || local.chatId !== chatId || remoteMessage.chatId !== chatId ||
      local.accountId !== accountId || remoteMessage.accountId !== accountId ||
      typeof local.text !== "string" || remoteMessage.text !== local.text) return null;
  return local;
}

export function remoteParentExpectedFields(message) {
  return Object.fromEntries([
    "role", "source", "connector", "chatId", "accountId", "text",
    "remoteBackend", "remoteThreadId", "remoteMessageId",
  ].map(key => [key, message[key]]));
}

// A V1-local input whose intake acknowledgement was lost: the listed row names
// this thread and the local message as its public id. Only a local user input
// that is not yet mapped to any remote message qualifies.
function localInputRecoveryCandidate(thread, remoteMessage, localMessages, remoteMessages, id, publicId) {
  if (remoteMessage.role !== "user" || remoteMessage.publicThreadId !== thread.id || remoteMessage.connector !== "orkestr-v1") return null;
  if (remoteMessages.filter(row => row?.publicMessageId === publicId).length !== 1 ||
      remoteMessages.filter(row => (row?.id || row?.messageId) === id).length !== 1) return null;
  const local = localMessages.find(row => row.id === publicId);
  if (!local || local.role !== "user" || local.remoteMessageId || local.remoteBackend ||
      ["whatsapp_inbound", "whatsapp_group_relay"].includes(local.source)) return null;
  return local;
}
