import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { authorizeDesktopShareHttpRequest } from "./desktop-shares.js";
import { decryptBrokerClientPayload } from "./broker-instance-registry.js";
import { adminPrincipal, principalFromSecuritySession } from "./principal.js";
import { publicUrlConfig } from "./public-url-config.js";
import { defaultAdminUser, getUser, normalizeUserId } from "./users.js";
import { readJobsJdCacheAccessRecords } from "./jobs-jd-cache-mcp.js";
import { readWhatsAppScopedTokenRecords } from "./whatsapp-scoped-tokens.js";

const execFileAsync = promisify(execFile);
const cookieName = "orkestr_session";
const challengeTtlMs = 10 * 60 * 1000;
const challengeAuditTtlMs = 24 * 60 * 60 * 1000;
const sessionTtlMs = 90 * 24 * 60 * 60 * 1000;
const defaultJobsJdCacheSources = ["gmail", "freelance_de", "9am"];
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

function randomApproveCode() {
  return crypto.randomBytes(4).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeInstanceId(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeAppSlug(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeShareId(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function normalizeAllowedActions(value = []) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
}

function remoteAuthSignal(env = process.env, urls = publicUrlConfig(env), host = bindHost(env)) {
  const publicUrlConfigured = Boolean(
    urls.primaryDomain ||
    urls.appHost ||
    urls.authHost ||
    urls.appUrl ||
    urls.authUrl ||
    urls.connectUrl ||
    env.ORKESTR_PUBLIC_APP_URL ||
    env.ORKESTR_PUBLIC_AUTH_URL ||
    env.ORKESTR_PUBLIC_URL ||
    env.ORKESTR_APP_URL ||
    env.ORKESTR_PUBLIC_HTTPS_URL ||
    env.ORKESTR_HTTPS_URL ||
    env.ORKESTR_TAILSCALE_HTTPS_NAME ||
    env.ORKESTR_CONNECT_PUBLIC_URL,
  );
  return publicUrlConfigured || !isLocalBind(host);
}

function effectiveAuthRequired(env = process.env, urls = publicUrlConfig(env), host = bindHost(env)) {
  if (String(env.ORKESTR_AUTH_REQUIRED || "").trim() === "1") return true;
  if (envFlag(env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED)) return false;
  return remoteAuthSignal(env, urls, host);
}

function approvalInstructions(env = process.env) {
  return {
    sshCommand: String(env.ORKESTR_SECURITY_APPROVE_SSH_COMMAND || "").trim(),
    approveCommand: String(env.ORKESTR_SECURITY_APPROVE_COMMAND || "").trim(),
    sudoApproveCommand: String(env.ORKESTR_SECURITY_APPROVE_SUDO_COMMAND || "").trim(),
  };
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
    approveCode: normalized.approveCode || "",
    status: normalized.status,
    createdAt: normalized.createdAt,
    expiresAt: normalized.expiresAt,
    instanceId: normalized.instanceId || "",
    requestedUserAgent: normalized.requestedUserAgent || "",
    requestedIp: normalized.requestedIp || "",
    userId: normalized.userId || "",
    role: normalized.role || "",
    shareId: normalized.shareId || "",
    appSlug: normalized.appSlug || "",
    requestedPath: normalized.requestedPath || "",
    allowedActions: Array.isArray(normalized.allowedActions) ? normalized.allowedActions : [],
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
    challengeId: session.challengeId || "",
    instanceId: session.instanceId || "",
    userId: session.userId || "",
    role: session.role || "",
    userAgent: session.userAgent || "",
    createdAt: session.createdAt || "",
    lastAccessedAt: session.lastAccessedAt || session.createdAt || "",
    lastIp: session.lastIp || "",
    shareId: session.shareId || "",
    appSlug: session.appSlug || "",
    allowedActions: Array.isArray(session.allowedActions) ? session.allowedActions : [],
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

function bearerToken(header) {
  const raw = String(header || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function splitSecretList(value) {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitScopeList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/g);
  return values.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function splitStringList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/g);
  return values.map((item) => String(item || "").trim()).filter(Boolean);
}

function timingSafeSecretEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(left)), Buffer.from(sha256(right)));
}

function timingSafeHashEqual(a, b) {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function parseJsonTokens(value, defaults = {}) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((entry, index) => [String(entry?.id || entry?.name || index), entry])
    : Object.entries(parsed || {});
  return entries.map(([key, entry]) => {
    const record = typeof entry === "string" ? { token: entry } : { ...(entry || {}) };
    const token = String(record.token || record.value || record.secret || "").trim();
    const tokenHash = String(record.tokenHash || record.hash || "").trim().toLowerCase();
    if (!token && !tokenHash) return null;
    return {
      ...defaults,
      id: String(record.id || record.tokenId || key || "").trim(),
      token,
      tokenHash,
      scopes: splitScopeList(record.scopes || record.scope || record.capabilities || defaults.scopes || []),
      principalKind: String(record.principalKind || record.kind || defaults.principalKind || "external_instance").trim(),
      principalId: String(record.principalId || record.userId || record.ownerUserId || record.instanceId || defaults.principalId || "").trim(),
      ownerUserId: String(record.ownerUserId || record.userId || defaults.ownerUserId || "").trim(),
      instanceId: String(record.instanceId || record.instance || defaults.instanceId || "").trim(),
      accountId: String(record.accountId || defaults.accountId || "").trim(),
      bindingId: String(record.bindingId || defaults.bindingId || "").trim(),
      chatId: String(record.chatId || defaults.chatId || "").trim(),
      allowedChatIds: splitStringList(record.allowedChatIds || record.allowedChats || record.chatIds || defaults.allowedChatIds || []),
      allowedPhoneNumbers: splitStringList(record.allowedPhoneNumbers || record.whatsappNumbers || record.phoneNumbers || defaults.allowedPhoneNumbers || []),
      allowedRecipients: splitStringList(record.allowedRecipients || record.allowedRecipientIds || record.recipientIds || defaults.allowedRecipients || []),
      expiresAt: String(record.expiresAt || defaults.expiresAt || "").trim(),
      disabled: record.disabled === true || record.enabled === false,
    };
  }).filter(Boolean);
}

async function scopedWhatsAppTokens(env = process.env, routeKind = "") {
  const common = [
    env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON,
    env.WHATSAPP_SCOPED_TOKENS_JSON,
  ].flatMap((value) => parseJsonTokens(value));
  const stored = await readWhatsAppScopedTokenRecords(env).catch(() => []);
  if (routeKind === "whatsapp_inbound") {
    return [
      ...common,
      ...stored,
      ...parseJsonTokens(env.ORKESTR_WHATSAPP_INBOUND_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:inbound"] }),
      ...parseJsonTokens(env.WHATSAPP_INBOUND_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:inbound"] }),
      ...parseJsonTokens(env.ORKESTR_WHATSAPP_INBOUND_TOKEN_JSON, { scopes: ["whatsapp:inbound"] }),
    ];
  }
  if (routeKind === "whatsapp_bridge") {
    return [
      ...common,
      ...stored,
      ...parseJsonTokens(env.ORKESTR_WHATSAPP_BRIDGE_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:bridge"] }),
      ...parseJsonTokens(env.WHATSAPP_BRIDGE_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:bridge"] }),
      ...parseJsonTokens(env.ORKESTR_WHATSAPP_BRIDGE_TOKEN_JSON, { scopes: ["whatsapp:bridge"] }),
    ];
  }
  return [...common, ...stored];
}

function scopedTokenMatches(record, token) {
  if (!record || !token) return false;
  if (record.token && timingSafeSecretEqual(token, record.token)) return true;
  if (record.tokenHash) return timingSafeHashEqual(sha256(token), record.tokenHash);
  return false;
}

function scopedTokenExpired(record) {
  if (!record?.expiresAt) return false;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function whatsappBridgeRequiredScopes(method, url) {
  const parts = String(url || "").split("/").filter(Boolean).map((part) => part.toLowerCase());
  const action = parts.slice(3);
  const leaf = action.at(-1) || "";
  if (method === "POST" && ["send-text", "send-media"].includes(leaf)) return ["whatsapp:bridge:send", "whatsapp:send"];
  if (method === "POST" && action[0] === "typing") return ["whatsapp:bridge:send", "whatsapp:send"];
  if (method === "GET") return ["whatsapp:bridge:read", "whatsapp:read"];
  return ["whatsapp:bridge:manage", "whatsapp:manage"];
}

function tokenAllowsWhatsAppScope(record, route) {
  const scopes = splitScopeList(record?.scopes || []);
  if (!scopes.length) return false;
  if (scopes.includes("*") || scopes.includes("whatsapp:*")) return true;
  if (route.kind === "whatsapp_inbound") {
    return scopes.some((scope) => ["whatsapp:inbound", "whatsapp:receive", "whatsapp:bridge:inbound", "whatsapp:bridge:receive"].includes(scope));
  }
  if (route.kind === "whatsapp_bridge" && scopes.includes("whatsapp:bridge")) return true;
  return (route.requiredScopes || []).some((scope) => scopes.includes(scope));
}

function publicMachineTokenContext(record, route) {
  return {
    tokenId: record.id || null,
    routeKind: route.kind,
    scopes: splitScopeList(record.scopes || []),
    principalKind: record.principalKind || null,
    principalId: record.principalId || null,
    ownerUserId: record.ownerUserId || null,
    instanceId: record.instanceId || null,
    accountId: record.accountId || null,
    bindingId: record.bindingId || null,
    chatId: record.chatId || null,
    allowedChatIds: Array.isArray(record.allowedChatIds) ? record.allowedChatIds : [],
    allowedPhoneNumbers: Array.isArray(record.allowedPhoneNumbers) ? record.allowedPhoneNumbers : [],
    allowedRecipients: Array.isArray(record.allowedRecipients) ? record.allowedRecipients : [],
  };
}

function configuredBridgeTokenContext(env = process.env, route = {}) {
  if (route.kind !== "whatsapp_bridge") return null;
  const allowedChatIds = splitStringList(env.ORKESTR_WHATSAPP_BRIDGE_ALLOWED_CHAT_IDS || env.WHATSAPP_BRIDGE_ALLOWED_CHAT_IDS);
  const allowedPhoneNumbers = splitStringList(env.ORKESTR_WHATSAPP_BRIDGE_ALLOWED_PHONE_NUMBERS || env.WHATSAPP_BRIDGE_ALLOWED_PHONE_NUMBERS);
  const allowedRecipients = splitStringList(env.ORKESTR_WHATSAPP_BRIDGE_ALLOWED_RECIPIENTS || env.WHATSAPP_BRIDGE_ALLOWED_RECIPIENTS);
  const accountId = String(env.ORKESTR_WHATSAPP_BRIDGE_ACCOUNT_ID || env.WHATSAPP_BRIDGE_ACCOUNT_ID || "").trim();
  if (!allowedChatIds.length && !allowedPhoneNumbers.length && !allowedRecipients.length && !accountId) return null;
  return {
    tokenId: "configured-bridge-token",
    routeKind: route.kind,
    scopes: route.requiredScopes || ["whatsapp:bridge"],
    principalKind: "external_instance",
    principalId: String(env.ORKESTR_WHATSAPP_BRIDGE_PRINCIPAL_ID || env.WHATSAPP_BRIDGE_PRINCIPAL_ID || "configured-bridge-token").trim(),
    ownerUserId: null,
    instanceId: String(env.ORKESTR_WHATSAPP_BRIDGE_INSTANCE_ID || env.WHATSAPP_BRIDGE_INSTANCE_ID || "").trim() || null,
    accountId: accountId || null,
    bindingId: null,
    chatId: null,
    allowedChatIds,
    allowedPhoneNumbers,
    allowedRecipients,
  };
}

function configuredInboundTokenContext(env = process.env, route = {}) {
  if (route.kind !== "whatsapp_inbound") return null;
  return {
    tokenId: "configured-inbound-token",
    routeKind: route.kind,
    scopes: route.requiredScopes || ["whatsapp:inbound"],
    principalKind: "external_instance",
    principalId: String(env.ORKESTR_WHATSAPP_INBOUND_PRINCIPAL_ID || env.WHATSAPP_INBOUND_PRINCIPAL_ID || "configured-inbound-token").trim(),
    ownerUserId: null,
    instanceId: String(env.ORKESTR_WHATSAPP_INBOUND_INSTANCE_ID || env.WHATSAPP_INBOUND_INSTANCE_ID || "").trim() || null,
    accountId: String(env.ORKESTR_WHATSAPP_INBOUND_ACCOUNT_ID || env.WHATSAPP_INBOUND_ACCOUNT_ID || "").trim() || null,
    bindingId: null,
    chatId: null,
    allowedChatIds: splitStringList(env.ORKESTR_WHATSAPP_INBOUND_ALLOWED_CHAT_IDS || env.WHATSAPP_INBOUND_ALLOWED_CHAT_IDS),
    allowedPhoneNumbers: splitStringList(env.ORKESTR_WHATSAPP_INBOUND_ALLOWED_PHONE_NUMBERS || env.WHATSAPP_INBOUND_ALLOWED_PHONE_NUMBERS),
    allowedRecipients: splitStringList(env.ORKESTR_WHATSAPP_INBOUND_ALLOWED_RECIPIENTS || env.WHATSAPP_INBOUND_ALLOWED_RECIPIENTS),
  };
}

async function scopedJobsJdCacheTokens(env = process.env) {
  return [
    ...parseJsonTokens(env.ORKESTR_JOBS_JD_CACHE_SCOPED_TOKENS_JSON, { scopes: ["jd:read", "jd:search"] }),
    ...parseJsonTokens(env.JOBS_JD_CACHE_SCOPED_TOKENS_JSON, { scopes: ["jd:read", "jd:search"] }),
    ...(await readJobsJdCacheAccessRecords(env).catch(() => [])).map((grant) => ({
      id: grant.tokenId || grant.id,
      tokenHash: grant.tokenHash,
      scopes: grant.scopes,
      principalKind: "tenant_vm",
      principalId: grant.tenantVmId || grant.id,
      ownerUserId: grant.ownerUserId || "",
      instanceId: grant.tenantVmId || grant.id,
      disabled: grant.enabled === false,
      grant,
    })),
  ];
}

function whatsappInboundTokens(env = process.env) {
  return [
    ...splitSecretList(env.ORKESTR_WHATSAPP_INBOUND_TOKEN),
    ...splitSecretList(env.WHATSAPP_INBOUND_TOKEN),
    ...splitSecretList(env.ORKESTR_WHATSAPP_INBOUND_TOKENS),
    ...splitSecretList(env.WHATSAPP_INBOUND_TOKENS),
  ];
}

function jobsJdCacheTokens(env = process.env) {
  return [
    ...splitSecretList(env.ORKESTR_JOBS_JD_CACHE_TOKEN),
    ...splitSecretList(env.JOBS_JD_CACHE_TOKEN),
    ...splitSecretList(env.ORKESTR_JOBS_JD_CACHE_TOKENS),
    ...splitSecretList(env.JOBS_JD_CACHE_TOKENS),
  ];
}

function whatsappBridgeTokens(env = process.env) {
  return [
    ...splitSecretList(env.ORKESTR_WHATSAPP_BRIDGE_TOKEN),
    ...splitSecretList(env.WHATSAPP_BRIDGE_TOKEN),
    ...splitSecretList(env.ORKESTR_WHATSAPP_BRIDGE_TOKENS),
    ...splitSecretList(env.WHATSAPP_BRIDGE_TOKENS),
  ];
}

function cliAuthPath(env = process.env) {
  return `${dataPaths(env).secrets}/cli-auth.json`;
}

async function cliMachineTokens(env = process.env) {
  const values = [
    ...splitSecretList(env.ORKESTR_CLI_AUTH_TOKEN),
    ...splitSecretList(env.ORKESTR_API_TOKEN),
  ];
  const stored = await readJson(cliAuthPath(env), {}).catch(() => ({}));
  const expiresAt = Date.parse(String(stored?.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    values.push(...splitSecretList(stored?.token));
  }
  return values;
}

function isWhatsAppMachineRoute(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  if (method === "POST" && (url === "/api/connectors/whatsapp/inbound" || url === "/api/connectors/whatsapp/inbound-media")) {
    return { kind: "whatsapp_inbound", tokens: whatsappInboundTokens, requiredScopes: ["whatsapp:inbound"] };
  }
  if (url.startsWith("/api/connectors/whatsapp/bridge/")) {
    return { kind: "whatsapp_bridge", tokens: whatsappBridgeTokens, requiredScopes: whatsappBridgeRequiredScopes(method, url) };
  }
  return null;
}

function isJobsJdCacheMachineRoute(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  if (method === "POST" && url === "/api/jobs/jd-cache/mcp") {
    return { kind: "jobs_jd_cache", tokens: jobsJdCacheTokens, requiredScopes: ["jd:read", "jd:search"] };
  }
  if (method === "GET" && url === "/api/jobs/jd-cache/mcp/health") {
    return { kind: "jobs_jd_cache", tokens: jobsJdCacheTokens, requiredScopes: ["jd:read"] };
  }
  return null;
}

function whatsappMachineAuthFailure(route, reason, statusCode) {
  const error = reason === "scope_denied" ? "wa_token_scope_denied" : `${route.kind}_token_${reason}`;
  const safeMessage = reason === "unconfigured"
    ? "The target Orkestr instance has no WhatsApp inbound token configured."
    : reason === "required"
      ? "The broker request did not include a WhatsApp inbound token."
      : reason === "scope_denied"
        ? "The broker WhatsApp token does not allow the requested operation."
        : "The target Orkestr instance rejected the broker WhatsApp token.";
  return {
    ok: false,
    statusCode,
    error,
    machineAuth: route.kind,
    routingFailure: {
      code: error,
      capability: "whatsapp",
      provider: "whatsapp",
      userFacingCategory: "connector",
      retryable: reason === "unconfigured",
      safeMessage,
      reason: error,
    },
  };
}

function jobsJdCacheMachineAuthFailure(route, reason, statusCode) {
  const error = reason === "scope_denied" ? "jobs_jd_cache_token_scope_denied" : `jobs_jd_cache_token_${reason}`;
  const safeMessage = reason === "unconfigured"
    ? "The parent Jobs JD cache has no slice access token configured."
    : reason === "required"
      ? "The request did not include a Jobs JD cache token."
      : reason === "scope_denied"
        ? "The Jobs JD cache token does not allow the requested operation."
        : "The parent Jobs JD cache rejected the token.";
  return {
    ok: false,
    statusCode,
    error,
    machineAuth: route.kind,
    routingFailure: {
      code: error,
      capability: "jobs_jd_cache",
      provider: "jobs_xrm",
      userFacingCategory: "connector",
      retryable: reason === "unconfigured",
      safeMessage,
      reason: error,
    },
  };
}

async function authorizeCliMachineRequest(request, env = process.env) {
  const token = bearerToken(request?.headers?.authorization || request?.headers?.Authorization || "");
  if (!token) return null;
  const remoteAllowed = envFlag(env.ORKESTR_CLI_AUTH_ALLOW_REMOTE);
  if (!remoteAllowed && !isLocalRequest(request)) return null;
  const tokens = await cliMachineTokens(env);
  const matched = tokens.some((candidate) => timingSafeSecretEqual(token, candidate));
  if (!matched) return null;
  return {
    ok: true,
    principal: adminPrincipal(defaultAdminUser(env)),
    machineAuth: "cli",
  };
}

async function authorizeWhatsAppMachineRequest(request, env = process.env) {
  const route = isWhatsAppMachineRoute(request);
  if (!route) return null;
  const token = bearerToken(request?.headers?.authorization || request?.headers?.Authorization || "");
  const tokens = route.tokens(env);
  const scopedTokens = await scopedWhatsAppTokens(env, route.kind);
  if (!tokens.length && !scopedTokens.length) return whatsappMachineAuthFailure(route, "unconfigured", 503);
  if (!token) return whatsappMachineAuthFailure(route, "required", 401);
  const scopedMatch = scopedTokens.find((candidate) => scopedTokenMatches(candidate, token));
  if (scopedMatch) {
    if (scopedMatch.disabled || scopedTokenExpired(scopedMatch)) return whatsappMachineAuthFailure(route, "invalid", 401);
    if (!tokenAllowsWhatsAppScope(scopedMatch, route)) return whatsappMachineAuthFailure(route, "scope_denied", 403);
    const principal = adminPrincipal(defaultAdminUser(env));
    principal.source = "whatsapp-machine-token";
    principal.machine = publicMachineTokenContext(scopedMatch, route);
    return {
      ok: true,
      principal,
      machineAuth: route.kind,
      machineAuthContext: publicMachineTokenContext(scopedMatch, route),
    };
  }
  const matched = tokens.some((candidate) => timingSafeSecretEqual(token, candidate));
  if (!matched) return whatsappMachineAuthFailure(route, "invalid", 401);
  const configuredContext = configuredBridgeTokenContext(env, route) || configuredInboundTokenContext(env, route);
  return {
    ok: true,
    principal: adminPrincipal(defaultAdminUser(env)),
    machineAuth: route.kind,
    ...(configuredContext ? { machineAuthContext: configuredContext } : {}),
  };
}

function tokenAllowsJobsJdCacheScope(record, route) {
  const scopes = splitScopeList(record?.scopes || []);
  if (!scopes.length) return false;
  if (scopes.includes("*") || scopes.includes("jd:*")) return true;
  return (route.requiredScopes || []).some((scope) => scopes.includes(scope));
}

function publicJobsJdCacheTokenContext(record, route) {
  const base = publicMachineTokenContext(record, route);
  return {
    ...base,
    grant: record.grant ? {
      id: record.grant.id || "",
      tenantVmId: record.grant.tenantVmId || "",
      displayName: record.grant.displayName || "",
      ownerUserId: record.grant.ownerUserId || "",
      tokenId: record.grant.tokenId || record.id || "",
      scopes: splitScopeList(record.grant.scopes || record.scopes || []),
      sources: Array.isArray(record.grant.sources) ? record.grant.sources : [],
      maxResults: Number(record.grant.maxResults || 0) || undefined,
      enabled: record.grant.enabled !== false,
    } : null,
  };
}

async function authorizeJobsJdCacheMachineRequest(request, env = process.env) {
  const route = isJobsJdCacheMachineRoute(request);
  if (!route) return null;
  const token = bearerToken(request?.headers?.authorization || request?.headers?.Authorization || "");
  const tokens = route.tokens(env);
  const scopedTokens = await scopedJobsJdCacheTokens(env);
  if (!tokens.length && !scopedTokens.length) return jobsJdCacheMachineAuthFailure(route, "unconfigured", 503);
  if (!token) return jobsJdCacheMachineAuthFailure(route, "required", 401);
  const scopedMatch = scopedTokens.find((candidate) => scopedTokenMatches(candidate, token));
  if (scopedMatch) {
    if (scopedMatch.disabled || scopedTokenExpired(scopedMatch)) return jobsJdCacheMachineAuthFailure(route, "invalid", 401);
    if (!tokenAllowsJobsJdCacheScope(scopedMatch, route)) return jobsJdCacheMachineAuthFailure(route, "scope_denied", 403);
    const principal = adminPrincipal(defaultAdminUser(env));
    principal.source = "jobs-jd-cache-machine-token";
    principal.machine = publicJobsJdCacheTokenContext(scopedMatch, route);
    return {
      ok: true,
      principal,
      machineAuth: route.kind,
      machineAuthContext: publicJobsJdCacheTokenContext(scopedMatch, route),
    };
  }
  const matched = tokens.some((candidate) => timingSafeSecretEqual(token, candidate));
  if (!matched) return jobsJdCacheMachineAuthFailure(route, "invalid", 401);
  return {
    ok: true,
    principal: adminPrincipal(defaultAdminUser(env)),
    machineAuth: route.kind,
    machineAuthContext: {
      tokenId: "configured-jobs-jd-cache-token",
      routeKind: route.kind,
      scopes: route.requiredScopes || ["jd:read", "jd:search"],
      principalKind: "external_instance",
      principalId: String(env.ORKESTR_JOBS_JD_CACHE_PRINCIPAL_ID || env.JOBS_JD_CACHE_PRINCIPAL_ID || "configured-jobs-jd-cache-token").trim(),
      ownerUserId: null,
      instanceId: String(env.ORKESTR_JOBS_JD_CACHE_INSTANCE_ID || env.JOBS_JD_CACHE_INSTANCE_ID || "").trim() || null,
      grant: {
        id: "configured-jobs-jd-cache-token",
        tenantVmId: String(env.ORKESTR_JOBS_JD_CACHE_INSTANCE_ID || env.JOBS_JD_CACHE_INSTANCE_ID || "").trim(),
        tokenId: "configured-jobs-jd-cache-token",
        scopes: route.requiredScopes || ["jd:read", "jd:search"],
        sources: splitStringList(env.ORKESTR_JOBS_JD_CACHE_ALLOWED_SOURCES || env.JOBS_JD_CACHE_ALLOWED_SOURCES || defaultJobsJdCacheSources.join(",")),
        maxResults: Number(env.ORKESTR_JOBS_JD_CACHE_MAX_RESULTS || env.JOBS_JD_CACHE_MAX_RESULTS || 100) || 100,
        enabled: true,
      },
    },
  };
}

function brokerProxyHeaderValue(request) {
  const raw = request?.headers?.["x-orkestr-broker-auth"] || request?.headers?.["X-Orkestr-Broker-Auth"] || "";
  return Array.isArray(raw) ? String(raw[0] || "").trim() : String(raw || "").trim();
}

function brokerProxyMachineAuthFailure(reason, statusCode = 401) {
  return {
    ok: false,
    statusCode,
    error: `broker_proxy_auth_${reason}`,
    machineAuth: "broker_proxy",
  };
}

function brokerProxyExpectedInstanceId(env = process.env) {
  return String(env.ORKESTR_BROKER_INSTANCE_ID || env.ORKESTR_INSTANCE_ID || "").trim();
}

function normalizeRequestPathForBrokerAuth(value = "") {
  try {
    const parsed = new URL(String(value || "/"), "http://orkestr.local");
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return String(value || "/").split("#")[0] || "/";
  }
}

function decodeBrokerProxyHeader(value = "") {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("broker_proxy_auth_malformed"), { statusCode: 401 });
  }
}

async function authorizeBrokerProxyMachineRequest(request, env = process.env) {
  const header = brokerProxyHeaderValue(request);
  if (!header) return null;
  if (!envFlag(env.ORKESTR_SHARED_AUTHORIZATION) && !envFlag(env.ORKESTR_SHARED_CONTROL_PLANE)) {
    return brokerProxyMachineAuthFailure("disabled", 403);
  }
  let decrypted = null;
  try {
    decrypted = await decryptBrokerClientPayload(decodeBrokerProxyHeader(header), env, { allowAnyChannelId: true });
  } catch (error) {
    const reason = String(error?.message || error || "invalid").replace(/^broker_proxy_auth_/, "");
    return brokerProxyMachineAuthFailure(reason || "invalid", Number(error?.statusCode || 401));
  }
  const payload = decrypted?.payload || {};
  const expectedInstanceId = brokerProxyExpectedInstanceId(env);
  if (!expectedInstanceId) {
    return brokerProxyMachineAuthFailure("instance_mismatch", 403);
  }
  if (String(payload.kind || "") !== "broker_app_proxy") return brokerProxyMachineAuthFailure("kind_mismatch", 401);
  if (String(payload.instanceId || "") !== expectedInstanceId) return brokerProxyMachineAuthFailure("instance_mismatch", 403);
  const now = Date.now();
  const expiresAt = Date.parse(String(payload.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return brokerProxyMachineAuthFailure("expired", 401);
  const issuedAt = Date.parse(String(payload.issuedAt || ""));
  if (Number.isFinite(issuedAt) && issuedAt - now > 60_000) return brokerProxyMachineAuthFailure("not_yet_valid", 401);
  const method = String(request?.method || "GET").toUpperCase();
  if (String(payload.method || "").toUpperCase() !== method) return brokerProxyMachineAuthFailure("method_mismatch", 401);
  const requestPath = normalizeRequestPathForBrokerAuth(request?.originalUrl || request?.url || "/");
  if (normalizeRequestPathForBrokerAuth(payload.path || "/") !== requestPath) return brokerProxyMachineAuthFailure("path_mismatch", 401);
  const principal = adminPrincipal(defaultAdminUser(env));
  principal.source = "broker-proxy-machine-token";
  principal.machine = {
    routeKind: "broker_proxy",
    instanceId: expectedInstanceId,
    userId: String(payload.userId || ""),
    role: String(payload.role || ""),
  };
  return {
    ok: true,
    principal,
    machineAuth: "broker_proxy",
    machineAuthContext: principal.machine,
  };
}

export function securityCookieName() {
  return cookieName;
}

export async function securityStatus(env = process.env) {
  const config = await readSecurityConfig(env);
  const urls = publicUrlConfig(env);
  const host = bindHost(env);
  const caddy = await commandStatus("caddy", ["version"], env);
  const tailscale = await commandStatus("tailscale", ["status", "--json"], env);
  const httpsUrl = String(urls.appUrl || env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "").trim();
  const caddyConfigured = String(env.ORKESTR_CADDY_ENABLED || "").trim() === "1";
  const mtlsCaCert = String(env.ORKESTR_MTLS_CA_CERT || "").trim();
  const mtlsMode = String(env.ORKESTR_MTLS_MODE || "require_and_verify").trim() || "require_and_verify";
  const mtlsEnabled = envFlag(env.ORKESTR_MTLS_ENABLED) || Boolean(mtlsCaCert);
  const proxyLocalBindSetting = String(env.ORKESTR_REVERSE_PROXY_LOCAL_BIND || "").trim();
  const proxyLocalBind = proxyLocalBindSetting === "1";
  const authRequired = effectiveAuthRequired(env, urls, host);
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
      appUrl: urls.appUrl || httpsUrl,
      authUrl: urls.authUrl || httpsUrl,
      primaryDomain: urls.primaryDomain,
    },
    approval: approvalInstructions(env),
    caddy: {
      installed: caddy.installed || caddyConfigured,
      configured: caddyConfigured,
      version: caddy.version || (caddyConfigured ? "host-managed" : ""),
      error: caddy.installed || caddyConfigured ? "" : caddy.error || "",
    },
    mtls: {
      enabled: mtlsEnabled,
      configured: mtlsEnabled && Boolean(mtlsCaCert),
      mode: mtlsMode,
      caConfigured: Boolean(mtlsCaCert),
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
      ...(mtlsEnabled && !mtlsCaCert ? ["mTLS is enabled, but no client CA certificate is configured."] : []),
    ],
  };
}

export async function createPairingChallenge({ request, env = process.env, userId = "", role = "", instanceId = "", shareId = "", appSlug = "", requestedPath = "", allowedActions = [] } = {}) {
  const config = await readSecurityConfig(env);
  const normalizedRole = String(role || "").trim().toLowerCase() === "user" ? "user" : "admin";
  const normalizedUserId = userId ? normalizeUserId(userId) : "";
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  const normalizedShareId = normalizeShareId(shareId);
  const normalizedAppSlug = normalizeAppSlug(appSlug);
  const existingCodes = new Set((config.challenges || []).map((item) => String(item.approveCode || "").trim().toUpperCase()).filter(Boolean));
  let approveCode = "";
  for (let attempt = 0; attempt < 20 && !approveCode; attempt += 1) {
    const candidate = randomApproveCode();
    if (candidate && !existingCodes.has(candidate)) approveCode = candidate;
  }
  approveCode ||= randomToken(5).slice(0, 8).toUpperCase();
  const challenge = {
    id: randomToken(18),
    approveCode,
    status: "pending",
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + challengeTtlMs).toISOString(),
    instanceId: normalizedInstanceId,
    requestedUserAgent: String(request?.headers?.["user-agent"] || "").slice(0, 240),
    requestedIp: requestIp(request).slice(0, 80),
    userId: normalizedUserId,
    role: normalizedUserId ? normalizedRole : "",
    shareId: normalizedShareId,
    appSlug: normalizedAppSlug,
    requestedPath: String(requestedPath || "").slice(0, 1000),
    allowedActions: normalizeAllowedActions(allowedActions),
  };
  await writeSecurityConfig({
    ...config,
    challenges: [...(config.challenges || []), challenge],
  }, env);
  await appendEvent({
    type: "security_pairing_challenge_created",
    challengeId: challenge.id,
    instanceId: challenge.instanceId || null,
    shareId: challenge.shareId || null,
    appSlug: challenge.appSlug || null,
    userId: challenge.userId || null,
    role: challenge.role || null,
  }, env).catch(() => {});
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
  const challenge = (config.challenges || []).find((item) => challengeMatchesId(item, id));
  if (!challenge) throw challengeError("pairing_challenge_not_found", 404);
  return publicChallenge(challenge);
}

function challengeMatchesId(challenge = {}, id = "") {
  const value = String(id || "").trim();
  if (!value) return false;
  return challenge.id === value || String(challenge.approveCode || "").trim().toUpperCase() === value.toUpperCase();
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
  const revokedSession = before.find((session) => session.id === id) || null;
  const sessions = before.filter((session) => session.id !== id);
  if (sessions.length === before.length) throw challengeError("security_session_not_found", 404);
  await writeSecurityConfig({ ...config, sessions }, env);
  await appendEvent({
    type: "security_session_revoked",
    sessionId: id,
    userId: revokedSession?.userId || null,
    role: revokedSession?.role || null,
    revokedBy,
  }, env).catch(() => {});
  return { ok: true, revoked: [id] };
}

export async function revokeAllSecuritySessions({ env = process.env, revokedBy = "cli" } = {}) {
  const config = await readSecurityConfig(env);
  const revoked = (config.sessions || []).map((session) => session.id).filter(Boolean);
  await writeSecurityConfig({ ...config, sessions: [] }, env);
  await appendEvent({ type: "security_sessions_revoked", count: revoked.length, revokedBy }, env).catch(() => {});
  return { ok: true, revoked };
}

export async function setSecurityPairingEnabled(enabled, { env = process.env, updatedBy = "cli" } = {}) {
  const config = await readSecurityConfig(env);
  const nextEnabled = enabled === true;
  await writeSecurityConfig({
    ...config,
    enabled: nextEnabled,
    sessions: nextEnabled ? config.sessions || [] : [],
    challenges: nextEnabled ? config.challenges || [] : [],
  }, env);
  await appendEvent({
    type: nextEnabled ? "security_pairing_enabled" : "security_pairing_disabled",
    updatedBy,
  }, env).catch(() => {});
  return { ok: true, security: await securityStatus(env) };
}

export async function approvePairingChallenge(challengeId, { env = process.env, approvedBy = "cli" } = {}) {
  const id = String(challengeId || "").trim();
  if (!id) throw challengeError("pairing_challenge_id_required", 400);
  const config = await readSecurityConfig(env);
  const now = Date.now();
  let approved = null;
  const challenges = (config.challenges || []).map((item) => {
    const challenge = normalizeChallenge(item, now);
    if (!challengeMatchesId(challenge, id)) return challenge;
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
  await appendEvent({ type: "security_pairing_challenge_approved", challengeId: approved.id, approvedBy }, env).catch(() => {});
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
    if (!challengeMatchesId(challenge, id)) return challenge;
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
  await appendEvent({ type: "security_pairing_challenge_rejected", challengeId: rejected.id, rejectedBy }, env).catch(() => {});
  return { ok: true, challenge: publicChallenge(rejected) };
}

export async function deletePairingChallenge(challengeId, { env = process.env, deletedBy = "browser" } = {}) {
  const id = String(challengeId || "").trim();
  if (!id) throw challengeError("pairing_challenge_id_required", 400);
  const config = await readSecurityConfig(env);
  const before = config.challenges || [];
  const challenges = before.filter((challenge) => challenge.id !== id);
  if (challenges.length === before.length) throw challengeError("pairing_challenge_not_found", 404);
  await writeSecurityConfig({ ...config, challenges }, env);
  await appendEvent({ type: "security_pairing_challenge_deleted", challengeId: id, deletedBy }, env).catch(() => {});
  return { ok: true, deleted: id };
}

function sessionAccessTouchIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_SECURITY_SESSION_TOUCH_INTERVAL_MS || 5 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5 * 60 * 1000;
}

async function touchSecuritySession(config, session, { env = process.env, request = null } = {}) {
  if (!session?.id) return;
  const now = Date.now();
  const intervalMs = sessionAccessTouchIntervalMs(env);
  const lastMs = Date.parse(session.lastAccessedAt || session.createdAt || "");
  const ip = requestIp(request).slice(0, 80);
  const userAgent = String(request?.headers?.["user-agent"] || session.userAgent || "").slice(0, 240);
  if (
    intervalMs > 0 &&
    Number.isFinite(lastMs) &&
    now - lastMs < intervalMs &&
    (!ip || session.lastIp === ip)
  ) return;
  const touched = {
    ...session,
    userAgent,
    lastAccessedAt: nowIso(),
    lastIp: ip || session.lastIp || "",
  };
  await writeSecurityConfig({
    ...config,
    sessions: (config.sessions || []).map((item) => item.id === session.id ? touched : item),
  }, env);
}

export async function pairBrowser({ challengeId, userAgent = "", ip = "", env = process.env } = {}) {
  const id = String(challengeId || "").trim();
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const challenges = (config.challenges || []).map((challenge) => normalizeChallenge(challenge, now));
  const challenge = challenges.find((item) => challengeMatchesId(item, id));
  if (!challenge) throw challengeError("invalid_or_expired_pairing_challenge", 401);
  if (challenge.status === "pending") throw challengeError("pairing_challenge_not_approved", 409);
  if (challenge.status !== "approved") throw challengeError(`pairing_challenge_${challenge.status}`, 401);
  if (Date.parse(challenge.expiresAt || "") <= now) throw challengeError("pairing_challenge_expired", 401);
  const token = randomToken(32);
  const createdAt = nowIso();
  const session = {
    id: randomToken(10),
    challengeId: challenge.id,
    instanceId: challenge.instanceId || "",
    tokenHash: sha256(token),
    userId: normalizeUserId(challenge.userId || defaultAdminUser(env).id),
    role: String(challenge.role || "admin").trim().toLowerCase() === "user" ? "user" : "admin",
    userAgent: String(userAgent || "").slice(0, 240),
    createdAt,
    lastAccessedAt: createdAt,
    lastIp: String(ip || "").slice(0, 80),
    shareId: challenge.shareId || "",
    appSlug: challenge.appSlug || "",
    allowedActions: normalizeAllowedActions(challenge.allowedActions || []),
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
  await appendEvent({
    type: "security_browser_paired",
    sessionId: session.id,
    challengeId: challenge.id,
    instanceId: session.instanceId || null,
    shareId: session.shareId || null,
    appSlug: session.appSlug || null,
    userId: session.userId,
    role: session.role,
  }, env).catch(() => {});
  return {
    ok: true,
    token,
    session: publicSession(session),
  };
}

export async function verifySecurityToken(token, env = process.env, options = {}) {
  return Boolean(await securitySessionForToken(token, env, options));
}

export async function securitySessionForToken(token, env = process.env, options = {}) {
  const value = String(token || "").trim();
  if (!value) return null;
  const config = await readSecurityConfig(env);
  const now = Date.now();
  const hash = sha256(value);
  const session = (config.sessions || []).find((item) =>
    Date.parse(item.expiresAt || "") > now && item.tokenHash === hash,
  );
  if (!session) return null;
  if (options?.touch !== false) await touchSecuritySession(config, session, { env, request: options?.request }).catch(() => {});
  return {
    ...session,
    userId: normalizeUserId(session.userId || defaultAdminUser(env).id),
    role: String(session.role || "admin").trim().toLowerCase() === "user" ? "user" : "admin",
  };
}

function isAllowedBeforePairing(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const url = String(request?.originalUrl || request?.url || "").split("?")[0];
  if (url.startsWith("/desktop/")) return false;
  if (!url.startsWith("/api/") && !url.startsWith("/oauth/")) return true;
  if (url.startsWith("/oauth/")) return true;
  if (method === "GET" && /^\/(?:api\/)?desktop-shares\/[^/]+\/(?:open|status)$/.test(url)) return true;
  if (method === "GET" && /^\/(?:api\/)?tenant-vms\/[^/]+\/desktop-shares\/[^/]+\/(?:open|status)$/.test(url)) return true;
  if (method === "GET" && ["/api/health", "/api/ready", "/api/version", "/api/setup/status"].some((path) => url.startsWith(path))) return true;
  if (method === "POST" && url === "/api/public/waitlist") return true;
  if (method === "POST" && (url === "/api/setup/security/challenge" || url === "/api/setup/security/challenges")) return true;
  if (method === "POST" && (url === "/api/broker/instances/register" || /^\/api\/broker\/instances\/[^/]+\/heartbeat$/.test(url))) return true;
  if (method === "POST" && /^\/api\/broker\/instances\/[^/]+\/whatsapp\/(?:onboarding|history)$/.test(url)) return true;
  if (method === "POST" && /^\/api\/broker\/instances\/[^/]+\/google-workspace\/(?:connect-link|refresh-token)$/.test(url)) return true;
  if (method === "POST" && url === "/api/broker/google-workspace/grants") return true;
  if (method === "GET" && /^\/api\/setup\/security\/challenges\/[^/]+$/.test(url)) return true;
  if (method === "POST" && url === "/api/setup/security/pair") return true;
  return false;
}

export async function authorizeHttpRequest(request, env = process.env) {
  const status = await securityStatus(env);
  const shareAuth = String(request?.url || "").startsWith("/desktop/")
    ? await authorizeDesktopShareHttpRequest(request, env).catch((error) => ({
        ok: false,
        statusCode: error?.statusCode || 401,
        error: error?.message || String(error),
      }))
    : null;
  if (shareAuth?.ok) return { ok: true, status, principal: shareAuth.principal, desktopShare: shareAuth.share };
  if (shareAuth && Number(shareAuth.statusCode || 0) >= 400) {
    return { ok: false, status, statusCode: shareAuth.statusCode, error: shareAuth.error || "desktop_share_forbidden" };
  }
  const cliAuth = await authorizeCliMachineRequest(request, env);
  if (cliAuth?.ok) return { ok: true, status, principal: cliAuth.principal, machineAuth: cliAuth.machineAuth };
  const brokerProxyAuth = await authorizeBrokerProxyMachineRequest(request, env);
  if (brokerProxyAuth?.ok) return {
    ok: true,
    status,
    principal: brokerProxyAuth.principal,
    machineAuth: brokerProxyAuth.machineAuth,
    machineAuthContext: brokerProxyAuth.machineAuthContext || null,
  };
  if (brokerProxyAuth && status.authEnabled) return { ...brokerProxyAuth, status };
  const whatsappInboundAuth = await authorizeWhatsAppMachineRequest(request, env);
  if (whatsappInboundAuth?.ok) return {
    ok: true,
    status,
    principal: whatsappInboundAuth.principal,
    machineAuth: whatsappInboundAuth.machineAuth,
    machineAuthContext: whatsappInboundAuth.machineAuthContext || null,
  };
  if (whatsappInboundAuth && status.authEnabled) return { ...whatsappInboundAuth, status };
  const jobsJdCacheAuth = await authorizeJobsJdCacheMachineRequest(request, env);
  if (jobsJdCacheAuth?.ok) return {
    ok: true,
    status,
    principal: jobsJdCacheAuth.principal,
    machineAuth: jobsJdCacheAuth.machineAuth,
    machineAuthContext: jobsJdCacheAuth.machineAuthContext || null,
  };
  if (jobsJdCacheAuth && status.authEnabled) return { ...jobsJdCacheAuth, status };
  if (!status.authEnabled) return { ok: true, status, principal: adminPrincipal(defaultAdminUser(env)) };
  const token = cookieValue(request?.headers?.cookie || "");
  const session = await securitySessionForToken(token, env, { request });
  if (session) {
    const user = await getUser(session.userId, env);
    if (user?.status === "disabled") {
      return {
        ok: false,
        status,
        statusCode: 403,
        error: "user_disabled",
      };
    }
    const principal = principalFromSecuritySession({
      ...session,
      role: user?.role || session.role,
      displayName: user?.displayName || session.displayName,
    }, env);
    return { ok: true, status, principal, session };
  }
  if (isAllowedBeforePairing(request)) return { ok: true, status, principal: adminPrincipal(defaultAdminUser(env)) };
  return {
    ok: false,
    status,
    statusCode: 401,
    error: "browser_pairing_required",
  };
}

function requestCookieHost(value = "") {
  return String(value || "")
    .trim()
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.+|\.+$/g, "");
}

function cookieDomainMatchesHost(cookieDomain = "", host = "") {
  const domain = requestCookieHost(cookieDomain).replace(/^\./, "");
  const requestHost = requestCookieHost(host);
  if (!domain || !requestHost) return Boolean(domain);
  return requestHost === domain || requestHost.endsWith(`.${domain}`);
}

export function sessionCookieHeader(token, env = process.env, options = {}) {
  const urls = publicUrlConfig(env);
  const cookieDomain = cookieDomainMatchesHost(urls.cookieDomain, options.requestHost) ? urls.cookieDomain : "";
  const secure = String(env.ORKESTR_COOKIE_SECURE || "").trim() === "1" ||
    Boolean(String(urls.appUrl || env.ORKESTR_PUBLIC_HTTPS_URL || "").startsWith("https://"));
  return [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    cookieDomain ? `Domain=${cookieDomain}` : "",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
