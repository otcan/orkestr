import { getThread, getThreadMessage } from "./threads.js";
import { replyDeliveryBindingFence, trustedReplyDeliveryIntent } from "./reply-delivery-intent.js";

// Re-read durable authority immediately before transport, including retry sends.
export async function assertLiveReplyDeliveryBinding({ parent, threadId, chatId, accountId }, env = process.env) {
  const original = trustedReplyDeliveryIntent(parent);
  if (!original) return;
  const [thread, current] = await Promise.all([
    getThread(threadId, env), getThreadMessage(threadId, parent.id, env),
  ]);
  const intent = trustedReplyDeliveryIntent(current || {});
  const fence = replyDeliveryBindingFence(current || {}, thread || {});
  if (!thread || !intent || intent.id !== original.id || !fence.applies || !fence.allowed ||
      fence.chatId !== chatId || fence.accountId !== accountId) {
    throw Object.assign(new Error(`reply_delivery_fenced:${fence.reason || "authority_changed"}`), { retryable: false });
  }
}
