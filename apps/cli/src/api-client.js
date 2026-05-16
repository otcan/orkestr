export class ApiError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function defaultApiBase(env = process.env) {
  if (env.ORKESTR_API_BASE) return String(env.ORKESTR_API_BASE).replace(/\/+$/g, "");
  const host = env.ORKESTR_HOST || "127.0.0.1";
  const port = env.ORKESTR_PORT || env.PORT || "19812";
  return `http://${host}:${port}`;
}

export async function requestJson(path, options = {}) {
  const {
    baseUrl = defaultApiBase(options.env),
    body,
    fetchImpl = globalThis.fetch,
    method = body === undefined ? "GET" : "POST",
  } = options;
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/g, "")}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (!response.ok) {
    const message = payload?.error || payload?.message || text || `HTTP ${response.status}`;
    throw new ApiError(message, { status: response.status, payload });
  }
  return payload;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
