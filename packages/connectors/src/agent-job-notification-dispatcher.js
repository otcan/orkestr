// Delivers Agent Job notification rows (connector `agent_job` in the connector
// outbox, enqueued once by agent-job-notification-relay.js) to their channel.
// Each row is keyed H(run, event, channel, target) and is delivered at most
// once (runtime guarantee G10):
//
// * Only the holder of the outbox claim delivers a row; terminal rows are
//   never claimed again.
// * thread: appendThreadMessage with the row key as assistant idempotency key,
//   so a retry after a crash finds the first message instead of adding one.
// * whatsapp: a second outbox row (connector `whatsapp`, key `<row key>:whatsapp`)
//   goes through the existing claim -> send -> mark path. A claim that expires
//   mid-send is quarantined as `delivery_uncertain` by the outbox and is never
//   resent (whatsapp-replay-safety.js). Approval texts carry the
//   "approve <id>" / "deny <id>" reply hint handled by whatsapp-job-triggers.js.
// * email: the existing mail path (sendEmail). A send fence is written before
//   the call; a row found with the fence but no outcome (the process died
//   mid-send) becomes `delivery_uncertain` instead of being mailed twice.
// * webhook: agent-job-webhook-delivery.js (https only, Idempotency-Key).
//   Retries after errors or a crash reuse the same key.
// Retryable failures back off exponentially (connectorOutboxRetryDelayMs) up
// to ORKESTR_AGENT_JOB_NOTIFY_MAX_ATTEMPTS, then the row is dead-lettered.
// All transports are injectable; the tests never send anything.
import {
  claimConnectorOutboxJob,
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
  markConnectorOutboxJob,
  releaseConnectorOutboxClaim,
} from "./connector-outbox.js";
import { connectorOutboxRetryDelayMs } from "./connector-outbox-retry-policy.js";
import { deliverAgentJobWebhook } from "./agent-job-webhook-delivery.js";
import { injectFault } from "../../core/src/agent-job-faults.js";

const OPEN_STATES = "pending,failed_retryable,claimed";

export function agentJobNotifyMaxAttempts(env = process.env) {
  const value = Number(env.ORKESTR_AGENT_JOB_NOTIFY_MAX_ATTEMPTS || 8);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 8;
}

export function agentJobWhatsAppText(payload = {}) {
  const text = String(payload.text || `Agent job ${payload.job} run ${payload.runId}: ${payload.event}`);
  if (payload.event !== "approval_required" || !payload.approvalId) return text;
  const hint = `Reply "approve ${payload.approvalId}" or "deny ${payload.approvalId}" in this group.`;
  return text.includes(`approve ${payload.approvalId}`) && text.includes(`deny ${payload.approvalId}`) ? text : `${text}\n${hint}`;
}

function emailSubject(payload = {}) {
  const label = payload.event === "approval_required" ? "approval required" : String(payload.event || "update").replace(/_/g, " ");
  return `[Orkestr] ${payload.job}: ${label}`;
}

function receiptId(ack) {
  const id = ack?.id?._serialized || ack?.id || ack?.ids?.[0] || ack?.sent?.[0]?.id?._serialized || ack?.sent?.[0]?.id ||
    ack?.messageId || ack?.message?.id?._serialized || ack?.message?.id;
  return typeof id === "string" ? id : "";
}

async function defaultTransports(env) {
  return {
    async thread(threadId, message) {
      const { appendThreadMessage } = await import("../../core/src/threads.js");
      return appendThreadMessage(threadId, message, env);
    },
    async whatsapp(input) {
      const { sendWhatsAppText } = await import("./whatsapp.js");
      return sendWhatsAppText({ ...input, env });
    },
    async email(message) {
      const { sendEmail } = await import("../../core/src/email-notifications.js");
      return sendEmail(message, env);
    },
    async resolveBinding(bindingId) {
      const { readWhatsAppBindingRecords } = await import("./whatsapp-binding-registry.js");
      const binding = (await readWhatsAppBindingRecords(env).catch(() => [])).find((entry) => entry.id === bindingId);
      return binding && binding.enabled !== false && binding.chatId ? { chatId: binding.chatId, accountId: binding.accountId || "" } : null;
    },
  };
}

async function deliverThread(job, transports) {
  const { target, text } = job.payload;
  if (!target) return { state: "dead_letter", error: "thread_target_missing" };
  try {
    const message = await transports.thread(target, {
      role: "assistant",
      source: "agent_job",
      state: "completed",
      text,
      clientMessageId: job.idempotencyKey,
      dedupeAssistantByIdempotencyKey: true,
    });
    return { state: "delivered", receipt: { messageId: message?.id || null, duplicate: Boolean(message?.duplicate) } };
  } catch (error) {
    if (error?.message === "thread_not_found" || Number(error?.statusCode) === 404) return { state: "dead_letter", error: "thread_not_found" };
    return { state: "failed_retryable", error: "thread_append_failed" };
  }
}

async function deliverWhatsApp(job, transports, env, faults) {
  const target = String(job.payload.target || "").trim();
  const route = target.startsWith("binding:") ? await transports.resolveBinding(target.slice("binding:".length)) : target ? { chatId: target, accountId: "" } : null;
  if (!route?.chatId) return { state: "dead_letter", error: "whatsapp_target_unresolved" };
  const text = agentJobWhatsAppText(job.payload);
  const ensured = await ensureConnectorOutboxJob({
    connector: "whatsapp",
    accountId: route.accountId,
    chatId: route.chatId,
    deliveryType: "agent_job_notification",
    sourceEventId: job.idempotencyKey,
    sourceMessageId: job.idempotencyKey,
    idempotencyKey: `${job.idempotencyKey}:whatsapp`,
    payload: { text },
    metadata: { source: "agent_job", agentJobOutboxId: job.id },
  }, env);
  const inner = ensured.job;
  if (inner.state === "delivered") return { state: "delivered", receipt: { whatsappOutboxId: inner.id, ...(inner.brokerAck || {}) } };
  const claim = await claimConnectorOutboxJob(inner.id, { claimant: `agent-job-notify:${process.pid}` }, env);
  if (!claim.acquired) {
    const state = claim.job?.state;
    if (state === "delivered") return { state: "delivered", receipt: { whatsappOutboxId: inner.id } };
    if (claim.terminal) return { state: "delivery_uncertain", error: `whatsapp_${state || "terminal"}` };
    return { state: "failed_retryable", error: claim.reason || "whatsapp_claim_busy" };
  }
  let ack;
  try {
    ack = await transports.whatsapp({ chatId: route.chatId, accountId: route.accountId, text, requestId: inner.id, routeSentMessage: false });
  } catch (error) {
    if (/not_confirmed|timeout|partial/i.test(String(error?.message || ""))) {
      await markConnectorOutboxJob(inner.id, { state: "delivery_uncertain", error: "whatsapp_send_not_confirmed",
        metadata: { ...inner.metadata, deliveryUncertain: true } }, env);
      return { state: "delivery_uncertain", error: "whatsapp_send_not_confirmed" };
    }
    await releaseConnectorOutboxClaim(inner.id, { reason: "whatsapp_send_failed" }, env);
    return { state: "failed_retryable", error: "whatsapp_send_failed" };
  }
  injectFault(faults, "whatsapp_sent", {});
  const id = receiptId(ack);
  if (!id || ack?.ok === false) {
    await markConnectorOutboxJob(inner.id, { state: "delivery_uncertain", error: "whatsapp_ack_missing",
      metadata: { ...inner.metadata, deliveryUncertain: true } }, env);
    return { state: "delivery_uncertain", error: "whatsapp_ack_missing" };
  }
  await markConnectorOutboxJob(inner.id, { state: "delivered", deliveredAt: new Date().toISOString(), brokerAck: { id } }, env);
  return { state: "delivered", receipt: { whatsappOutboxId: inner.id, id } };
}

async function deliverEmail(job, transports, env, faults) {
  const to = String(job.payload.target || "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(to)) return { state: "dead_letter", error: "email_target_invalid" };
  if (job.metadata?.emailSendStartedAt) return { state: "delivery_uncertain", error: "email_send_interrupted" };
  await markConnectorOutboxJob(job.id, { metadata: { ...job.metadata, emailSendStartedAt: new Date().toISOString() } }, env);
  let result;
  try {
    result = await transports.email({ to: [to], subject: emailSubject(job.payload), text: job.payload.text });
  } catch {
    // The transport returned an error, so the message was not accepted.
    return { state: "failed_retryable", error: "email_send_failed", metadata: { emailSendStartedAt: null } };
  }
  injectFault(faults, "email_sent", {});
  if (result?.ok) return { state: "delivered", receipt: { messageId: result.messageId || null, provider: result.provider || null } };
  if (result?.configured === false) return { state: "skipped", error: result.skippedReason || "email_not_configured" };
  return { state: "failed_retryable", error: "email_send_failed", metadata: { emailSendStartedAt: null } };
}

async function deliver(job, transports, env, faults) {
  switch (job.payload?.channel) {
    case "thread": return deliverThread(job, transports);
    case "whatsapp": return deliverWhatsApp(job, transports, env, faults);
    case "email": return deliverEmail(job, transports, env, faults);
    case "webhook": return deliverAgentJobWebhook(job, env, { fetchImpl: transports.fetchImpl || fetch, resolveSecret: transports.resolveSecret });
    default: return { state: "dead_letter", error: "notification_channel_unknown" };
  }
}

async function record(job, outcome, env) {
  const now = new Date().toISOString();
  const metadata = { ...job.metadata, ...(outcome.metadata || {}), lastOutcome: outcome.state };
  if (outcome.state === "delivered") {
    return markConnectorOutboxJob(job.id, { state: "delivered", deliveredAt: now, brokerAck: outcome.receipt || {}, error: "", metadata }, env);
  }
  if (outcome.state === "failed_retryable") {
    if (Number(job.attemptCount || 0) >= agentJobNotifyMaxAttempts(env)) {
      return markConnectorOutboxJob(job.id, { state: "dead_letter", failedAt: now, error: `${outcome.error}:max_attempts`, metadata }, env);
    }
    const retryAt = new Date(Date.now() + connectorOutboxRetryDelayMs(job.attemptCount || 1, env)).toISOString();
    return markConnectorOutboxJob(job.id, { state: "failed_retryable", failedAt: now, claimExpiresAt: retryAt, claimedBy: "", claimedAt: "", error: outcome.error, metadata }, env);
  }
  return markConnectorOutboxJob(job.id, {
    state: outcome.state,
    ...(outcome.state === "skipped" ? { skippedAt: now } : { failedAt: now }),
    error: outcome.error || "",
    metadata,
  }, env);
}

/**
 * Deliver every due `agent_job` outbox row once.
 * @param {{ transports?: object, limit?: number, faults?: any[] }} [options]
 */
export async function dispatchAgentJobNotifications({ transports = {}, limit = 50, faults = [] } = {}, env = process.env) {
  const resolved = { ...(await defaultTransports(env)), ...transports };
  const { jobs } = await listConnectorOutboxJobs({ connector: "agent_job", state: OPEN_STATES }, env);
  const results = [];
  for (const candidate of jobs.slice().reverse().slice(0, limit)) {
    const claim = await claimConnectorOutboxJob(candidate.id, { claimant: `agent-job-notify:${process.pid}` }, env);
    if (!claim.acquired) continue;
    const job = claim.job;
    let outcome;
    try {
      outcome = await deliver(job, resolved, env, faults);
    } catch (error) {
      if (error?.injectedCrash) throw error;
      outcome = { state: "failed_retryable", error: "notification_dispatch_failed" };
    }
    injectFault(faults, "notify_delivered", {});
    const updated = await record(job, outcome, env);
    results.push({ id: job.id, channel: job.payload?.channel, state: updated?.state || outcome.state, error: updated?.error || outcome.error || null });
  }
  return results;
}
