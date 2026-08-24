import { appendEvent } from "../../storage/src/store.js";
import { ensureConnectorInboxEvent, listConnectorInboxEvents, markConnectorInboxEvent } from "./connector-inbox.js";
import {
  dispatchMailboxThreadDeliveries,
  enqueueMailboxThreadDeliveries,
  isMailboxThreadPolicyUnavailable,
} from "../../core/src/mailbox-thread-delivery.js";
import { dispatchMailboxRouteWork } from "../../core/src/mailbox-routes.js";
import { getMailbox, routeMailboxMessage } from "../../core/src/mailboxes.js";
import { acceptingMailboxStatuses } from "../../core/src/mailbox-normalization.js";
import { dispatchVmMailboxRelay } from "./mailbox-vm-relay.js";

function mailboxPolicyReplayDelayMs(attempt = 1, env = process.env) {
  const base = Math.max(1_000, Number(env.ORKESTR_MAILBOX_POLICY_REPLAY_RETRY_MS || 5_000) || 5_000);
  return Math.min(5 * 60_000, base * (2 ** Math.max(0, attempt - 1)));
}

function mailboxPolicyReplayMaxAttempts(env = process.env) {
  return Math.max(1, Math.min(20, Number(env.ORKESTR_MAILBOX_POLICY_REPLAY_MAX_ATTEMPTS || 5) || 5));
}

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
  if (routed.action === "vm_relay_required") {
    const inbox = await ensureConnectorInboxEvent(routed.connectorInboxInput, env);
    await recordMailboxIngress(routed.mailbox, inbox, env);
    const relay = inbox.event.state === "routed"
      ? { ok: true, audit: routed.relayAudit }
      : await dispatchVmMailboxRelay(routed.relayAudit, env);
    return {
      ...publicRouted(routed),
      action: relay.ok ? "vm_relay_delivered" : "vm_relay_queued",
      created: inbox.created,
      relayAudit: relay.audit || routed.relayAudit,
      relayError: relay.ok ? "" : relay.error,
      inboxEvent: relay.ok ? await ensureConnectorInboxEvent(routed.connectorInboxInput, env).then((result) => result.event) : inbox.event,
    };
  }
  if (routed.action === "mailbox_thread_delivery_required") {
    const inbox = await ensureConnectorInboxEvent(routed.connectorInboxInput, env);
    await recordMailboxIngress(routed.mailbox, inbox, env);
    if (inbox.event.state === "routed") return { ...publicRouted(routed), action: "deduped", created: false, inboxEvent: inbox.event };
    try {
      const delivery = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, env);
      const dispatched = await dispatchMailboxThreadDeliveries({ deliveryIds: delivery.deliveryIds }, env);
      const routeDispatch = await dispatchMailboxRouteWork({ workIds: delivery.routeSource?.workId ? [delivery.routeSource.workId] : [] }, env);
      const completed = await markConnectorInboxEvent(inbox.event.id, {
        state: "routed",
        result: { deliveryIds: delivery.deliveryIds, unrouted: delivery.unrouted, dispatch: dispatched.results, routeDispatch: routeDispatch.results },
      }, env);
      return {
        ...publicRouted(routed),
        action: delivery.unrouted ? "mailbox_thread_delivery_unrouted" : "mailbox_thread_delivery_queued",
        created: inbox.created,
        delivery,
        dispatch: dispatched,
        routeDispatch,
        inboxEvent: completed,
      };
    } catch (error) {
      if (!isMailboxThreadPolicyUnavailable(error)) throw error;
      const attemptCount = Number(inbox.event.attemptCount || 0) + 1;
      const held = await markConnectorInboxEvent(inbox.event.id, {
        state: "policy-unavailable",
        attemptCount,
        nextAttemptAt: new Date(Date.now() + mailboxPolicyReplayDelayMs(attemptCount, env)).toISOString(),
        error: String(error?.message || "mailbox_policy_unavailable"),
      }, env);
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

export async function replayMailboxPolicyOutageSpool({ limit = 25 } = {}, env = process.env) {
  const events = await listConnectorInboxEvents({ states: ["policy-unavailable"], connectors: ["mailbox"], limit }, env);
  const due = events.filter((event) => !event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= Date.now());
  const results = [];
  for (const event of due) {
    const mailbox = await getMailbox(event.accountId, env);
    if (!mailbox || mailbox.target?.type !== "main" || !acceptingMailboxStatuses.has(mailbox.status)) {
      const terminal = await markConnectorInboxEvent(event.id, { state: "dead_letter", nextAttemptAt: "", error: "mailbox_policy_replay_mailbox_inactive" }, env);
      results.push({ id: event.id, state: terminal.state, reason: terminal.error });
      continue;
    }
    try {
      const delivery = await enqueueMailboxThreadDeliveries({ mailbox, message: event.payload, idempotencyKey: event.id }, env);
      const dispatched = await dispatchMailboxThreadDeliveries({ deliveryIds: delivery.deliveryIds }, env);
      const routeDispatch = await dispatchMailboxRouteWork({ workIds: delivery.routeSource?.workId ? [delivery.routeSource.workId] : [] }, env);
      const completed = await markConnectorInboxEvent(event.id, {
        state: "routed",
        nextAttemptAt: "",
        error: "",
        result: { deliveryIds: delivery.deliveryIds, unrouted: delivery.unrouted, dispatch: dispatched.results, routeDispatch: routeDispatch.results },
      }, env);
      results.push({ id: event.id, state: completed.state, deliveryIds: delivery.deliveryIds });
    } catch (error) {
      const attemptCount = Number(event.attemptCount || 0) + 1;
      const terminal = attemptCount >= mailboxPolicyReplayMaxAttempts(env);
      const updated = await markConnectorInboxEvent(event.id, {
        state: terminal ? "dead_letter" : "policy-unavailable",
        attemptCount,
        nextAttemptAt: terminal ? "" : new Date(Date.now() + mailboxPolicyReplayDelayMs(attemptCount, env)).toISOString(),
        error: String(error?.message || "mailbox_policy_replay_failed"),
      }, env);
      await appendEvent({ type: terminal ? "mailbox_thread_delivery_policy_replay_dead_lettered" : "mailbox_thread_delivery_policy_replay_deferred", mailboxId: mailbox.id, ownerUserId: mailbox.ownerUserId, inboxEventId: event.id, reason: updated.error }, env).catch(() => {});
      results.push({ id: event.id, state: updated.state, reason: updated.error });
    }
  }
  return { inspected: events.length, attempted: due.length, results };
}
