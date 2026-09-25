import { getThreadForPrincipal } from "./threads.js";
import { createWorkerReplyDeliveryIntent } from "./reply-delivery-intent.js";
import { resourceOwnerUserId } from "./policy.js";

function reject(code, statusCode = 403) {
  throw Object.assign(new Error(code), { statusCode });
}

// Called only by authenticated input admission, after stripping client intents.
// A binding alone must never turn private/internal work into external messages.
export async function prepareWorkerReplyInput(thread, body, principal, env = process.env) {
  if (body.workerReplyDelivery === undefined) return body;
  if (body.workerReplyDelivery !== "bound_whatsapp") reject("worker_reply_delivery_invalid", 400);
  await getThreadForPrincipal(thread.id, principal, env);
  if (principal.kind !== "user" || principal.userId !== thread.ownerUserId) reject("worker_reply_owner_required");
  if (thread.threadKind !== "worker" || !thread.parentThreadId) reject("worker_reply_worker_required", 409);
  const parent = await getThreadForPrincipal(thread.parentThreadId, principal, env);
  // Legacy parents may predate ownerUserId. Use the same ownership policy as
  // resource access; admin read access alone must never authorize a foreign owner.
  if (!parent || resourceOwnerUserId(parent, env) !== thread.ownerUserId) reject("worker_reply_parent_owner_mismatch");
  const replyDeliveryIntent = createWorkerReplyDeliveryIntent(thread, {
    mode: body.workerReplyDelivery, requestedByUserId: principal.userId,
  });
  if (replyDeliveryIntent.status !== "pending_reply") reject("worker_reply_binding_not_eligible", 409);
  return {
    ...body,
    source: "worker_assignment",
    originSurface: "orkestr-worker",
    originTransport: "authenticated-http",
    connector: "", chatId: "", accountId: "",
    replyDeliveryIntent,
  };
}
