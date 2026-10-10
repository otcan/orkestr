// Signed webhook trigger: POST /api/jobs/<job>/hooks/<name> (agent-job.md
// §1.1). The route needs no session or bearer token; the request is
// authenticated only by an HMAC-SHA256 signature made with the trigger's
// `secret_ref`, resolved through the secure secret manager
// (agent-job-secrets.js). See agent-job-webhook-signature.js for the
// accepted headers and the replay window.
//
// The dedupe key is derived from the signed body only (the trigger's
// `event_id` pointer, else the body hash): unsigned headers such as
// Idempotency-Key or X-GitHub-Delivery are ignored, so replaying a captured
// request cannot start a second run. Redeliveries return the first run with
// HTTP 200, new runs return 202. Every refusal is written to trigger_audit
// with a reason code and no body text; callers always get the same 401 so
// the endpoint does not reveal which jobs or hooks exist.
import { admitRun } from "./agent-job-admission.js";
import { kickAgentJobRun } from "./agent-job-scheduler.js";
import { resolveAgentJobSecret } from "./agent-job-secrets.js";
import { getRegisteredJob, recordTriggerAudit } from "./agent-job-store.js";
import { verifyAgentJobWebhookSignature } from "./agent-job-webhook-signature.js";

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UNAUTHORIZED = { statusCode: 401, body: { ok: false, error: "agent_job_webhook_unauthorized" } };

function parseBody(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export async function handleAgentJobHook({ name, hook, rawBody, headers = {} }, env = process.env, {
  resolveSecret = resolveAgentJobSecret,
  now = Date.now(),
} = {}) {
  const job = NAME_RE.test(String(name || "")) ? String(name) : null;
  const hookName = NAME_RE.test(String(hook || "")) ? String(hook) : null;
  const refuse = async (reason, response = UNAUTHORIZED) => {
    await recordTriggerAudit({ job, type: "webhook", outcome: "rejected", reason, sourceRef: hookName }, env).catch(() => {});
    return response;
  };
  if (!job || !hookName) return refuse("webhook_route_invalid");
  const registered = await getRegisteredJob(job, env);
  const trigger = registered?.spec?.triggers?.find((entry) => entry.type === "webhook" && entry.name === hookName);
  if (!trigger) return refuse(registered ? "webhook_hook_not_declared" : "job_not_found");
  const secret = await resolveSecret(trigger.secretRef, { usedBy: `agent_job_webhook:${job}` }, env);
  const verified = verifyAgentJobWebhookSignature({ secret, rawBody, headers, now }, env);
  if (!verified.ok) return refuse(verified.reason);
  let body;
  try {
    body = parseBody(rawBody);
  } catch {
    return refuse("webhook_body_not_json", { statusCode: 400, body: { ok: false, error: "agent_job_webhook_body_not_json" } });
  }
  try {
    const admitted = await admitRun({ job, type: "webhook", name: hookName, body }, env);
    if (!admitted.deduplicated) kickAgentJobRun(admitted.run.id);
    return {
      statusCode: admitted.deduplicated ? 200 : 202,
      body: { ok: true, runId: admitted.run.id, job: admitted.run.job, state: admitted.run.state, deduplicated: admitted.deduplicated },
    };
  } catch (error) {
    const statusCode = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 600 ? Number(error.statusCode) : 500;
    return { statusCode, body: { ok: false, error: error?.code || "agent_job_trigger_failed" } };
  }
}
