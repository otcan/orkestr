import fsSync from "node:fs";
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
  const effective = effectiveCliEnv(env);
  if (effective.ORKESTR_API_BASE) return String(effective.ORKESTR_API_BASE).replace(/\/+$/g, "");
  const host = effective.ORKESTR_HOST || "127.0.0.1";
  const port = effective.ORKESTR_PORT || effective.PORT || "19812";
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
  const token = await cliAuthToken(effectiveCliEnv(env));
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

const envFileKeys = new Set([
  "ORKESTR_API_BASE",
  "ORKESTR_API_TOKEN",
  "ORKESTR_CLI_AUTH_TOKEN",
  "ORKESTR_DISABLE_CLI_AUTH",
  "ORKESTR_HOME",
  "ORKESTR_HOST",
  "ORKESTR_PORT",
  "PORT",
]);

function effectiveCliEnv(env = process.env) {
  const fileEnv = readCliEnvFile(env);
  const merged = { ...fileEnv };
  for (const [key, value] of Object.entries(env || {})) {
    if (!envFileKeys.has(key)) continue;
    if (String(value || "").trim() || key === "ORKESTR_DISABLE_CLI_AUTH") merged[key] = value;
  }
  return { ...(env || {}), ...merged };
}

function readCliEnvFile(env = process.env) {
  const envFile = String(env.ORKESTR_ENV_FILE || "/etc/orkestr/orkestr.env").trim();
  if (!envFile) return {};
  let raw = "";
  try {
    raw = fsSync.readFileSync(envFile, "utf8");
  } catch {
    return {};
  }
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !envFileKeys.has(match[1])) continue;
    parsed[match[1]] = parseEnvValue(match[2]);
  }
  return parsed;
}

function parseEnvValue(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "\""
      ? inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
      : inner;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
