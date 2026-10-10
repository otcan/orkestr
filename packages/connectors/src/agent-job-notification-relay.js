// Relays Agent Job notification intents (written by the runner in the same
// transaction as the run state change) into the connector outbox. The outbox
// idempotency key equals the intent key, so a crash between "enqueued" and
// "marked relayed" re-runs as a no-op: each (run, event, channel, target) is
// enqueued at most once (runtime guarantee G10). Delivery of `agent_job` rows
// to their channel is a separate dispatcher (see docs/spec/agent-job-runner.md).
import { listPendingNotifications, markNotificationRelayed } from "../../core/src/agent-job-audit.js";
import { injectFault } from "../../core/src/agent-job-faults.js";
import { ensureConnectorOutboxJob } from "./connector-outbox.js";

export async function relayAgentJobNotifications({ faults = [], limit = 100 } = {}, env = process.env) {
  const relayed = [];
  for (const intent of await listPendingNotifications({ limit }, env)) {
    const ensured = await ensureConnectorOutboxJob({
      connector: "agent_job",
      deliveryType: `agent_job.${intent.payload.event}`,
      sourceEventId: intent.key,
      sourceMessageId: intent.key,
      idempotencyKey: intent.key,
      payload: intent.payload,
      // Owner default: notification channels never carry approval decisions.
      metadata: { channel: intent.channel, target: intent.target, approvalChannel: false },
    }, env);
    injectFault(faults, "notify", {});
    const outboxJobId = ensured?.job?.id || ensured?.id || null;
    await markNotificationRelayed(intent.key, outboxJobId, env);
    relayed.push({ key: intent.key, outboxJobId });
  }
  return relayed;
}
