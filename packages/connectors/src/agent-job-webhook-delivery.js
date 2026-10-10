// Outgoing webhook delivery for Agent Job notifications (channel `webhook`).
// * https:// only. A `vault://` target is resolved through the secure secret
//   manager and must also be https; the resolved URL never appears in errors.
// * Every request carries `Idempotency-Key` (the notification key, stable
//   across retries) so receivers can drop retried deliveries.
// * Redirects are not followed (a 3xx could downgrade to http).
// * Network errors, timeouts, 408, 425, 429 and 5xx are retryable; any other
//   non-2xx is permanent.
import { resolveAgentJobSecret } from "../../core/src/agent-job-secrets.js";

export function agentJobWebhookTimeoutMs(env = process.env) {
  const value = Number(env.ORKESTR_AGENT_JOB_WEBHOOK_TIMEOUT_MS || 10_000);
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : 10_000;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname ? url : null;
  } catch {
    return null;
  }
}

export async function resolveWebhookTarget(target, env = process.env, resolveSecret = resolveAgentJobSecret) {
  const raw = String(target || "").trim();
  const value = raw.startsWith("vault://") ? await resolveSecret(raw, { usedBy: "agent_job_notification_webhook" }, env) : raw;
  return value ? httpsUrl(value.trim()) : null;
}

/**
 * @returns {Promise<{ state: "delivered", receipt: object } | { state: "failed_retryable" | "dead_letter", error: string }>}
 */
export async function deliverAgentJobWebhook(job, env = process.env, { fetchImpl = fetch, resolveSecret = resolveAgentJobSecret } = {}) {
  const payload = job.payload || {};
  const url = await resolveWebhookTarget(payload.target, env, resolveSecret);
  if (!url) return { state: "dead_letter", error: "webhook_target_not_https" };
  const body = JSON.stringify({
    type: `agent_job.${payload.event}`,
    id: job.idempotencyKey,
    job: payload.job,
    run_id: payload.runId,
    event: payload.event,
    text: payload.text,
    ...(payload.approvalId ? { approval_id: payload.approvalId, tool: payload.tool || null } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
  });
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "orkestr-agent-jobs",
        "idempotency-key": job.idempotencyKey,
        "x-orkestr-event": `agent_job.${payload.event}`,
        "x-orkestr-delivery": job.idempotencyKey,
      },
      body,
      signal: AbortSignal.timeout(agentJobWebhookTimeoutMs(env)),
    });
  } catch (error) {
    return { state: "failed_retryable", error: error?.name === "TimeoutError" ? "webhook_timeout" : "webhook_network_error" };
  }
  const status = Number(response?.status || 0);
  if (status >= 200 && status < 300) return { state: "delivered", receipt: { status } };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { state: "failed_retryable", error: `webhook_http_${status}` };
  return { state: "dead_letter", error: `webhook_http_${status || "unknown"}` };
}
