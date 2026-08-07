import {
  mailboxThreadDeliveryPumpIntervalMs,
  mailboxThreadDeliveryPumpLimit,
  pumpMailboxThreadDeliveries,
} from "../../core/src/mailbox-thread-delivery.js";
import { threadResourceAccessMode } from "../../core/src/thread-resource-grants.js";
import { replayMailboxPolicyOutageSpool } from "./mailbox-inbox.js";

export { mailboxThreadDeliveryPumpIntervalMs };

export async function runMailboxDeliveryPump(env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") {
    return { ok: true, skipped: "access_mode_off", deliveries: null, replay: null };
  }
  const limit = mailboxThreadDeliveryPumpLimit(env);
  return pumpMailboxThreadDeliveries({
    limit,
    replay: () => replayMailboxPolicyOutageSpool({ limit }, env),
  }, env);
}
