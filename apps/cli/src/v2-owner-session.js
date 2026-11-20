// Owner browser session against a local Orkestr V2 server, for terminal use.
//
// `orkestr attach` talks to a V2-served chat the way the V2 web composer does:
// it signs in with the owner's stored login, sends owner-authored messages and
// reads the conversation's run updates. The login never leaves this process:
// it is read from a root-only file, sent only to a loopback V2 API, and the
// session is deleted again on exit. Nothing here prints a credential.
import fs from "node:fs";
import http from "node:http";

export const defaultAdapterConfigPath = "/etc/orkestr-v2-wa-adapter/service.json";
export const defaultOwnerCredentialsPath = "/var/lib/orkestr-v2-pilot/owner-credentials.json";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const requestTimeoutMs = 30_000;

function clean(value) {
  return String(value ?? "").trim();
}

export function v2AttachError(code, message) {
  const error = new Error(message ? `${code}: ${message}` : code);
  error.code = code;
  return error;
}

// Reads a private JSON file. A permission error names the fix (run as root),
// never the file's content.
export function readPrivateJson(file, label, readFile = fs.readFileSync) {
  let text;
  try {
    text = readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw v2AttachError("v2_attach_root_required", `${label} (${file}) is readable by root only; run: sudo orkestr attach ...`);
    }
    if (error?.code === "ENOENT") throw v2AttachError("v2_attach_config_missing", `${label} not found: ${file}`);
    throw v2AttachError("v2_attach_config_unreadable", `${label}: ${file}`);
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw v2AttachError("v2_attach_config_invalid", `${label} is not a JSON object: ${file}`);
}

function loopbackApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw v2AttachError("v2_attach_config_invalid", "V2 API base is not a URL");
  }
  // The owner login is sent in clear HTTP: only ever to this host.
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || !url.port) {
    throw v2AttachError("v2_attach_config_invalid", "V2 API base must be http://127.0.0.1:<port> (loopback)");
  }
  return `${url.protocol}//${url.host}`;
}

function canonicalOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw v2AttachError("v2_attach_config_invalid", "V2 origin is not a URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw v2AttachError("v2_attach_config_invalid", "V2 origin must be a bare http(s) origin");
  }
  return url.origin;
}

// Where the local V2 server is and how chats map to conversations. The V1<->V2
// WhatsApp adapter's service config is the source of truth on a host that runs
// it; ORKESTR_V2_ORIGIN / ORKESTR_V2_API_BASE stand in on a host without it.
export function v2AttachConfig(env = process.env, readFile = fs.readFileSync) {
  const configPath = clean(env.ORKESTR_V2_ADAPTER_CONFIG) || defaultAdapterConfigPath;
  let file = {};
  try {
    file = readPrivateJson(configPath, "V2 adapter config", readFile);
  } catch (error) {
    if (error.code !== "v2_attach_config_missing" || !clean(env.ORKESTR_V2_ORIGIN) || !clean(env.ORKESTR_V2_API_BASE)) throw error;
  }
  const origin = clean(env.ORKESTR_V2_ORIGIN) || clean(file.origin);
  const apiBase = clean(env.ORKESTR_V2_API_BASE) || clean(file.loopback_url);
  if (!origin || !apiBase) throw v2AttachError("v2_attach_config_invalid", `${configPath} names no origin/loopback_url`);
  return {
    configPath,
    origin: canonicalOrigin(origin),
    apiBase: loopbackApiBase(apiBase),
    bindingsDir: clean(env.ORKESTR_V2_ADAPTER_BINDINGS_DIR) || clean(file.bindings_dir),
    credentialsPath: clean(env.ORKESTR_V2_OWNER_CREDENTIALS) || defaultOwnerCredentialsPath,
  };
}

export function readOwnerLogin(config, readFile = fs.readFileSync) {
  const value = readPrivateJson(config.credentialsPath, "V2 owner login", readFile);
  const username = typeof value.username === "string" ? value.username : "";
  const password = typeof value.password === "string" ? value.password : "";
  if (!username || !password) throw v2AttachError("v2_attach_config_invalid", `${config.credentialsPath} holds no owner username/password`);
  return { username, password };
}

export function nodeHttpRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    // No keep-alive agent: a finished chat leaves no socket holding the process.
    const request = http.request(url, { method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("v2_request_timeout")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function firstCookie(setCookie) {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return clean(String(value || "").split(";")[0]);
}

// One owner browser session. `call` signs in again once on a 401 (an expired
// session) and repeats the same request; every mutation it repeats carries its
// own idempotency key.
export function createV2OwnerSession(config, login, { request = nodeHttpRequest } = {}) {
  const host = new URL(config.origin).host;
  let cookie = "";
  let csrf = "";
  let ended = false;

  async function raw(method, path, body) {
    const headers = { origin: config.origin, host, accept: "application/json" };
    let data;
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
      headers["content-length"] = String(data.length);
    }
    if (cookie) {
      headers.cookie = cookie;
      if (method !== "GET") headers["x-orkestr-csrf"] = csrf;
    }
    const response = await request({ method, url: `${config.apiBase}${path}`, headers, body: data });
    let json = null;
    try {
      json = response.text ? JSON.parse(response.text) : null;
    } catch {}
    return { status: response.status, json, headers: response.headers || {} };
  }

  async function signIn() {
    if (ended) throw v2AttachError("v2_session_closed");
    cookie = "";
    csrf = "";
    const response = await raw("POST", "/api/v2/browser/session", { username: login.username, password: login.password });
    if (response.status !== 200) {
      throw v2AttachError("v2_login_failed", `V2 owner sign-in answered HTTP ${response.status}${response.json?.code ? ` (${response.json.code})` : ""}`);
    }
    cookie = firstCookie(response.headers["set-cookie"]);
    csrf = clean(response.json?.csrf_token);
    if (!cookie || !csrf) throw v2AttachError("v2_login_failed", "V2 sign-in returned no session");
  }

  async function call(method, path, body) {
    if (!cookie) await signIn();
    let response = await raw(method, path, body);
    if (response.status === 401) {
      await signIn();
      response = await raw(method, path, body);
    }
    return response;
  }

  // After close nothing signs in again, not even a late 401 retry.
  async function close() {
    ended = true;
    if (!cookie) return;
    try {
      await raw("DELETE", "/api/v2/browser/session");
    } catch {}
    cookie = "";
    csrf = "";
  }

  return { signIn, call, close };
}
