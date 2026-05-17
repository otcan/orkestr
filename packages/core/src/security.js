import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);
const cookieName = "orkestr_session";
const challengeTtlMs = 10 * 60 * 1000;
const sessionTtlMs = 90 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function secretPath(env = process.env) {
  return `${dataPaths(env).secrets}/security.json`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function numericCode() {
  return String(crypto.randomInt(100000, 999999));
}

async function readSecurityConfig(env = process.env) {
  return readJson(secretPath(env), { enabled: false, sessions: [], challenges: [] });
}

async function writeSecurityConfig(config, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  const next = {
    ...config,
    sessions: (config.sessions || []).filter((session) => Date.parse(session.expiresAt || "") > now),
    challenges: (config.challenges || []).filter((challenge) => Date.parse(challenge.expiresAt || "") > now),
    updatedAt: nowIso(),
  };
  await writeSecretJson(secretPath(env), next);
  return next;
}

async function commandStatus(command, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 2500 });
    return {
      installed: true,
      version: String(stdout || stderr || "").split("\n")[0].trim(),
    };
  } catch (error) {
    return {
      installed: false,
      version: "",
      error: error?.code === "ENOENT" ? "not_installed" : error?.message || String(error),
    };
  }
}

function bindHost(env = process.env) {
  return String(env.ORKESTR_HOST || "127.0.0.1").trim() || "127.0.0.1";
}

function isLocalBind(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host || "").trim().toLowerCase());
}

function requestIp(request) {
  return String(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

function isLocalRequest(request) {
  const ip = requestIp(request);
  return ["127.0.0.1", "::1", "localhost", ""].includes(ip);
}

function cookieValue(header, name = cookieName) {
  const raw = String(header || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

export function securityCookieName() {
  return cookieName;
}

export async function securityStatus(env = process.env) {
  const config = await readSecurityConfig(env);
  const host = bindHost(env);
  const caddy = await commandStatus("caddy", ["version"]);
  const tailscale = await commandStatus("tailscale", ["status", "--json"]);
  const httpsUrl = String(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "").trim();
  const authRequired = String(env.ORKESTR_AUTH_REQUIRED || "").trim() === "1";
  const authEnabled = Boolean(authRequired || config.enabled || (config.sessions || []).length);
  const sessionCount = (config.sessions || []).filter((session) => Date.parse(session.expiresAt || "") > Date.now()).length;
  const challengeActive = (config.challenges || []).some((challenge) => Date.parse(challenge.expiresAt || "") > Date.now());
  const bindLocal = isLocalBind(host);
  const httpsConfigured = httpsUrl.startsWith("https://") || httpsUrl.endsWith(".ts.net");
  const remoteReady = bindLocal || (httpsConfigured && authEnabled && sessionCount > 0);

  return {
    generatedAt: nowIso(),
    bindHost: host,
    bindLocal,
    authEnabled,
    authRequired,
    paired: sessionCount > 0,
    sessionCount,
    challengeActive,
    https: {
      configured: httpsConfigured,
      url: httpsUrl,
    },
    caddy: {
      installed: caddy.installed,
      configured: String(env.ORKESTR_CADDY_ENABLED || "").trim() === "1",
      version: caddy.version || "",
      error: caddy.error || "",
    },
    tailscale: {
      installed: tailscale.installed,
      configured: tailscale.installed && !tailscale.error,
      version: tailscale.version || "",
      error: tailscale.error || "",
    },
    remoteReady,
    warnings: [
      ...(!bindLocal ? ["Orkestr is not bound to localhost. Put it behind TLS and browser pairing before remote use."] : []),
      ...(!authEnabled && !bindLocal ? ["Browser pairing is not enabled for a non-local bind."] : []),
      ...(!httpsConfigured && !bindLocal ? ["HTTPS is not configured for remote access."] : []),
    ],
  };
}

export async function createPairingChallenge({ request, env = process.env } = {}) {
  const config = await readSecurityConfig(env);
  const code = numericCode();
  const challenge = {
    id: randomToken(10),
    codeHash: sha256(code),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + challengeTtlMs).toISOString(),
  };
  await writeSecurityConfig({
    ...config,
    challenges: [...(config.challenges || []), challenge],
  }, env);
  await appendEvent({ type: "security_pairing_challenge_created", challengeId: challenge.id }, env).catch(() => {});
  return {
    ok: true,
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
    code: isLocalRequest(request) || String(env.ORKESTR_SECURITY_RETURN_PAIRING_CODE || "") === "1" ? code : "",
  };
}

export async function pairBrowser({ code, userAgent = "", env = process.env } = {}) {
  const value = String(code || "").trim();
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const challenge = (config.challenges || []).find((item) =>
    Date.parse(item.expiresAt || "") > now && item.codeHash === sha256(value),
  );
  if (!challenge) {
    const error = new Error("invalid_or_expired_pairing_code");
    error.statusCode = 401;
    throw error;
  }
  const token = randomToken(32);
  const session = {
    id: randomToken(10),
    tokenHash: sha256(token),
    userAgent: String(userAgent || "").slice(0, 240),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
  };
  await writeSecurityConfig({
    ...config,
    enabled: true,
    sessions: [...(config.sessions || []), session],
    challenges: (config.challenges || []).filter((item) => item.id !== challenge.id),
  }, env);
  await appendEvent({ type: "security_browser_paired", sessionId: session.id }, env).catch(() => {});
  return {
    ok: true,
    token,
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
    },
  };
}

export async function verifySecurityToken(token, env = process.env) {
  const value = String(token || "").trim();
  if (!value) return false;
  const config = await readSecurityConfig(env);
  const now = Date.now();
  return (config.sessions || []).some((session) =>
    Date.parse(session.expiresAt || "") > now && session.tokenHash === sha256(value),
  );
}

function isAllowedBeforePairing(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const url = String(request?.url || "");
  if (!url.startsWith("/api/") && !url.startsWith("/oauth/")) return true;
  if (url.startsWith("/oauth/")) return true;
  if (method === "GET" && ["/api/health", "/api/ready", "/api/version", "/api/setup/status"].some((path) => url.startsWith(path))) return true;
  if (url.startsWith("/api/setup/security/challenge")) return true;
  if (url.startsWith("/api/setup/security/pair")) return true;
  return false;
}

export async function authorizeHttpRequest(request, env = process.env) {
  const status = await securityStatus(env);
  if (!status.authEnabled) return { ok: true, status };
  if (isAllowedBeforePairing(request)) return { ok: true, status };
  const token = cookieValue(request?.headers?.cookie || "");
  if (await verifySecurityToken(token, env)) return { ok: true, status };
  return {
    ok: false,
    status,
    statusCode: 401,
    error: "browser_pairing_required",
  };
}

export function sessionCookieHeader(token, env = process.env) {
  const secure = String(env.ORKESTR_COOKIE_SECURE || "").trim() === "1" || Boolean(String(env.ORKESTR_PUBLIC_HTTPS_URL || "").startsWith("https://"));
  return [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
