import fs from "node:fs/promises";
import path from "node:path";

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
    headers: await requestHeaders({ body, env: options.env }),
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

async function requestHeaders({ body, env = process.env } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = await cliAuthToken(env);
  if (token) headers.authorization = `Bearer ${token}`;
  return Object.keys(headers).length ? headers : undefined;
}

async function cliAuthToken(env = process.env) {
  const explicit = String(env.ORKESTR_API_TOKEN || env.ORKESTR_CLI_AUTH_TOKEN || "").trim();
  if (explicit) return explicit;
  if (String(env.ORKESTR_DISABLE_CLI_AUTH || "").trim() === "1") return "";
  const home = String(env.ORKESTR_HOME || "").trim();
  if (!home) return "";
  try {
    const raw = await fs.readFile(path.join(home, "secrets", "cli-auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    const token = String(parsed.token || "").trim();
    if (!token) return "";
    const expiresAt = Date.parse(String(parsed.expiresAt || ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return "";
    return token;
  } catch {
    return "";
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
