import {
  mailboxThreadDeliveryPumpIntervalMs,
  mailboxThreadDeliveryPumpLimit,
  pumpMailboxThreadDeliveries,
} from "../../core/src/mailbox-thread-delivery.js";
import { replayMailboxPolicyOutageSpool } from "./mailbox-inbox.js";

export { mailboxThreadDeliveryPumpIntervalMs };

export async function runMailboxDeliveryPump(env = process.env) {
  const limit = mailboxThreadDeliveryPumpLimit(env);
  return pumpMailboxThreadDeliveries({
    limit,
    replay: () => replayMailboxPolicyOutageSpool({ limit }, env),
  }, env);
}
