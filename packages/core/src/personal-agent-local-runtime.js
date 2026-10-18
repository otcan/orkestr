import { discoverLocalModel, localBaseUrl } from "./agent-job-openai-compatible-health.js";

// The single health projection consumed by Lane A's capability endpoint.
// It describes only the assistant runtime; it cannot disable project views.
export async function personalAgentLocalRuntimeStatus(env = process.env) {
  const model = String(env.ORKESTR_PERSONAL_AGENT_LOCAL_MODEL || "").trim();
  const endpoint = String(env.ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL || "").trim();
  const checkedAt = new Date().toISOString();
  const selected = model && model.length <= 128 ? { model } : {};
  if (!endpoint || !model || model.length > 128) return { available: false, reason: "not_configured", ...selected, checkedAt };
  try { localBaseUrl(endpoint); }
  catch { return { available: false, reason: "not_configured", ...selected, checkedAt }; }
  const status = await discoverLocalModel(env);
  return { available: status.ok, ...(!status.ok ? { reason: "local_runtime_unavailable" } : {}), ...selected, checkedAt: status.checkedAt };
}
