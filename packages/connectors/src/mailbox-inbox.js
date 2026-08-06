import { appendEvent } from "../../storage/src/store.js";
import { ensureConnectorInboxEvent } from "./connector-inbox.js";
import { routeMailboxMessage } from "../../core/src/mailboxes.js";

export async function ingestMailboxMessage(input = {}, env = process.env) {
  const routed = await routeMailboxMessage(input, env);
  if (routed.action !== "connector_inbox_required") return routed;

  const inbox = await ensureConnectorInboxEvent(routed.connectorInboxInput, env);
  await appendEvent({
    type: "mailbox_message_received",
    mailboxId: routed.mailbox.id,
    ownerUserId: routed.mailbox.ownerUserId,
    inboxEventId: inbox.event.id,
    deduped: !inbox.created,
  }, env).catch(() => {});

  const { connectorInboxInput, ...publicRouted } = routed;
  return {
    ...publicRouted,
    action: inbox.created ? "connector_inbox_queued" : "deduped",
    created: inbox.created,
    inboxEvent: inbox.event,
  };
}
