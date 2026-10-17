// OP-09: local transport only. No API keys, remote hosts, discovery by scanning,
// downloads, or provider fallback. The feature flag is default-off.
import { personalAgentFeature } from "./personal-agent-feature.js";

export function localAdapterError(reason, { retryable = false, kind = "provider" } = {}) {
  return Object.assign(new Error(reason), { kind, retryable });
}

export function localModelConfig(env = process.env, ref = {}) {
  if (!personalAgentFeature(env)) throw localAdapterError("personal_agent_disabled");
  const endpoint = String(ref.baseUrl || env.ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL || "").trim();
  if (!endpoint) throw localAdapterError("local_endpoint_not_configured");
  const baseUrl = localBaseUrl(endpoint);
  const reasoningEffort = env.ORKESTR_PERSONAL_AGENT_LOCAL_REASONING_EFFORT || null;
  if (reasoningEffort && !["none", "low", "medium", "high"].includes(reasoningEffort)) throw localAdapterError("local_reasoning_effort_invalid");
  return { baseUrl, model: String(ref.model || env.ORKESTR_PERSONAL_AGENT_LOCAL_MODEL || "").trim(), reasoningEffort };
}

export function localBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw localAdapterError("local_endpoint_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw localAdapterError("local_endpoint_requires_loopback_v1");
  }
  return url.href.replace(/\/$/, "");
}

export async function discoverLocalModel(env = process.env, ref = {}, { signal, fetchImpl = fetch } = {}) {
  try {
    const config = localModelConfig(env, ref);
    const response = await fetchImpl(`${config.baseUrl}/models`, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) });
    if (!response.ok) throw localAdapterError(`local_discovery_http_${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.data) || body.data.length > 1000) throw localAdapterError("local_discovery_invalid");
    const models = body.data.map(model => model?.id).filter(id => typeof id === "string" && id.length <= 128);
    const reason = !config.model ? "local_model_not_configured" : !models.includes(config.model) ? "local_model_not_installed" : null;
    return { state: reason ? "unavailable" : "available", ok: !reason, connected: true, runnable: !reason, reason, models, model: config.model || null, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { state: "unavailable", ok: false, connected: false, runnable: false, models: [], reason: error?.kind ? error.message : "local_endpoint_unavailable", checkedAt: new Date().toISOString() };
  }
}
