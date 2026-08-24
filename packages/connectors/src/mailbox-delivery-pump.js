import {
  mailboxThreadDeliveryPumpIntervalMs,
  mailboxThreadDeliveryPumpLimit,
  pumpMailboxThreadDeliveries,
} from "../../core/src/mailbox-thread-delivery.js";
import { threadResourceAccessMode } from "../../core/src/thread-resource-grants.js";
import { replayMailboxPolicyOutageSpool } from "./mailbox-inbox.js";
import { dispatchMailboxRouteWork } from "../../core/src/mailbox-routes.js";

export { mailboxThreadDeliveryPumpIntervalMs };

export async function runMailboxDeliveryPump(env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") {
    return { ok: true, skipped: "access_mode_off", deliveries: null, replay: null };
  }
  const limit = mailboxThreadDeliveryPumpLimit(env);
  const result = await pumpMailboxThreadDeliveries({
    limit,
    replay: () => replayMailboxPolicyOutageSpool({ limit }, env),
  }, env);
  if (result.skipped) return result;
  return { ...result, routeWork: await dispatchMailboxRouteWork({ limit }, env) };
}
