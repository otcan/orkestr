import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);
const cookieName = "orkestr_session";
const challengeTtlMs = 10 * 60 * 1000;
const challengeAuditTtlMs = 24 * 60 * 60 * 1000;
const sessionTtlMs = 90 * 24 * 60 * 60 * 1000;
const commandStatusCache = new Map();

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

async function readSecurityConfig(env = process.env) {
  const config = await readJson(secretPath(env), { enabled: false, sessions: [], challenges: [] });
  return {
    enabled: config.enabled === true,
    sessions: Array.isArray(config.sessions) ? config.sessions : [],
    challenges: Array.isArray(config.challenges) ? config.challenges : [],
  };
}

async function writeSecurityConfig(config, env = process.env) {
  await ensureDataDirs(env);
  const now = Date.now();
  const next = {
    ...config,
    sessions: (config.sessions || []).filter((session) => Date.parse(session.expiresAt || "") > now),
    challenges: (config.challenges || [])
      .map((challenge) => normalizeChallenge(challenge, now))
      .filter((challenge) => keepChallengeInAuditLog(challenge, now)),
    updatedAt: nowIso(),
  };
  await writeSecretJson(secretPath(env), next);
  return next;
}

function keepChallengeInAuditLog(challenge, now = Date.now()) {
  if (challenge.status === "pending") return Date.parse(challenge.expiresAt || "") > now;
  const auditAnchor = Date.parse(challenge.consumedAt || challenge.rejectedAt || challenge.approvedAt || challenge.expiresAt || "");
  return Number.isFinite(auditAnchor) && auditAnchor + challengeAuditTtlMs > now;
}

function normalizeChallenge(challenge = {}, now = Date.now()) {
  const expiresAtMs = Date.parse(challenge.expiresAt || "");
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= now;
  const status = challenge.status || (challenge.consumedAt ? "consumed" : challenge.rejectedAt ? "rejected" : challenge.approvedAt ? "approved" : "pending");
  return {
    ...challenge,
    status: status === "pending" && expired ? "expired" : status,
  };
}

function publicChallenge(challenge = {}, now = Date.now()) {
  const normalized = normalizeChallenge(challenge, now);
  return {
    id: normalized.id,
    status: normalized.status,
    createdAt: normalized.createdAt,
    expiresAt: normalized.expiresAt,
    requestedUserAgent: normalized.requestedUserAgent || "",
    requestedIp: normalized.requestedIp || "",
    approvedAt: normalized.approvedAt || "",
    approvedBy: normalized.approvedBy || "",
    rejectedAt: normalized.rejectedAt || "",
    rejectedBy: normalized.rejectedBy || "",
    consumedAt: normalized.consumedAt || "",
  };
}

function publicSession(session = {}) {
  return {
    id: session.id || "",
    userAgent: session.userAgent || "",
    createdAt: session.createdAt || "",
    expiresAt: session.expiresAt || "",
  };
}

function challengeError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function activePendingChallenges(config, now = Date.now()) {
  return (config.challenges || [])
    .map((challenge) => normalizeChallenge(challenge, now))
    .filter((challenge) => challenge.status === "pending" && Date.parse(challenge.expiresAt || "") > now);
}

function commandStatusCacheTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_SECURITY_COMMAND_CACHE_TTL_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 30_000;
}

async function commandStatus(command, args = ["--version"], env = process.env) {
  const cacheKey = JSON.stringify([command, args, env.PATH || ""]);
  const ttlMs = commandStatusCacheTtlMs(env);
  const cached = ttlMs > 0 ? commandStatusCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env: { ...process.env, ...env }, timeout: 2500 });
    const status = {
      installed: true,
      version: String(stdout || stderr || "").split("\n")[0].trim(),
    };
    if (ttlMs > 0) commandStatusCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, status });
    return status;
  } catch (error) {
    const status = {
      installed: false,
      version: "",
      error: error?.code === "ENOENT" ? "not_installed" : error?.message || String(error),
    };
    if (ttlMs > 0) commandStatusCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, status });
    return status;
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
  const caddy = await commandStatus("caddy", ["version"], env);
  const tailscale = await commandStatus("tailscale", ["status", "--json"], env);
  const httpsUrl = String(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "").trim();
  const caddyConfigured = String(env.ORKESTR_CADDY_ENABLED || "").trim() === "1";
  const proxyLocalBindSetting = String(env.ORKESTR_REVERSE_PROXY_LOCAL_BIND || "").trim();
  const proxyLocalBind = proxyLocalBindSetting === "1";
  const authRequired = String(env.ORKESTR_AUTH_REQUIRED || "").trim() === "1";
  const authEnabled = Boolean(authRequired || config.enabled || (config.sessions || []).length);
  const sessionCount = (config.sessions || []).filter((session) => Date.parse(session.expiresAt || "") > Date.now()).length;
  const pendingChallenges = activePendingChallenges(config);
  const challengeActive = pendingChallenges.length > 0;
  const bindLocal = isLocalBind(host);
  const externallyLocal = bindLocal || proxyLocalBind;
  const httpsConfigured = httpsUrl.startsWith("https://") || httpsUrl.endsWith(".ts.net");
  const tailscaleConfigured = (tailscale.installed && !tailscale.error) || httpsUrl.endsWith(".ts.net");
  const remoteReady = externallyLocal || (httpsConfigured && authEnabled && sessionCount > 0);

  return {
    generatedAt: nowIso(),
    bindHost: host,
    bindLocal,
    proxyLocalBind,
    externallyLocal,
    authEnabled,
    authRequired,
    paired: sessionCount > 0,
    sessionCount,
    challengeActive,
    pendingChallengeCount: pendingChallenges.length,
    https: {
      configured: httpsConfigured,
      url: httpsUrl,
    },
    caddy: {
      installed: caddy.installed || caddyConfigured,
      configured: caddyConfigured,
      version: caddy.version || (caddyConfigured ? "host-managed" : ""),
      error: caddy.installed || caddyConfigured ? "" : caddy.error || "",
    },
    tailscale: {
      installed: tailscale.installed,
      configured: tailscaleConfigured,
      version: tailscale.version || (httpsUrl.endsWith(".ts.net") ? "host-managed" : ""),
      error: tailscale.installed || tailscaleConfigured ? "" : tailscale.error || "",
    },
    remoteReady,
    warnings: [
      ...(!externallyLocal ? ["Orkestr is not bound to localhost. Put it behind TLS and browser pairing before remote use."] : []),
      ...(!authEnabled && !externallyLocal ? ["Browser pairing is not enabled for a non-local bind."] : []),
      ...(!httpsConfigured && !externallyLocal ? ["HTTPS is not configured for remote access."] : []),
    ],
  };
}

export async function createPairingChallenge({ request, env = process.env } = {}) {
  const config = await readSecurityConfig(env);
  const challenge = {
    id: randomToken(18),
    status: "pending",
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + challengeTtlMs).toISOString(),
    requestedUserAgent: String(request?.headers?.["user-agent"] || "").slice(0, 240),
    requestedIp: requestIp(request).slice(0, 80),
  };
  await writeSecurityConfig({
    ...config,
    challenges: [...(config.challenges || []), challenge],
  }, env);
  await appendEvent({ type: "security_pairing_challenge_created", challengeId: challenge.id }, env).catch(() => {});
  return {
    ok: true,
    challengeId: challenge.id,
    challenge: publicChallenge(challenge),
    expiresAt: challenge.expiresAt,
  };
}

export async function listPairingChallenges({ env = process.env, includeExpired = false } = {}) {
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const challenges = (config.challenges || [])
    .map((challenge) => normalizeChallenge(challenge, now))
    .filter((challenge) => includeExpired || keepChallengeInAuditLog(challenge, now))
    .map((challenge) => publicChallenge(challenge, now))
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  return { challenges };
}

export async function getPairingChallenge(challengeId, { env = process.env } = {}) {
  const id = String(challengeId || "").trim();
  const config = await readSecurityConfig(env);
  const challenge = (config.challenges || []).find((item) => item.id === id);
  if (!challenge) throw challengeError("pairing_challenge_not_found", 404);
  return publicChallenge(challenge);
}

export async function listSecuritySessions({ env = process.env } = {}) {
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const sessions = (config.sessions || [])
    .filter((session) => Date.parse(session.expiresAt || "") > now)
    .map(publicSession)
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  return { sessions };
}

export async function revokeSecuritySession(sessionId, { env = process.env, revokedBy = "cli" } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) throw challengeError("security_session_id_required", 400);
  const config = await readSecurityConfig(env);
  const before = config.sessions || [];
  const sessions = before.filter((session) => session.id !== id);
  if (sessions.length === before.length) throw challengeError("security_session_not_found", 404);
  await writeSecurityConfig({ ...config, sessions }, env);
  await appendEvent({ type: "security_session_revoked", sessionId: id, revokedBy }, env).catch(() => {});
  return { ok: true, revoked: [id] };
}

export async function revokeAllSecuritySessions({ env = process.env, revokedBy = "cli" } = {}) {
  const config = await readSecurityConfig(env);
  const revoked = (config.sessions || []).map((session) => session.id).filter(Boolean);
  await writeSecurityConfig({ ...config, sessions: [] }, env);
  await appendEvent({ type: "security_sessions_revoked", count: revoked.length, revokedBy }, env).catch(() => {});
  return { ok: true, revoked };
}

export async function approvePairingChallenge(challengeId, { env = process.env, approvedBy = "cli" } = {}) {
  const id = String(challengeId || "").trim();
  if (!id) throw challengeError("pairing_challenge_id_required", 400);
  const config = await readSecurityConfig(env);
  const now = Date.now();
  let approved = null;
  const challenges = (config.challenges || []).map((item) => {
    const challenge = normalizeChallenge(item, now);
    if (challenge.id !== id) return challenge;
    if (challenge.status !== "pending") throw challengeError(`pairing_challenge_${challenge.status}`, 409);
    approved = {
      ...challenge,
      status: "approved",
      approvedAt: nowIso(),
      approvedBy: String(approvedBy || "cli").slice(0, 80),
    };
    return approved;
  });
  if (!approved) throw challengeError("pairing_challenge_not_found", 404);
  await writeSecurityConfig({ ...config, enabled: true, challenges }, env);
  await appendEvent({ type: "security_pairing_challenge_approved", challengeId: id, approvedBy }, env).catch(() => {});
  return { ok: true, challenge: publicChallenge(approved) };
}

export async function rejectPairingChallenge(challengeId, { env = process.env, rejectedBy = "browser" } = {}) {
  const id = String(challengeId || "").trim();
  if (!id) throw challengeError("pairing_challenge_id_required", 400);
  const config = await readSecurityConfig(env);
  const now = Date.now();
  let rejected = null;
  const challenges = (config.challenges || []).map((item) => {
    const challenge = normalizeChallenge(item, now);
    if (challenge.id !== id) return challenge;
    if (challenge.status !== "pending") throw challengeError(`pairing_challenge_${challenge.status}`, 409);
    rejected = {
      ...challenge,
      status: "rejected",
      rejectedAt: nowIso(),
      rejectedBy: String(rejectedBy || "browser").slice(0, 80),
    };
    return rejected;
  });
  if (!rejected) throw challengeError("pairing_challenge_not_found", 404);
  await writeSecurityConfig({ ...config, challenges }, env);
  await appendEvent({ type: "security_pairing_challenge_rejected", challengeId: id, rejectedBy }, env).catch(() => {});
  return { ok: true, challenge: publicChallenge(rejected) };
}

export async function pairBrowser({ challengeId, userAgent = "", env = process.env } = {}) {
  const id = String(challengeId || "").trim();
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const challenges = (config.challenges || []).map((challenge) => normalizeChallenge(challenge, now));
  const challenge = challenges.find((item) => item.id === id);
  if (!challenge) throw challengeError("invalid_or_expired_pairing_challenge", 401);
  if (challenge.status === "pending") throw challengeError("pairing_challenge_not_approved", 409);
  if (challenge.status !== "approved") throw challengeError(`pairing_challenge_${challenge.status}`, 401);
  if (Date.parse(challenge.expiresAt || "") <= now) throw challengeError("pairing_challenge_expired", 401);
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
    challenges: challenges.map((item) => item.id === challenge.id ? {
      ...item,
      status: "consumed",
      consumedAt: nowIso(),
    } : item),
  }, env);
  await appendEvent({ type: "security_browser_paired", sessionId: session.id, challengeId: challenge.id }, env).catch(() => {});
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
  const url = String(request?.url || "").split("?")[0];
  if (url.startsWith("/desktop/")) return false;
  if (!url.startsWith("/api/") && !url.startsWith("/oauth/")) return true;
  if (url.startsWith("/oauth/")) return true;
  if (method === "GET" && ["/api/health", "/api/ready", "/api/version", "/api/setup/status"].some((path) => url.startsWith(path))) return true;
  if (method === "POST" && (url === "/api/setup/security/challenge" || url === "/api/setup/security/challenges")) return true;
  if (method === "GET" && /^\/api\/setup\/security\/challenges\/[^/]+$/.test(url)) return true;
  if (method === "POST" && url === "/api/setup/security/pair") return true;
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
