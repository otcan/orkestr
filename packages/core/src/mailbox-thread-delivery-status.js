import { policyError } from "./policy.js";
import { readThreadResourcePolicy, threadResourceId } from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();

export async function mailboxThreadDeliveryStatus({ mailbox, resourceId = "" } = {}, env = process.env) {
  const id = clean(resourceId) || threadResourceId("mailbox", mailbox?.id, mailbox?.ownerUserId, env);
  if (!id) throw policyError("mailbox_listener_mailbox_required", 400);
  const state = await readThreadResourcePolicy(env);
  const deliveries = (state.mailboxDeliveries || []).filter((item) => item.resourceId === id);
  const pending = deliveries.filter((item) => item.state === "pending" || item.state === "claimed");
  const oldest = pending.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    mailboxResourceId: id,
    listenerCount: (state.mailboxListeners || []).filter((item) => item.resourceId === id && item.status === "active" && !item.revokedAt).length,
    pending: pending.length,
    unrouted: deliveries.filter((item) => item.state === "quarantined").length,
    deadLetter: deliveries.filter((item) => item.state === "dead-letter").length,
    oldestPendingAt: oldest ? new Date(oldest).toISOString() : null,
    oldestLagMs: oldest ? Math.max(0, Date.now() - oldest) : 0,
  };
}
