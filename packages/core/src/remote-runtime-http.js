// Shared authenticated remote-runtime transport. No connector side effects.
function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBackendConfig(backendId, config = {}) {
  const input = typeof config === "string" ? { baseUrl: config } : config && typeof config === "object" ? config : {};
  const baseUrl = pickString(input.baseUrl, input.url, input.endpoint);
  if (!baseUrl) return null;
  return {
    id: backendId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token: pickString(input.token, input.apiToken, input.bearerToken),
    timeoutMs: Math.max(1000, Number(input.timeoutMs || input.timeout || 10_000) || 10_000),
    fetchLimit: Math.max(1, Math.min(500, Number(input.fetchLimit || input.messageLimit || 100) || 100)),
    // Opt-in: upload accepted inbound files and reference them by upload ID.
    attachmentUpload: input.attachmentUpload === true,
  };
}

export function configuredRemoteThreadBackends(env = process.env) {
  const backends = {};
  for (const [id, config] of Object.entries(parseJsonObject(
    env.ORKESTR_REMOTE_THREAD_BACKENDS_JSON ||
      env.ORKESTR_REMOTE_RUNTIME_BACKENDS_JSON ||
      env.ORKESTR_REMOTE_BACKENDS_JSON ||
      "{}",
  ))) {
    const normalized = normalizeBackendConfig(String(id || "").trim(), config);
    if (normalized) backends[normalized.id] = normalized;
  }
  const defaultId = pickString(
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    env.ORKESTR_REMOTE_BACKEND_ID,
    "default",
  );
  const defaultUrl = pickString(
    env.ORKESTR_REMOTE_THREAD_BACKEND_URL,
    env.ORKESTR_REMOTE_THREAD_BACKEND_BASE_URL,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_URL,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_BASE_URL,
  );
  if (defaultUrl) {
    const normalized = normalizeBackendConfig(defaultId, {
      baseUrl: defaultUrl,
      token: pickString(
        env.ORKESTR_REMOTE_THREAD_BACKEND_TOKEN,
        env.ORKESTR_REMOTE_RUNTIME_BACKEND_TOKEN,
        env.ORKESTR_REMOTE_BACKEND_TOKEN,
      ),
      timeoutMs: env.ORKESTR_REMOTE_THREAD_BACKEND_TIMEOUT_MS || env.ORKESTR_REMOTE_RUNTIME_BACKEND_TIMEOUT_MS,
      fetchLimit: env.ORKESTR_REMOTE_THREAD_BACKEND_FETCH_LIMIT || env.ORKESTR_REMOTE_RUNTIME_BACKEND_FETCH_LIMIT,
    });
    if (normalized) backends[normalized.id] = normalized;
  }
  return backends;
}

export function backendForBinding(binding = {}, env = process.env) {
  const backendId = pickString(
    binding.remoteBackend,
    binding.remoteRuntimeBackend,
    binding.runtimeBackend,
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    "default",
  );
  const backend = configuredRemoteThreadBackends(env)[backendId];
  if (!backend) {
    const error = new Error(`whatsapp_remote_backend_not_configured:${backendId}`);
    error.statusCode = 502;
    throw error;
  }
  return backend;
}

export function remoteEndpointUrl(backend, endpointPath) {
  const endpoint = String(endpointPath || "").trim().replace(/^\/+/, "");
  return new URL(`${backend.baseUrl}/${endpoint}`);
}

export function remoteHeaders(backend, extra = {}) {
  return {
    "content-type": "application/json",
    ...(backend.token ? { authorization: `Bearer ${backend.token}` } : {}),
    ...extra,
  };
}

export async function remoteJson(backend, endpointPath, fetchImpl, options = {}) {
  const response = await fetchImpl(remoteEndpointUrl(backend, endpointPath), {
    ...options,
    headers: remoteHeaders(backend, options.headers || {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(backend.timeoutMs)]) : AbortSignal.timeout(backend.timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `remote_runtime_request_failed:${response.status}`);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

