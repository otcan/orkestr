// HTTP trigger for Agent Jobs: POST /api/jobs/<job>/trigger.
// * API trigger (default): optional `Idempotency-Key` header (or body
//   `idempotency_key`) is the dedupe key; body `event` is the trigger event.
// * Webhook trigger: `?hook=<name>` (or body `hook`) selects the job's webhook
//   trigger; the whole body is the event and the dedupe key comes from the
//   trigger's `event_id` pointer, else from the body hash.
// A redelivered event returns the first run with HTTP 200 (G2); a new run is
// on disk before the 202 response is sent (G1).
import { admitRun } from "./agent-job-admission.js";
import { kickAgentJobRun } from "./agent-job-scheduler.js";
import { isAdminPrincipal } from "./policy.js";

function header(headers = {}, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

export async function handleAgentJobTrigger({ name, query = {}, body = {}, headers = {}, principal = null, machineAuth = null, anonymous = false }, env = process.env) {
  const allowed = machineAuth === "agent_job_trigger" || (!anonymous && isAdminPrincipal(principal || {}));
  if (!allowed) return { statusCode: 403, body: { ok: false, error: "agent_job_trigger_forbidden" } };
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const hook = String(query.hook || payload.hook || "").trim();
  const dedupeKey = header(headers, "Idempotency-Key") || String(payload.idempotency_key || payload.idempotencyKey || "").trim();
  try {
    const admitted = hook
      ? await admitRun({ job: name, type: "webhook", name: hook, dedupeKey, body: payload }, env)
      : await admitRun({ job: name, type: "api", dedupeKey, body: payload.event ?? null }, env);
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
