import { appendEvent } from "../../storage/src/store.js";
import { ensureConnectorInboxEvent, markConnectorInboxEvent } from "./connector-inbox.js";
import {
  dispatchMailboxThreadDeliveries,
  enqueueMailboxThreadDeliveries,
  isMailboxThreadPolicyUnavailable,
} from "../../core/src/mailbox-thread-delivery.js";
import { routeMailboxMessage } from "../../core/src/mailboxes.js";

function publicRouted(routed = {}) {
  const { connectorInboxInput, mailboxDeliveryInput, ...safe } = routed;
  return safe;
}

async function recordMailboxIngress(mailbox, inbox, env) {
  if (!inbox.created) return;
  await appendEvent({
    type: "mailbox_message_received",
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    inboxEventId: inbox.event.id,
    deduped: false,
  }, env).catch(() => {});
}

export async function ingestMailboxMessage(input = {}, env = process.env) {
  const routed = await routeMailboxMessage(input, env);
  if (routed.action === "mailbox_thread_delivery_required") {
    const inbox = await ensureConnectorInboxEvent(routed.connectorInboxInput, env);
    await recordMailboxIngress(routed.mailbox, inbox, env);
    if (inbox.event.state === "routed") return { ...publicRouted(routed), action: "deduped", created: false, inboxEvent: inbox.event };
    try {
      const delivery = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, env);
      const dispatched = await dispatchMailboxThreadDeliveries({ deliveryIds: delivery.deliveryIds }, env);
      const completed = await markConnectorInboxEvent(inbox.event.id, {
        state: "routed",
        result: { deliveryIds: delivery.deliveryIds, unrouted: delivery.unrouted, dispatch: dispatched.results },
      }, env);
      return {
        ...publicRouted(routed),
        action: delivery.unrouted ? "mailbox_thread_delivery_unrouted" : "mailbox_thread_delivery_queued",
        created: inbox.created,
        delivery,
        dispatch: dispatched,
        inboxEvent: completed,
      };
    } catch (error) {
      if (!isMailboxThreadPolicyUnavailable(error)) throw error;
      const held = await markConnectorInboxEvent(inbox.event.id, { state: "policy-unavailable", error: String(error?.message || "mailbox_policy_unavailable") }, env);
      await appendEvent({ type: "mailbox_thread_delivery_policy_unavailable", mailboxId: routed.mailbox.id, ownerUserId: routed.mailbox.ownerUserId, reason: String(error?.message || "mailbox_policy_unavailable") }, env).catch(() => {});
      return { ...publicRouted(routed), action: "mailbox_policy_unavailable_spooled", created: inbox.created, policyUnavailable: true, inboxEvent: held };
    }
  }
  if (routed.action !== "connector_inbox_required") return routed;

  const inbox = await ensureConnectorInboxEvent(routed.connectorInboxInput, env);
  await recordMailboxIngress(routed.mailbox, inbox, env);
  return {
    ...publicRouted(routed),
    action: inbox.created ? "connector_inbox_queued" : "deduped",
    created: inbox.created,
    inboxEvent: inbox.event,
  };
}
