// Machine auth for Agent Job triggers: POST /api/jobs/<job>/trigger accepts a
// bearer token from ORKESTR_AGENT_JOB_TRIGGER_TOKEN(S), like the other machine
// endpoints. Without a matching trigger token the request falls through to the
// normal session / CLI-token auth, so operators can trigger runs too.
import crypto from "node:crypto";

const TRIGGER_PATH_RE = /^\/api\/jobs\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\/trigger$/;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

export function agentJobTriggerTokens(env = process.env) {
  return [env.ORKESTR_AGENT_JOB_TRIGGER_TOKEN, env.ORKESTR_AGENT_JOB_TRIGGER_TOKENS]
    .flatMap((value) => String(value || "").split(/[\s,]+/g))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isAgentJobTriggerRoute(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  return method === "POST" && TRIGGER_PATH_RE.test(url);
}

export function authorizeAgentJobTriggerRequest(request, env = process.env) {
  if (!isAgentJobTriggerRoute(request)) return null;
  const header = String(request?.headers?.authorization || request?.headers?.Authorization || "").trim();
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!token) return null;
  const matched = agentJobTriggerTokens(env).some((candidate) => crypto.timingSafeEqual(hash(token), hash(candidate)));
  if (!matched) return null;
  return {
    ok: true,
    machineAuth: "agent_job_trigger",
    machineAuthContext: { tokenId: "configured-agent-job-trigger-token", routeKind: "agent_job_trigger", scopes: ["jobs:trigger"] },
  };
}
