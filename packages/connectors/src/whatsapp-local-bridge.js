import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { requestThreadInputDelivery } from "../../core/src/runtime-leases.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../../core/src/tenant-api-agent.js";
import { listTenantWhatsAppRoutes, tenantWhatsAppInboundForwardRoute } from "../../core/src/tenant-whatsapp-routing.js";
import { attachRoutingFailure, normalizeRoutingFailure, routingFailureFromError } from "../../core/src/routing-failures.js";
import { recordRouterTraceEvent, routerTraceIdFor, turnIdFor } from "../../core/src/router-traces.js";
import { exactSecurityApproveChallengeId } from "../../core/src/raw-terminal-commands.js";
import { publicHttpUrl, tenantPublicSetupUrl } from "../../core/src/tenant-public-urls.js";
import { getThread, listThreads } from "../../core/src/threads.js";
import { setGeneratedLocalWhatsAppGroupPicture } from "./whatsapp-chat-picture.js";
import {
  bindingAccountIds as whatsappBindingAccountIds,
  whatsappBindingIsRouteEligible,
} from "./whatsapp-inbound-routing.js";
import { readWhatsAppConnectorAccounts, validWhatsAppConnectorAccountId } from "./whatsapp-account-registry.js";

export const localWhatsAppAccountIds = ["account-1", "account-2"];
export const localWhatsAppBridgeBasePath = "/api/connectors/whatsapp/bridge";

const runtimes = new Map();
const accountStates = new Map();
const outboundMessageIds = new Set();
const outboundMessageTextKeys = new Map();
const outboundAttachmentKeys = new Map();
const outboundAttachmentSizeKeys = new Map();
const inboundFailureNoticeKeys = new Set();
const inboundForwardLedgerKeys = new Set();
const typingSessions = new Map();
const typingStartPromises = new Map();
const typingClearRetryTimers = new Map();
const inboundForwardHealthCache = new Map();
const localWhatsAppStartPromises = new Map();
let runtimeRecoveryHooksForTest = null;
let typingSessionGeneration = 0;

function nowIso() {
  return new Date().toISOString();
}

function splitAccountList(value) {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function localWhatsAppAccountIdsForEnv(env = process.env) {
  const configured = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  return configured.length ? [...new Set(configured)] : localWhatsAppAccountIds;
}

function strictLocalWhatsAppAccountIds(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS || env.WHATSAPP_LOCAL_STRICT_ACCOUNT_IDS || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function uniqueAccountIds(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

async function persistentLocalWhatsAppAccountIds(env = process.env) {
  const accounts = await readWhatsAppConnectorAccounts(env).catch(() => []);
  return uniqueAccountIds(accounts
    .map((account) => String(account.accountId || account.id || "").trim())
    .filter((accountId) => validWhatsAppConnectorAccountId(accountId)));
}

async function managedLocalWhatsAppAccountIds(env = process.env) {
  const configured = localWhatsAppAccountIdsForEnv(env);
  if (strictLocalWhatsAppAccountIds(env)) return configured;
  return uniqueAccountIds([
    ...configured,
    ...(await persistentLocalWhatsAppAccountIds(env)),
  ]);
}

function accountClientIdMap(env = process.env) {
  const pairs = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS);
  return new Map(pairs.map((pair) => {
    const [accountId, ...clientIdParts] = pair.split(":");
    return [String(accountId || "").trim(), clientIdParts.join(":").trim()];
  }).filter(([accountId, clientId]) => accountId && clientId));
}

function clientIdForAccount(accountId, env = process.env) {
  return accountClientIdMap(env).get(accountId) || accountId;
}

function accountSessionRootMap(env = process.env) {
  const pairs = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS || env.WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS);
  return new Map(pairs.map((pair) => {
    const [accountId, ...rootParts] = pair.split(":");
    return [String(accountId || "").trim(), rootParts.join(":").trim()];
  }).filter(([accountId, root]) => accountId && root));
}

function sessionRootForAccount(accountId, env = process.env) {
  return accountSessionRootMap(env).get(accountId) || sessionRoot(env);
}

function localAuthSessionDirForAccount(accountId, env = process.env) {
  const clientId = clientIdForAccount(accountId, env);
  return path.join(sessionRootForAccount(accountId, env), `session-${clientId}`);
}

function sessionRootAlreadyIncludesClient(accountId, env = process.env) {
  const root = sessionRootForAccount(accountId, env);
  const clientId = clientIdForAccount(accountId, env);
  return path.basename(root) === `session-${clientId}`;
}

function sameOrInsidePath(parent, child) {
  const base = path.resolve(String(parent || ""));
  const candidate = path.resolve(String(child || ""));
  if (!base || !candidate) return false;
  if (candidate === base) return true;
  const relative = path.relative(base, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function localWhatsAppChromeProfileDirsForAccount(accountId, env = process.env) {
  const dirs = [localAuthSessionDirForAccount(accountId, env)];
  if (sessionRootAlreadyIncludesClient(accountId, env)) dirs.push(sessionRootForAccount(accountId, env));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function legacyResponderRole(env = process.env) {
  return String(env.ORKESTR_WHATSAPP_RESPONDER_ROLE || env.WHATSAPP_RESPONDER_ROLE || "responder").trim();
}

function resolveLocalAccountAlias(accountId = "", env = process.env, ids = localWhatsAppAccountIdsForEnv(env)) {
  const requested = String(accountId || "").trim();
  if (!requested) return "";
  if (requested === legacyResponderRole(env)) {
    const fallback = defaultResponderAccountId(env);
    if (fallback && fallback !== requested && ids.includes(fallback)) return fallback;
  }
  if (ids.includes(requested)) return requested;
  return requested === legacyResponderRole(env)
    ? (defaultResponderAccountId(env) || requested)
    : requested;
}

function normalizeAccountId(accountId = "", env = process.env) {
  const ids = localWhatsAppAccountIdsForEnv(env);
  const normalized = resolveLocalAccountAlias(accountId || ids[0] || "account-1", env);
  if (!ids.includes(normalized)) {
    const error = new Error("unknown_whatsapp_account");
    error.statusCode = 404;
    throw error;
  }
  return normalized;
}

async function normalizeManagedAccountId(accountId = "", env = process.env) {
  const ids = await managedLocalWhatsAppAccountIds(env);
  const normalized = resolveLocalAccountAlias(accountId || ids[0] || "account-1", env, ids);
  if (!ids.includes(normalized)) {
    const error = new Error("unknown_whatsapp_account");
    error.statusCode = 404;
    throw error;
  }
  return normalized;
}

function defaultResponderAccountId(env = process.env) {
  const explicit = String(env.ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID || env.WHATSAPP_LOCAL_DEFAULT_RESPONDER_ACCOUNT_ID || "").trim();
  if (explicit) return explicit;
  const autostart = splitAccountList(env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS || env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS);
  return autostart[0] || localWhatsAppAccountIdsForEnv(env)[0] || "";
}

function accountLabel(accountId) {
  if (!localWhatsAppAccountIds.includes(accountId)) return accountId;
  return accountId === "account-2" ? "WhatsApp 2" : "WhatsApp 1";
}

function readJsonEnvMap(value) {
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function localWhatsAppInboundForwardTarget({ chatId = "" } = {}, env = process.env) {
  const id = String(chatId || "").trim();
  if (!id) return "";
  const targets = readJsonEnvMap(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON || env.WHATSAPP_INBOUND_FORWARD_MAP_JSON);
  return String(targets[id] || "").trim();
}

function localWhatsAppInboundForwardToken({ chatId = "" } = {}, env = process.env) {
  const tokens = readJsonEnvMap(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON || env.WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON);
  return String(tokens[String(chatId || "").trim()] || env.ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN || env.WHATSAPP_INBOUND_FORWARD_TOKEN || "").trim();
}

function localWhatsAppInboundForwardSetupUrl({ chatId = "" } = {}, env = process.env) {
  const urls = readJsonEnvMap(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_SETUP_URL_MAP_JSON || env.WHATSAPP_INBOUND_FORWARD_SETUP_URL_MAP_JSON);
  return String(urls[String(chatId || "").trim()] || env.ORKESTR_WHATSAPP_INBOUND_FORWARD_SETUP_URL || env.WHATSAPP_INBOUND_FORWARD_SETUP_URL || "").trim();
}

function localWhatsAppSecurityApprovalForwardTarget({ chatId = "" } = {}, env = process.env) {
  const targets = readJsonEnvMap(env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_MAP_JSON || env.WHATSAPP_SECURITY_APPROVAL_FORWARD_MAP_JSON);
  return normalizeLocalSecurityApprovalForwardTarget(
    targets[String(chatId || "").trim()] ||
      env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL ||
      env.WHATSAPP_SECURITY_APPROVAL_FORWARD_URL ||
      "",
    env,
  );
}

function loopbackHostForSelfFetch(host = "") {
  const value = String(host || "").trim().toLowerCase();
  if (!value || ["0.0.0.0", "::", "[::]", "*"].includes(value)) return "127.0.0.1";
  if (value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]") return "127.0.0.1";
  return value;
}

function localOrkestrInboundUrl(env = process.env) {
  const configured = String(env.ORKESTR_LOCAL_API_BASE || env.ORKESTR_API_BASE || "").trim();
  if (configured) {
    try {
      return String(new URL("/api/connectors/whatsapp/inbound", `${configured.replace(/\/+$/g, "")}/`));
    } catch {
      // Fall through to host/port derivation.
    }
  }
  const host = loopbackHostForSelfFetch(env.ORKESTR_HOST || "127.0.0.1");
  const port = String(env.ORKESTR_PORT || env.PORT || "19812").trim() || "19812";
  return `http://${host}:${port}/api/connectors/whatsapp/inbound`;
}

function localSelfForwardHost(host = "") {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::", ""].includes(value);
}

function normalizeLocalSecurityApprovalForwardTarget(target = "", env = process.env) {
  const raw = String(target || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!localSelfForwardHost(parsed.hostname)) return raw;
    if (parsed.pathname.replace(/\/+$/g, "") !== "/api/connectors/whatsapp/inbound") return raw;
    const current = new URL(localOrkestrInboundUrl(env));
    if (!localSelfForwardHost(current.hostname)) return raw;
    if (parsed.protocol !== current.protocol || parsed.hostname !== current.hostname || parsed.port !== current.port) {
      return String(current);
    }
  } catch {
    return raw;
  }
  return raw;
}

function firstSecretValue(...values) {
  for (const value of values) {
    const token = String(value || "").split(/[\s,]+/g).map((item) => item.trim()).find(Boolean);
    if (token) return token;
  }
  return "";
}

function localSecurityApprovalTargetIsSelf(target = "", env = process.env) {
  try {
    const parsed = new URL(String(target || "").trim());
    if (!localSelfForwardHost(parsed.hostname)) return false;
    if (parsed.pathname.replace(/\/+$/g, "") !== "/api/connectors/whatsapp/inbound") return false;
    const current = new URL(localOrkestrInboundUrl(env));
    return localSelfForwardHost(current.hostname) && parsed.port === current.port && parsed.protocol === current.protocol;
  } catch {
    return false;
  }
}

function localWhatsAppSecurityApprovalForwardToken({ chatId = "", target = "" } = {}, env = process.env) {
  if (localSecurityApprovalTargetIsSelf(target, env)) {
    const inboundToken = firstSecretValue(
      env.ORKESTR_WHATSAPP_INBOUND_TOKEN,
      env.WHATSAPP_INBOUND_TOKEN,
      env.ORKESTR_WHATSAPP_INBOUND_TOKENS,
      env.WHATSAPP_INBOUND_TOKENS,
    );
    if (inboundToken) return inboundToken;
  }
  const tokens = readJsonEnvMap(env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_MAP_JSON || env.WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_MAP_JSON);
  const tokenChatId = String(env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID || env.WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID || "").trim();
  return String(
    tokens[String(chatId || "").trim()] ||
    env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN ||
    env.WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN ||
    (tokenChatId ? localWhatsAppInboundForwardToken({ chatId: tokenChatId }, env) : "")
  ).trim();
}

function localWhatsAppInboundForwardChatIds(env = process.env) {
  const targets = readJsonEnvMap(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON || env.WHATSAPP_INBOUND_FORWARD_MAP_JSON);
  return Object.entries(targets)
    .filter(([chatId, target]) => String(chatId || "").trim() && String(target || "").trim())
    .map(([chatId]) => String(chatId || "").trim());
}

function falsey(value = "") {
  return ["0", "false", "off", "no"].includes(String(value || "").trim().toLowerCase());
}

function inboundForwardHealthTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(500, parsed) : 5000;
}

function inboundForwardHealthCacheMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_CACHE_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 10_000;
}

function inboundForwardHealthGateEnabled({ tenantRoute = null } = {}, env = process.env) {
  if (falsey(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_GATE || env.WHATSAPP_INBOUND_FORWARD_HEALTH_GATE)) return false;
  return Boolean(tenantRoute) || String(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_GATE || env.WHATSAPP_INBOUND_FORWARD_HEALTH_GATE || "").trim() !== "";
}

function healthUrlForInboundTarget(target = "") {
  try {
    return String(new URL("/api/health", target));
  } catch {
    return "";
  }
}

async function appendInboundForwardHealthEvent({ target = "", tenantRoute = null, ok = false, status = null, reason = "", cached = false } = {}, env = process.env) {
  await appendEvent({
    type: "whatsapp_local_inbound_forward_health_checked",
    target,
    tenantVmId: tenantRoute?.tenantVmId || null,
    routeMode: tenantRoute?.routeMode || "",
    targetSource: tenantRoute?.targetSource || "",
    ok,
    status,
    reason,
    cached,
  }, env).catch(() => {});
}

async function assertInboundForwardTargetHealthy(target = "", tenantRoute = null, env = process.env, fetchImpl = fetch) {
  const healthUrl = healthUrlForInboundTarget(target);
  if (!healthUrl) {
    await appendInboundForwardHealthEvent({ target, tenantRoute, ok: false, reason: "invalid_health_url" }, env);
    throw attachRoutingFailure(new Error("target_instance_unhealthy"), {
      code: "target_instance_unhealthy",
      userFacingCategory: "instance_health",
      target,
      instanceId: tenantRoute?.tenantVmId || "",
      retryable: true,
      reason: "invalid_health_url",
    });
  }
  const cacheMs = inboundForwardHealthCacheMs(env);
  const cached = inboundForwardHealthCache.get(healthUrl);
  if (cached && cacheMs > 0 && Date.now() - cached.checkedAt < cacheMs) {
    await appendInboundForwardHealthEvent({ target, tenantRoute, ok: cached.ok, status: cached.status || null, reason: cached.reason || "cached", cached: true }, env);
    if (cached.ok) return cached;
    throw attachRoutingFailure(new Error("target_instance_unhealthy"), {
      code: "target_instance_unhealthy",
      userFacingCategory: "instance_health",
      target,
      instanceId: tenantRoute?.tenantVmId || "",
      retryable: true,
      reason: cached.reason || "cached_unhealthy",
    });
  }
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(inboundForwardHealthTimeoutMs(env)),
    });
    const payload = await response.json().catch(() => ({}));
    const ok = response.ok && payload?.ok !== false;
    const result = {
      ok,
      checkedAt: Date.now(),
      status: response.status,
      reason: ok ? "ok" : `health_http_${response.status}`,
    };
    inboundForwardHealthCache.set(healthUrl, result);
    await appendInboundForwardHealthEvent({ target, tenantRoute, ok, status: response.status, reason: result.reason }, env);
    if (ok) return result;
    throw attachRoutingFailure(new Error("target_instance_unhealthy"), {
      code: "target_instance_unhealthy",
      userFacingCategory: "instance_health",
      target,
      instanceId: tenantRoute?.tenantVmId || "",
      retryable: true,
      reason: result.reason,
    });
  } catch (error) {
    if (error?.routingFailure) throw error;
    const reason = error?.name === "AbortError" ? "health_timeout" : String(error?.message || error || "health_failed");
    inboundForwardHealthCache.set(healthUrl, { ok: false, checkedAt: Date.now(), reason });
    await appendInboundForwardHealthEvent({ target, tenantRoute, ok: false, reason }, env);
    throw attachRoutingFailure(new Error("target_instance_unhealthy"), {
      code: "target_instance_unhealthy",
      userFacingCategory: "instance_health",
      target,
      instanceId: tenantRoute?.tenantVmId || "",
      retryable: true,
      reason,
    });
  }
}

function targetInboundFailureCode(payload = {}, status = 0) {
  const raw = String(payload?.routingFailure?.code || payload?.error || "").trim();
  if ((status === 401 || status === 403) && raw === "browser_pairing_required") return "whatsapp_inbound_token_invalid";
  if (raw === "whatsapp_target_required") return "target_codex_not_configured";
  return raw || `whatsapp_inbound_forward_failed_${status || "unknown"}`;
}

function targetInboundFailureCategory(code = "", status = 0) {
  const lowered = String(code || "").toLowerCase();
  if (lowered.includes("codex")) return "codex";
  if (lowered.includes("token") || lowered.includes("auth") || status === 401 || status === 403) return "connector";
  return "instance_health";
}

function targetInboundFailureSafeMessage(code = "", status = 0) {
  const lowered = String(code || "").toLowerCase();
  if (lowered.includes("codex")) return "Target Orkestr instance has not enabled Codex for this VM yet.";
  if (lowered.includes("token_unconfigured")) return "Target instance has no WhatsApp inbound token configured.";
  if (lowered.includes("token_required")) return "Broker request reached the target without a WhatsApp inbound token.";
  if (lowered.includes("token_invalid") || status === 401 || status === 403) return "Target instance rejected the broker WhatsApp inbound token.";
  return "Target instance could not accept the brokered WhatsApp message.";
}

function targetInboundFailureSetupUrl({ payload = {}, tenantRoute = null, chatId = "", env = process.env } = {}) {
  return String(
    payload?.routingFailure?.appUrl ||
      payload?.appUrl ||
      tenantRoute?.appUrl ||
      payload?.routingFailure?.setupUrl ||
      payload?.setupUrl ||
      tenantRoute?.setupUrl ||
      localWhatsAppInboundForwardSetupUrl({ chatId }, env) ||
      "",
  ).trim();
}

function attachmentLocalPath(attachment = {}) {
  return String(
    attachment?.path ||
      attachment?.saved_path ||
      attachment?.savedPath ||
      attachment?.filePath ||
      attachment?.localPath ||
      "",
  ).trim();
}

function inboundMediaForwardTarget(target = "") {
  try {
    const url = new URL(String(target || ""));
    url.pathname = "/api/connectors/whatsapp/inbound-media";
    url.search = "";
    url.hash = "";
    return String(url);
  } catch {
    return "";
  }
}

function inboundMediaForwardMaxBytes(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_FORWARD_MAX_BYTES || env.WHATSAPP_INBOUND_MEDIA_FORWARD_MAX_BYTES || 25 * 1024 * 1024);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
}

function forwardedMediaFileName(attachment = {}, filePath = "", index = 0) {
  return safeFilePart(
    attachment.filename ||
      attachment.name ||
      (filePath ? path.basename(filePath) : "") ||
      `attachment-${index + 1}.bin`,
    `attachment-${index + 1}.bin`,
  );
}

async function prepareInboundMediaForward({ input = {}, target = "", token = "", attachments = [], tenantRoute = null, env = process.env, fetchImpl = fetch } = {}) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (!items.length) return { attachments: items, uploaded: 0 };
  const uploadTarget = inboundMediaForwardTarget(target);
  if (!uploadTarget) return { attachments: items, uploaded: 0, skipped: "upload_target_unavailable" };
  if (typeof FormData !== "function" || typeof Blob !== "function") {
    const error = new Error("whatsapp_inbound_media_upload_formdata_unavailable");
    error.statusCode = 500;
    throw error;
  }
  const maxBytes = inboundMediaForwardMaxBytes(env);
  const slots = [];
  const metadata = [];
  const form = new FormData();
  for (let index = 0; index < items.length; index += 1) {
    const attachment = items[index] || {};
    const localPath = attachmentLocalPath(attachment);
    if (!localPath) continue;
    const stat = await fs.stat(localPath).catch(() => null);
    if (!stat?.isFile()) {
      const error = new Error("whatsapp_inbound_media_source_missing");
      error.statusCode = 502;
      error.attachment = { index, path: localPath };
      throw error;
    }
    if (stat.size > maxBytes) {
      const error = new Error("whatsapp_inbound_media_source_too_large");
      error.statusCode = 413;
      error.attachment = { index, path: localPath, size: stat.size, maxBytes };
      throw error;
    }
    const buffer = await fs.readFile(localPath);
    const filename = forwardedMediaFileName(attachment, localPath, index);
    const mimetype = String(attachment.mimetype || attachment.type || "application/octet-stream").trim() || "application/octet-stream";
    form.append("files", new Blob([buffer], { type: mimetype }), filename);
    metadata.push({
      filename,
      name: String(attachment.name || filename),
      mimetype,
      type: mimetype,
      kind: String(attachment.kind || "file"),
      size: buffer.length,
      sourceEventId: String(input.eventId || input.id || input.messageId || ""),
      chatId: String(input.chatId || input.chat?.id || input.fromChatId || ""),
      accountId: String(input.accountId || ""),
    });
    slots.push(index);
  }
  if (!slots.length) return { attachments: items, uploaded: 0 };
  form.append("metadata", JSON.stringify(metadata));
  form.append("eventId", String(input.eventId || input.id || input.messageId || ""));
  form.append("chatId", String(input.chatId || input.chat?.id || input.fromChatId || ""));
  form.append("accountId", String(input.accountId || ""));
  const response = await fetchImpl(uploadTarget, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(Number(env.WHATSAPP_INBOUND_FORWARD_TIMEOUT_MS || 60_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `whatsapp_inbound_media_upload_http_${response.status}`);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }
  const uploaded = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (uploaded.length < slots.length) {
    const error = new Error("whatsapp_inbound_media_upload_incomplete");
    error.statusCode = 502;
    error.payload = payload;
    throw error;
  }
  let cursor = 0;
  const replaced = items.map((attachment, index) => {
    if (!slots.includes(index)) return attachment;
    return uploaded[cursor++] || attachment;
  });
  await appendEvent({
    type: "whatsapp_local_inbound_media_uploaded_to_target",
    chatId: String(input.chatId || input.chat?.id || input.fromChatId || ""),
    eventId: String(input.eventId || input.id || input.messageId || ""),
    tenantVmId: tenantRoute?.tenantVmId || null,
    target: uploadTarget,
    count: uploaded.length,
  }, env).catch(() => {});
  return { attachments: replaced, uploaded: uploaded.length, target: uploadTarget };
}

function canonicalLocalWhatsAppEventId(value = "") {
  return String(value || "").trim().replace(/^(?:true|false)_/, "");
}

function inboundForwardSourceKey({ chatId = "", eventId = "" } = {}) {
  const chat = String(chatId || "").trim();
  const canonicalEventId = canonicalLocalWhatsAppEventId(eventId);
  if (!chat || !canonicalEventId) return "";
  return `${chat}:${canonicalEventId}`;
}

function inboundForwardLedgerLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_FORWARD_LEDGER_LIMIT || env.WHATSAPP_INBOUND_FORWARD_LEDGER_LIMIT || 1000);
  return Number.isFinite(parsed) ? Math.max(100, Math.min(5000, Math.floor(parsed))) : 1000;
}

async function readInboundForwardLedger(env = process.env) {
  const state = await readJson(dataPaths(env).whatsapp, {
    inboundEvents: [],
    outboundDeliveries: [],
    inboundForwardLedger: [],
  }).catch(() => ({}));
  return Array.isArray(state.inboundForwardLedger) ? state.inboundForwardLedger : [];
}

async function findInboundForwardLedgerEntry({ chatId = "", eventId = "" } = {}, env = process.env) {
  const key = inboundForwardSourceKey({ chatId, eventId });
  if (!key) return null;
  const ledger = await readInboundForwardLedger(env);
  const entry = ledger.find((item) => String(item?.key || "") === key) || null;
  if (entry) return entry;
  if (inboundForwardLedgerKeys.has(key)) return { key, memoryOnly: true };
  return null;
}

async function rememberInboundForwardLedgerEntry(input = {}, details = {}, env = process.env) {
  const chatId = String(input.chatId || input.chat?.id || input.fromChatId || "").trim();
  const eventId = String(input.eventId || input.id || input.messageId || "").trim();
  const key = inboundForwardSourceKey({ chatId, eventId });
  if (!key) return null;
  inboundForwardLedgerKeys.add(key);
  const paths = dataPaths(env);
  const state = await readJson(paths.whatsapp, {
    inboundEvents: [],
    outboundDeliveries: [],
    inboundForwardLedger: [],
  }).catch(() => ({}));
  const existing = Array.isArray(state.inboundForwardLedger) ? state.inboundForwardLedger : [];
  const nextEntry = {
    key,
    eventId,
    canonicalEventId: canonicalLocalWhatsAppEventId(eventId),
    chatId,
    accountId: String(input.accountId || "").trim(),
    target: String(details.target || "").trim(),
    tenantVmId: details.tenantVmId || null,
    threadId: details.threadId || null,
    messageId: details.messageId || null,
    duplicate: details.duplicate === true,
    forwardedAt: nowIso(),
  };
  const merged = new Map(existing.map((entry) => [String(entry?.key || ""), entry]).filter(([entryKey]) => entryKey));
  merged.set(key, nextEntry);
  const limit = inboundForwardLedgerLimit(env);
  const inboundForwardLedger = [...merged.values()].slice(-limit);
  await writeJson(paths.whatsapp, {
    ...state,
    inboundForwardLedger,
    updatedAt: nowIso(),
  });
  while (inboundForwardLedgerKeys.size > limit) {
    const [oldest] = inboundForwardLedgerKeys;
    inboundForwardLedgerKeys.delete(oldest);
  }
  return nextEntry;
}

async function managedTenantRouteAccountMismatch(input = {}, chatId = "", env = process.env) {
  const accountId = String(input.accountId || "").trim();
  if (!chatId || !accountId) return null;
  const routes = await listTenantWhatsAppRoutes(env).catch(() => []);
  return (Array.isArray(routes) ? routes : []).find((route) =>
    route?.enabled === true &&
    String(route.chatId || "").trim() === chatId &&
    String(route.accountId || "").trim() &&
    String(route.accountId || "").trim() !== accountId
  ) || null;
}

function inboundForwardTraceContext(input = {}, chatId = "") {
  const eventId = String(input.eventId || input.id || input.messageId || "").trim();
  const accountId = String(input.accountId || "").trim();
  const routerTraceId = routerTraceIdFor({
    connector: "whatsapp",
    accountId,
    chatId,
    eventId: eventId || "missing_event_id",
    fallbackId: `${accountId}:${chatId}:missing_event_id`,
  });
  return {
    eventId,
    accountId,
    routerTraceId,
    turnId: routerTraceId ? turnIdFor({ routerTraceId }) : "",
  };
}

export async function forwardLocalWhatsAppInbound(input = {}, env = process.env, fetchImpl = fetch) {
  const chatId = String(input.chatId || input.chat?.id || input.fromChatId || "").trim();
  const trace = inboundForwardTraceContext(input, chatId);
  let tenantRoute = null;
  let deliveryTenantRoute = null;
  let target = "";
  let targetSource = "";
  let routeMode = "";
  try {
    const ledgerEntry = await findInboundForwardLedgerEntry({
      chatId,
      eventId: String(input.eventId || input.id || input.messageId || ""),
    }, env);
    if (ledgerEntry) {
      await appendEvent({
        type: "whatsapp_local_inbound_forward_duplicate",
        chatId,
        eventId: String(input.eventId || input.id || input.messageId || ""),
        accountId: String(input.accountId || ""),
        previousEventId: ledgerEntry.eventId || null,
        threadId: ledgerEntry.threadId || null,
        messageId: ledgerEntry.messageId || null,
        tenantVmId: ledgerEntry.tenantVmId || null,
      }, env).catch(() => {});
      return {
        forwarded: false,
        duplicate: true,
        skipped: "duplicate_forwarded_source",
        payload: {
          duplicate: true,
          threadId: ledgerEntry.threadId || null,
          messageId: ledgerEntry.messageId || null,
          eventId: ledgerEntry.eventId || null,
        },
      };
    }
    tenantRoute = await tenantWhatsAppInboundForwardRoute(input, env);
    if (!tenantRoute) {
      const mismatchRoute = await managedTenantRouteAccountMismatch(input, chatId, env);
      if (mismatchRoute) {
        await appendEvent({
          type: "whatsapp_local_inbound_forward_account_skipped",
          chatId,
          eventId: String(input.eventId || input.id || input.messageId || ""),
          accountId: String(input.accountId || ""),
          routeAccountId: mismatchRoute.accountId || "",
          tenantVmId: mismatchRoute.tenantVmId || null,
          reason: "managed_route_account_mismatch",
        }, env).catch(() => {});
        return {
          forwarded: false,
          skipped: "managed_route_account_mismatch",
          payload: { duplicate: true, reason: "managed_route_account_mismatch" },
        };
      }
    }
    const approvalChallengeId = exactSecurityApproveChallengeId(input.text || input.body || input.message || "");
    const approvalTarget = approvalChallengeId && !tenantRoute ? localWhatsAppSecurityApprovalForwardTarget({ chatId }, env) : "";
    if (approvalTarget) {
      target = approvalTarget;
      targetSource = "security_approval_forward";
      routeMode = "security_approval";
    } else {
      target = tenantRoute?.target || localWhatsAppInboundForwardTarget({ chatId }, env);
    }
    if (!target) return null;
    targetSource ||= tenantRoute ? (tenantRoute.targetSource || "tenant_route") : "legacy_env_forward_map";
    routeMode ||= tenantRoute?.routeMode || (tenantRoute ? "managed" : "legacy_env");
    deliveryTenantRoute = targetSource === "security_approval_forward" ? null : tenantRoute;
    await appendEvent({
      type: "whatsapp_local_inbound_forward_route_resolved",
      chatId,
      eventId: String(input.eventId || input.id || input.messageId || ""),
      target,
      targetSource,
      routeMode,
      tenantVmId: deliveryTenantRoute?.tenantVmId || null,
    }, env).catch(() => {});
    await recordRouterTraceEvent({
      routerTraceId: trace.routerTraceId,
      turnId: trace.turnId,
      connector: "whatsapp",
      accountId: trace.accountId,
      chatId,
      sourceEventId: trace.eventId,
      phase: "delivery_started",
      reason: "broker_forward",
      ownerProcess: deliveryTenantRoute?.tenantVmId || targetSource,
    }, env).catch(() => null);
    if (inboundForwardHealthGateEnabled({ tenantRoute: deliveryTenantRoute }, env)) {
      await assertInboundForwardTargetHealthy(target, deliveryTenantRoute, env, fetchImpl);
    }
    const headers = { "content-type": "application/json" };
    const token = targetSource === "security_approval_forward"
      ? localWhatsAppSecurityApprovalForwardToken({ chatId, target }, env)
      : deliveryTenantRoute?.token || (
        localWhatsAppInboundForwardToken({ chatId }, env)
      );
    if (token) headers.authorization = `Bearer ${token}`;
    let body = deliveryTenantRoute?.chatName && !input.displayName && !input.chatName
      ? { ...input, displayName: deliveryTenantRoute.chatName, chatName: deliveryTenantRoute.chatName }
      : input;
    const forwardedMedia = targetSource === "security_approval_forward"
      ? { attachments: Array.isArray(body.attachments) ? body.attachments : [], uploaded: 0 }
      : await prepareInboundMediaForward({
        input: body,
        target,
        token,
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        tenantRoute: deliveryTenantRoute,
        env,
        fetchImpl,
      });
    if (forwardedMedia.uploaded) {
      body = {
        ...body,
        attachments: forwardedMedia.attachments,
        attachmentsUploadedToTarget: true,
        attachmentUploadTarget: forwardedMedia.target || "",
      };
    }
    const response = await fetchImpl(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.WHATSAPP_INBOUND_FORWARD_TIMEOUT_MS || 60_000)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const code = targetInboundFailureCode(payload, response.status);
      const safeMessage = targetInboundFailureSafeMessage(code, response.status);
      const error = new Error(code);
      error.statusCode = response.status || 502;
      error.payload = payload;
      error.routingFailure = normalizeRoutingFailure({
        ...(payload?.routingFailure && typeof payload.routingFailure === "object" ? payload.routingFailure : {}),
        code,
        safeMessage,
        setupUrl: targetInboundFailureSetupUrl({ payload, tenantRoute: deliveryTenantRoute, chatId, env }),
      }, {
        code,
        capability: "whatsapp",
        provider: "whatsapp",
        userFacingCategory: targetInboundFailureCategory(code, response.status),
        target,
        instanceId: deliveryTenantRoute?.tenantVmId || "",
        retryable: response.status >= 500,
        reason: code,
        safeMessage,
        setupUrl: targetInboundFailureSetupUrl({ payload, tenantRoute: deliveryTenantRoute, chatId, env }),
      });
      throw error;
    }
    await appendEvent({
      type: "whatsapp_local_inbound_forwarded",
      chatId,
      eventId: String(input.eventId || input.id || input.messageId || ""),
      target,
      targetSource,
      routeMode,
      tenantVmId: deliveryTenantRoute?.tenantVmId || null,
      status: response.status,
      threadId: payload.threadId || null,
      agentId: payload.agentId || null,
      messageId: payload.messageId || null,
    }, env).catch(() => {});
    await rememberInboundForwardLedgerEntry(input, {
      target,
      tenantVmId: deliveryTenantRoute?.tenantVmId || null,
      threadId: payload.threadId || null,
      messageId: payload.messageId || null,
      duplicate: payload?.duplicate === true,
    }, env).catch(() => {});
    await recordRouterTraceEvent({
      routerTraceId: trace.routerTraceId,
      turnId: trace.turnId,
      connector: "whatsapp",
      accountId: trace.accountId,
      chatId,
      sourceEventId: trace.eventId,
      threadId: payload.threadId || "",
      messageId: payload.messageId || "",
      phase: "routed",
      reason: "forwarded_to_target",
      ownerProcess: deliveryTenantRoute?.tenantVmId || targetSource,
    }, env).catch(() => null);
    return { forwarded: true, target, targetSource, routeMode, payload };
  } catch (error) {
    const wrapped = error?.routingFailure ? error : attachRoutingFailure(new Error("whatsapp_inbound_forward_failed"), {
      code: "whatsapp_inbound_forward_failed",
      userFacingCategory: "instance_health",
      capability: "whatsapp",
      target,
      instanceId: deliveryTenantRoute?.tenantVmId || "",
      retryable: true,
      reason: String(error?.message || error || "forward_failed"),
    });
    if (!wrapped.statusCode) wrapped.statusCode = error?.statusCode || 502;
    if (wrapped !== error) {
      wrapped.cause = error;
      if (error?.payload) wrapped.payload = error.payload;
    }
    const failure = routingFailureFromError(wrapped, {
      code: "whatsapp_inbound_forward_failed",
      target,
      instanceId: deliveryTenantRoute?.tenantVmId || "",
      retryable: true,
      reason: String(error?.message || error || "forward_failed"),
    });
    await appendEvent({
      type: "whatsapp_local_inbound_forward_failed",
      chatId,
      eventId: String(input.eventId || input.id || input.messageId || ""),
      target: failure.target || target,
      targetSource,
      routeMode,
      tenantVmId: deliveryTenantRoute?.tenantVmId || failure.instanceId || null,
      code: failure.code,
      reason: failure.reason,
      retryable: failure.retryable,
    }, env).catch(() => {});
    if (target) {
      await recordRouterTraceEvent({
        routerTraceId: trace.routerTraceId,
        turnId: trace.turnId,
        connector: "whatsapp",
        accountId: trace.accountId,
        chatId,
        sourceEventId: trace.eventId,
        phase: "runtime_failed",
        reason: failure.code,
        error: failure.safeMessage || failure.reason,
        retryable: failure.retryable,
        ownerProcess: deliveryTenantRoute?.tenantVmId || targetSource,
        terminal: failure.retryable === false,
      }, env).catch(() => null);
    }
    throw wrapped;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

export function transientLocalWhatsAppSendError(error) {
  const message = String(error?.message || error || "");
  return /Promise was collected|Runtime\.callFunctionOn|Execution context was destroyed|Target closed|whatsapp_send_not_confirmed/i.test(message);
}

function sendOperationTimeoutMs(env = process.env, overrideMs = null) {
  const parsed = Number(overrideMs || env.ORKESTR_WHATSAPP_SEND_OPERATION_TIMEOUT_MS || env.WA_SEND_OPERATION_TIMEOUT_MS || 20_000);
  return Number.isFinite(parsed) ? Math.max(500, parsed) : 20_000;
}

function isSendOperationTimeout(error) {
  return String(error?.message || error || "").includes("whatsapp_send_") &&
    String(error?.message || error || "").includes("_timeout");
}

function withSendOperationTimeout(promise, label, env = process.env, overrideMs = null) {
  const timeoutMs = sendOperationTimeoutMs(env, overrideMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label}_timeout`);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function serializedMessageId(message = {}) {
  return String(message?.id?._serialized || message?.id || "");
}

function pairingCodeRequestError(error) {
  const text = [
    error?.stack,
    error?.message,
    String(error || ""),
  ].filter(Boolean).join("\n");
  return text.includes("Client.requestPairingCode") || text.includes("requestPairingCode");
}

function sentMessageText(message = {}) {
  return String(message?.body || message?.text || message?.caption || "");
}

function disabledEnvValue(value) {
  return ["0", "false", "off", "no", "disabled"].includes(String(value || "").trim().toLowerCase());
}

function sendConfirmationRequired(env = process.env) {
  return !disabledEnvValue(env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED || env.WA_SEND_CONFIRMATION_REQUIRED);
}

function sendConfirmationAttempts(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS || env.WA_SEND_CONFIRMATION_ATTEMPTS || 4);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 4;
}

function sendConfirmationDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS || env.WA_SEND_CONFIRMATION_DELAY_MS || 750);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 750;
}

function messageTimestampMs(message = {}) {
  const seconds = Number(message?.timestamp || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function recentOwnTextMessage(client, chatId, text, options = {}) {
  if (!client || !chatId || !String(text || "")) return null;
  const chat = await client.getChatById(chatId).catch(() => null);
  if (!chat || typeof chat.fetchMessages !== "function") return null;
  const messages = await chat.fetchMessages({ limit: 20 }).catch(() => []);
  const sinceMs = Number(options.sinceMs || 0);
  return [...(Array.isArray(messages) ? messages : [])].reverse().find((message) =>
    Boolean(message?.fromMe) &&
    sentMessageText(message) === text &&
    (!sinceMs || !messageTimestampMs(message) || messageTimestampMs(message) >= sinceMs)
  ) || null;
}

async function confirmRecentOwnTextMessage(client, chatId, text, env = process.env, options = {}) {
  const attempts = sendConfirmationAttempts(env);
  const delayMs = sendConfirmationDelayMs(env);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const confirmed = await recentOwnTextMessage(client, chatId, text, options);
    if (confirmed) return confirmed;
    if (attempt < attempts && delayMs > 0) await wait(delayMs);
  }
  return null;
}

function unconfirmedSendError(chatId = "") {
  const error = new Error("whatsapp_send_not_confirmed");
  error.statusCode = 502;
  error.chatId = chatId;
  return error;
}

export async function sendWhatsAppTextWithConfirmation({
  client,
  chatId = "",
  text = "",
  maxAttempts = 2,
  retryDelayMs = 500,
  env = process.env,
  operationTimeoutMs = null,
} = {}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const sentAtMs = Date.now();
      const sentMessage = await withSendOperationTimeout(
        client.sendMessage(chatId, text),
        "whatsapp_send_message",
        env,
        operationTimeoutMs,
      );
      if (!sendConfirmationRequired(env)) return sentMessage;
      const confirmed = await withSendOperationTimeout(
        confirmRecentOwnTextMessage(client, chatId, text, env, { sinceMs: sentAtMs - 5000 }),
        "whatsapp_send_confirm",
        env,
        operationTimeoutMs,
      ).catch(() => null);
      if (confirmed) return confirmed;
      throw unconfirmedSendError(chatId);
    } catch (error) {
      lastError = error;
      if (!transientLocalWhatsAppSendError(error) && !isSendOperationTimeout(error)) throw error;
      const confirmed = await withSendOperationTimeout(
        confirmRecentOwnTextMessage(client, chatId, text, env),
        "whatsapp_send_confirm",
        env,
        operationTimeoutMs,
      ).catch(() => null);
      if (confirmed) return confirmed;
      if (isSendOperationTimeout(error)) throw error;
      if (attempt >= attempts) throw error;
      await wait(retryDelayMs);
    }
  }
  throw lastError || new Error("whatsapp_send_failed");
}

function normalizePairingPhoneNumber(phoneNumber = "") {
  return String(phoneNumber || "").replace(/\D+/g, "").trim();
}

export function normalizeGroupParticipantIds(participantIds = []) {
  const values = Array.isArray(participantIds)
    ? participantIds
    : String(participantIds || "").split(/[\s,]+/g);
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    const digits = raw.replace(/\D+/g, "");
    const id = raw && !raw.includes("@") && digits ? `${digits}@c.us` : raw;
    const comparable = id.toLowerCase();
    if (!id || seen.has(comparable)) continue;
    seen.add(comparable);
    normalized.push(id);
  }
  return normalized;
}

function maskPairingPhoneNumber(phoneNumber = "") {
  const normalized = normalizePairingPhoneNumber(phoneNumber);
  if (!normalized) return "";
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

function bridgeRoot(env = process.env) {
  return path.join(dataPaths(env).home, "whatsapp-bridge");
}

function qrPath(accountId, env = process.env) {
  return path.join(bridgeRoot(env), "qrs", `${accountId}.svg`);
}

function sessionRoot(env = process.env) {
  return path.join(bridgeRoot(env), "sessions");
}

function inboundMediaRoot(env = process.env) {
  return path.join(bridgeRoot(env), "inbound-media");
}

export function webCacheRoot(env = process.env) {
  return path.join(bridgeRoot(env), "web-cache");
}

async function ensureBridgeDirs(env = process.env) {
  await ensureDataDirs(env);
  await fs.mkdir(path.join(bridgeRoot(env), "qrs"), { recursive: true });
  await fs.mkdir(sessionRoot(env), { recursive: true });
  await fs.mkdir(inboundMediaRoot(env), { recursive: true });
  await fs.mkdir(webCacheRoot(env), { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function qrUrl(accountId) {
  return `${localWhatsAppBridgeBasePath}/qr.svg?accountId=${encodeURIComponent(accountId)}`;
}

function defaultAccountState(accountId) {
  return {
    accountId,
    label: accountLabel(accountId),
    state: "idle",
    ready: false,
    authenticated: false,
    started: false,
    qrAvailable: false,
    qrUrl: "",
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: "",
    phoneNumber: "",
    contactId: "",
    pushName: "",
    authenticatedAt: null,
    loadingPercent: null,
    loadingMessage: "",
    waState: "",
    error: "",
    lastRecoveryReason: "",
    lastRecoveryAt: null,
    recoveredChromeLocks: 0,
    recoveredChromeProcesses: 0,
    updatedAt: null,
  };
}

function setAccountState(accountId, patch) {
  const current = accountStates.get(accountId) || defaultAccountState(accountId);
  const next = {
    ...current,
    ...patch,
    accountId,
    label: accountLabel(accountId),
    updatedAt: nowIso(),
  };
  accountStates.set(accountId, next);
  return next;
}

async function accountSnapshot(accountId, env = process.env) {
  const state = accountStates.get(accountId) || defaultAccountState(accountId);
  const runtime = runtimes.get(accountId);
  const hasClient = Boolean(runtime?.client);
  const staleReadyRuntime = Boolean(state.ready && !hasClient);
  const ready = Boolean(state.ready && hasClient);
  const accountState = staleReadyRuntime ? "stale_runtime" : state.state;
  const qrAvailable = Boolean(state.qrAvailable || (await exists(qrPath(accountId, env))));
  return {
    ...state,
    state: accountState,
    ready,
    error: staleReadyRuntime ? "whatsapp_local_runtime_missing" : state.error,
    clientId: clientIdForAccount(accountId, env),
    sessionRoot: sessionRootForAccount(accountId, env),
    localAuthSessionDir: localAuthSessionDirForAccount(accountId, env),
    sessionRootAlreadyIncludesClient: sessionRootAlreadyIncludesClient(accountId, env),
    qrAvailable,
    qrUrl: qrAvailable ? qrUrl(accountId) : "",
    started: Boolean(state.started || runtimes.has(accountId)),
  };
}

export function reduceLocalWhatsAppBridgeState(accounts) {
  if (accounts.some((account) => account.ready)) return "ready";
  if (accounts.some((account) => account.pairingCode || account.state === "pairing_code")) return "pairing_code";
  if (accounts.some((account) => account.qrAvailable)) return "qr_needed";
  if (accounts.some((account) => account.state === "starting")) return "starting";
  if (accounts.some((account) => ["startup_timeout", "auth_failure", "auth_ready_timeout", "dependency_missing", "failed", "stale_runtime"].includes(account.state))) return "failed";
  if (accounts.some((account) => account.authenticated || account.state === "authenticated")) return "authenticated";
  if (accounts.some((account) => account.state === "disconnected")) return "disconnected";
  return "idle";
}

function isGroupChatId(chatId) {
  return /@g\.us$/i.test(String(chatId || "").trim());
}

function localAccountMatches(accountId, selectedAccountId, env = process.env) {
  const account = String(accountId || "").trim();
  if (!account) return true;
  return account === selectedAccountId;
}

function addChat(target, chat) {
  const id = String(chat?.id || "").trim();
  if (!id) return;
  const existing = target.get(id) || {};
  target.set(id, {
    ...existing,
    ...chat,
    id,
    name: String(chat.name || existing.name || id).trim(),
    isGroup: Boolean(chat.isGroup ?? existing.isGroup ?? isGroupChatId(id)),
    unreadCount: Number(chat.unreadCount ?? existing.unreadCount ?? 0) || 0,
    timestamp: chat.timestamp || existing.timestamp || null,
  });
}

function rememberOutboundMessageId(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return;
  outboundMessageIds.add(id);
  if (outboundMessageIds.size > 500) {
    const [oldest] = outboundMessageIds;
    outboundMessageIds.delete(oldest);
  }
}

function outboundEchoTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_OUTBOUND_ECHO_TTL_MS || 30 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(60_000, Math.floor(parsed)) : 30 * 60 * 1000;
}

function textKey(accountId, chatId, text) {
  return `${String(accountId || "").trim()}:${String(chatId || "").trim()}:${String(text || "").replace(/\s+/g, " ").trim()}`;
}

function anyAccountTextKey(chatId, text) {
  return textKey("*", chatId, text);
}

function pruneOutboundTextKeys(env = process.env) {
  const cutoff = Date.now() - outboundEchoTtlMs(env);
  for (const [key, rememberedAt] of outboundMessageTextKeys.entries()) {
    if (Number(rememberedAt || 0) < cutoff) outboundMessageTextKeys.delete(key);
  }
  const rawLimit = Number(env.ORKESTR_WHATSAPP_OUTBOUND_ECHO_TEXT_LIMIT || 5000);
  const limit = Number.isFinite(rawLimit) ? Math.max(500, Math.floor(rawLimit)) : 5000;
  while (outboundMessageTextKeys.size > limit) {
    const [oldest] = outboundMessageTextKeys.keys();
    outboundMessageTextKeys.delete(oldest);
  }
}

function rememberOutboundTextKey(key, env = process.env) {
  if (!key || key.endsWith(":")) return;
  outboundMessageTextKeys.set(key, Date.now());
  pruneOutboundTextKeys(env);
}

function rememberOutboundText(accountId, chatId, text, env = process.env, options = {}) {
  rememberOutboundTextKey(textKey(accountId, chatId, text), env);
  const crossAccountKey = anyAccountTextKey(chatId, text);
  if (options.crossAccount === false) outboundMessageTextKeys.delete(crossAccountKey);
  else rememberOutboundTextKey(crossAccountKey, env);
}

function outboundTextRecentlySent(accountId, chatId, text, env = process.env) {
  pruneOutboundTextKeys(env);
  const accountKey = textKey(accountId, chatId, text);
  const chatKey = anyAccountTextKey(chatId, text);
  return Boolean((accountKey && outboundMessageTextKeys.has(accountKey)) || (chatKey && outboundMessageTextKeys.has(chatKey)));
}

function pruneOutboundAttachmentKeys(env = process.env) {
  const cutoff = Date.now() - outboundEchoTtlMs(env);
  for (const [key, rememberedAt] of outboundAttachmentKeys.entries()) {
    if (Number(rememberedAt || 0) < cutoff) outboundAttachmentKeys.delete(key);
  }
  for (const [key, rememberedAt] of outboundAttachmentSizeKeys.entries()) {
    if (Number(rememberedAt || 0) < cutoff) outboundAttachmentSizeKeys.delete(key);
  }
  while (outboundAttachmentKeys.size > 500) {
    const [oldest] = outboundAttachmentKeys.keys();
    outboundAttachmentKeys.delete(oldest);
  }
  while (outboundAttachmentSizeKeys.size > 500) {
    const [oldest] = outboundAttachmentSizeKeys.keys();
    outboundAttachmentSizeKeys.delete(oldest);
  }
}

function attachmentEchoFilename(attachment = {}) {
  return path.basename(String(attachment.filename || attachment.path || "").trim());
}

function attachmentEchoKey(accountId, chatId, attachment = {}) {
  const filename = attachmentEchoFilename(attachment);
  if (!filename) return "";
  return [
    String(accountId || "").trim(),
    String(chatId || "").trim(),
    filename,
  ].join(":");
}

function anyAccountAttachmentEchoKey(chatId, attachment = {}) {
  return attachmentEchoKey("*", chatId, attachment);
}

function attachmentEchoSizeKey(accountId, chatId, attachment = {}) {
  const size = Number(attachment.size);
  if (!Number.isFinite(size) || size <= 0) return "";
  return [
    String(accountId || "").trim(),
    String(chatId || "").trim(),
    Math.floor(size),
  ].join(":");
}

function rememberOutboundAttachment(accountId, chatId, attachment = {}, env = process.env, options = {}) {
  const key = attachmentEchoKey(accountId, chatId, attachment);
  const crossAccountKey = anyAccountAttachmentEchoKey(chatId, attachment);
  const sizeKey = attachmentEchoSizeKey(accountId, chatId, attachment);
  const rememberedAt = Date.now();
  if (key && !key.endsWith("::")) outboundAttachmentKeys.set(key, rememberedAt);
  if (options.crossAccount === false) outboundAttachmentKeys.delete(crossAccountKey);
  else if (crossAccountKey && !crossAccountKey.endsWith("::")) outboundAttachmentKeys.set(crossAccountKey, rememberedAt);
  if (sizeKey && !sizeKey.endsWith("::")) outboundAttachmentSizeKeys.set(sizeKey, rememberedAt);
  pruneOutboundAttachmentKeys(env);
}

function outboundAttachmentsRecentlySent(accountId, chatId, attachments = [], env = process.env, options = {}) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (!items.length) return false;
  pruneOutboundAttachmentKeys(env);
  return items.every((attachment) => {
    const key = attachmentEchoKey(accountId, chatId, attachment);
    if (key && outboundAttachmentKeys.has(key)) return true;
    const chatKey = anyAccountAttachmentEchoKey(chatId, attachment);
    if (chatKey && outboundAttachmentKeys.has(chatKey)) return true;
    const sizeKey = attachmentEchoSizeKey(accountId, chatId, attachment);
    return Boolean(options.allowSizeOnly && sizeKey && outboundAttachmentSizeKeys.has(sizeKey));
  });
}

function inboundAttachmentEchoCandidates(message = {}) {
  const body = String(message.body || "").trim();
  const names = [
    message.filename,
    message.fileName,
    message._data?.filename,
    message._data?.fileName,
    message.rawData?.filename,
    message.mediaData?.filename,
    message.hasMedia || message.type === "document" ? body : "",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const seen = new Set();
  return names
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((filename) => ({ filename }));
}

function rememberInboundFailureNotice(accountId, eventId) {
  const key = `${String(accountId || "").trim()}:${String(eventId || "").trim()}`;
  if (!key.endsWith(":")) inboundFailureNoticeKeys.add(key);
  if (inboundFailureNoticeKeys.size > 500) {
    const [oldest] = inboundFailureNoticeKeys;
    inboundFailureNoticeKeys.delete(oldest);
  }
  return key;
}

function hasInboundFailureNotice(accountId, eventId) {
  const key = `${String(accountId || "").trim()}:${String(eventId || "").trim()}`;
  return Boolean(key.trim() && inboundFailureNoticeKeys.has(key));
}

function serializedId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value._serialized || value.user || value.id || "").trim();
}

function runtimeAccountIdentity(runtime = {}) {
  const info = runtime?.client?.info || {};
  const wid = info.wid || info.me || {};
  const contactId = serializedId(wid);
  const user = String(wid?.user || "").replace(/\D+/g, "").trim();
  const server = String(wid?.server || "").trim().toLowerCase();
  const phoneNumber = user && (server === "c.us" || /@c\.us$/i.test(contactId)) ? `+${user}` : "";
  return {
    phoneNumber,
    contactId,
    pushName: String(info.pushname || info.pushName || info.name || "").trim(),
  };
}

function runtimeIdentity(runtime) {
  return serializedId(runtime?.client?.info?.wid || runtime?.client?.info?.me);
}

export function localWhatsAppMessageRouteFields(message = {}) {
  const fromMe = Boolean(message?.fromMe);
  const remote = serializedId(message?.id?.remote);
  const chatId = String(fromMe
    ? (message?.to || remote || message?.from || "")
    : (message?.from || remote || message?.to || "")
  ).trim();
  const from = String(message?.author || message?.from || "").trim();
  return { chatId, from, fromMe };
}

function groupIdFromCreateResult(result) {
  return serializedId(result?.gid || result?.id || result?.chatId || result?.groupId);
}

async function knownLocalWhatsAppChats(accountId, env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const known = new Map();
  const eligibleChatIds = new Set();
  const suppressedChatIds = new Set();
  const threads = await listThreads(env).catch(() => []);
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [...whatsappBindingAccountIds(binding)];
    if (!chatId || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId, env)))) continue;
    if (whatsappBindingIsRouteEligible(binding)) eligibleChatIds.add(chatId);
  }
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [...whatsappBindingAccountIds(binding)];
    if (!chatId || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId, env)))) continue;
    if (!whatsappBindingIsRouteEligible(binding)) {
      if (!eligibleChatIds.has(chatId)) suppressedChatIds.add(chatId);
      continue;
    }
    addChat(known, {
      id: chatId,
      name: String(binding.displayName || thread.bindingName || thread.name || thread.title || chatId).trim(),
      isGroup: isGroupChatId(chatId),
      unreadCount: 0,
      timestamp: binding.updatedAt || thread.updatedAt || thread.createdAt || null,
      source: "thread_binding",
      threadId: thread.id,
      accountId: String(binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || selectedAccountId).trim(),
    });
  }
  const state = await readJson(dataPaths(env).whatsapp, { inboundEvents: [], outboundDeliveries: [] }).catch(() => ({ inboundEvents: [], outboundDeliveries: [] }));
  for (const event of state.inboundEvents || []) {
    const chatId = String(event?.chatId || "").trim();
    if (suppressedChatIds.has(chatId)) continue;
    if (!chatId || !localAccountMatches(event.accountId, selectedAccountId, env)) continue;
    addChat(known, {
      id: chatId,
      name: String(event.chatName || event.displayName || event.chatId || chatId).trim(),
      isGroup: isGroupChatId(chatId),
      timestamp: event.receivedAt || event.createdAt || null,
      source: "inbound_event",
      accountId: String(event.accountId || selectedAccountId).trim(),
    });
  }
  for (const delivery of state.outboundDeliveries || []) {
    const chatId = String(delivery?.chatId || "").trim();
    if (suppressedChatIds.has(chatId)) continue;
    if (!chatId || !localAccountMatches(delivery.accountId, selectedAccountId, env)) continue;
    addChat(known, {
      id: chatId,
      name: chatId,
      isGroup: isGroupChatId(chatId),
      timestamp: delivery.deliveredAt || null,
      source: "outbound_delivery",
      accountId: String(delivery.accountId || selectedAccountId).trim(),
    });
  }
  return [...known.values()].sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: "base" }),
  );
}

async function suppressedLocalWhatsAppChatIds(accountId, env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const threads = await listThreads(env).catch(() => []);
  const eligibleChatIds = new Set();
  const suppressed = new Set();
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [...whatsappBindingAccountIds(binding)];
    if (!chatId || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId, env)))) continue;
    if (whatsappBindingIsRouteEligible(binding)) eligibleChatIds.add(chatId);
  }
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    if (whatsappBindingIsRouteEligible(binding)) continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [...whatsappBindingAccountIds(binding)];
    if (!chatId || eligibleChatIds.has(chatId) || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId, env)))) continue;
    suppressed.add(chatId);
  }
  return suppressed;
}

export async function getLocalWhatsAppBridgeStatus(env = process.env) {
  const accountIds = await managedLocalWhatsAppAccountIds(env);
  const accounts = await Promise.all(accountIds.map((accountId) => accountSnapshot(accountId, env)));
  const state = reduceLocalWhatsAppBridgeState(accounts);
  const qrAccount = accounts.find((account) => account.qrAvailable);
  const activeTyping = [...typingSessions.values()].map((session) => ({
    accountId: session.accountId,
    chatId: session.chatId,
    startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
    lastSyncedAt: session.lastSyncedAt ? new Date(session.lastSyncedAt).toISOString() : null,
  }));
  return {
    ok: true,
    mode: "local",
    state,
    ready: state === "ready",
    clientReady: state === "ready",
    authenticated: accounts.some((account) => account.authenticated || account.ready),
    qrAvailable: Boolean(qrAccount),
    qrUrl: qrAccount?.qrUrl || "",
    maxAccounts: accountIds.length,
    accounts,
    activeTypingCount: activeTyping.length,
    activeTyping,
  };
}

async function loadBridgeDependencies() {
  const [whatsappModule, qrcodeModule] = await Promise.all([
    import("whatsapp-web.js"),
    import("qrcode"),
  ]);
  return {
    whatsapp: whatsappModule.default || whatsappModule,
    qrcode: qrcodeModule.default || qrcodeModule,
  };
}

function puppeteerOptions(env = process.env) {
  const executablePath = String(env.WA_CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  const protocolTimeout = puppeteerProtocolTimeoutMs(env);
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    protocolTimeout,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  };
}

function whatsappUserAgent(env = process.env) {
  return String(
    env.WA_USER_AGENT ||
    env.WHATSAPP_USER_AGENT ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  ).trim();
}

function typingRefreshMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_REFRESH_MS || env.WA_TYPING_REFRESH_MS || 8000);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : 8000;
}

function typingOperationTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS || env.WA_TYPING_OPERATION_TIMEOUT_MS || 2500);
  return Number.isFinite(parsed) ? Math.max(500, parsed) : 2500;
}

function typingMaxTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_MAX_TTL_MS || env.WA_TYPING_MAX_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 120_000;
}

function typingStopGraceMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS || env.WA_TYPING_STOP_GRACE_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 10_000;
}

function typingRefreshFailureLimit(env = process.env) {
  const parsed = Number(
    env.ORKESTR_WHATSAPP_TYPING_REFRESH_FAILURE_LIMIT ||
    env.WA_TYPING_REFRESH_FAILURE_LIMIT ||
    env.ORKESTR_WHATSAPP_TYPING_MAX_REFRESH_FAILURES ||
    env.WA_TYPING_MAX_REFRESH_FAILURES ||
    3,
  );
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 3;
}

export function localWhatsAppTypingClearRetryDelaysMs(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS || env.WA_TYPING_CLEAR_RETRY_MS || "750,2500,8000").trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "off") return [];
  const delays = raw
    .split(/[\s,]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0 && item <= 60_000);
  return [...new Set(delays)];
}

function typingKey(accountId, chatId) {
  return `${String(accountId || "").trim()}:${String(chatId || "").trim()}`;
}

function clearTypingSessionTimers(session) {
  if (!session) return;
  if (session.interval) clearInterval(session.interval);
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  session.interval = null;
  session.ttlTimer = null;
  session.closed = true;
}

function withTypingOperationTimeout(promise, label = "typing_operation", env = process.env) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), typingOperationTimeoutMs(env));
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

async function directChatstate(runtime, chatId, state, env = process.env) {
  const page = runtime?.client?.pupPage;
  if (!page || typeof page.evaluate !== "function") return false;
  await withTypingOperationTimeout(
    page.evaluate((targetChatId, targetState) => {
      if (!window?.WWebJS?.sendChatstate) {
        throw new Error("sendChatstate_unavailable");
      }
      return window.WWebJS.sendChatstate(targetState, targetChatId);
    }, chatId, state),
    `typing_${state}_direct`,
    env,
  );
  return true;
}

function clearTypingClearRetryTimers(key) {
  for (const timer of typingClearRetryTimers.get(key) || []) clearTimeout(timer);
  typingClearRetryTimers.delete(key);
}

function clearAccountTypingStartPromises(accountId = "") {
  const prefix = `${String(accountId || "").trim()}:`;
  for (const key of [...typingStartPromises.keys()].filter((item) => item.startsWith(prefix))) {
    typingStartPromises.delete(key);
  }
}

function armTypingSessionTtl(session, key, env = process.env) {
  if (!session) return;
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  session.lastSyncedAt = Date.now();
  const ttlMs = typingMaxTtlMs(env);
  const timer = setTimeout(() => {
    const current = typingSessions.get(key);
    if (!current || current !== session) return;
    const ageMs = Date.now() - Number(current.lastSyncedAt || 0);
    if (ageMs < ttlMs) {
      armTypingSessionTtl(current, key, env);
      return;
    }
    stopLocalWhatsAppTyping({ accountId: current.accountId, chatId: current.chatId, env })
      .then(() => appendEvent({ type: "whatsapp_local_typing_ttl_expired", accountId: current.accountId, chatId: current.chatId, ttlMs }, env).catch(() => {}))
      .catch((error) => appendEvent({ type: "whatsapp_local_typing_ttl_expire_failed", accountId: current.accountId, chatId: current.chatId, ttlMs, error: error.message || String(error) }, env).catch(() => {}));
  }, ttlMs);
  if (typeof timer.unref === "function") timer.unref();
  session.ttlTimer = timer;
}

async function refreshTypingSession(session, key, runtime, env = process.env) {
  if (!session || typingSessions.get(key) !== session) {
    clearTypingSessionTimers(session);
    return;
  }
  if (session.refreshInFlight) return;
  session.refreshInFlight = true;
  try {
    await sendChatTypingState(runtime, session.chatId, true, env);
    session.refreshFailureCount = 0;
    session.lastSyncedAt = Date.now();
    armTypingSessionTtl(session, key, env);
  } catch (error) {
    session.refreshFailureCount = Number(session.refreshFailureCount || 0) + 1;
    await appendEvent({
      type: "whatsapp_local_typing_refresh_failed",
      accountId: session.accountId,
      chatId: session.chatId,
      error: error.message || String(error),
      failureCount: session.refreshFailureCount,
    }, env).catch(() => {});
    if (session.refreshFailureCount >= typingRefreshFailureLimit(env) && typingSessions.get(key) === session) {
      await appendEvent({
        type: "whatsapp_local_typing_refresh_exhausted",
        accountId: session.accountId,
        chatId: session.chatId,
        failureCount: session.refreshFailureCount,
      }, env).catch(() => {});
      await stopLocalWhatsAppTyping({ accountId: session.accountId, chatId: session.chatId, env }).catch(() => {});
    }
  } finally {
    session.refreshInFlight = false;
  }
}

async function sendChatTypingState(runtime, chatId, active, env = process.env) {
  if (!active) {
    await clearLocalWhatsAppChatTypingState(runtime, chatId, env);
    return;
  }
  const chat = await withTypingOperationTimeout(runtime.client.getChatById(chatId), "typing_get_chat", env);
  await runtime.client.sendPresenceAvailable?.().catch(() => {});
  try {
    await withTypingOperationTimeout(chat.sendStateTyping(), "typing_send_state", env);
  } catch (error) {
    if (!(await directChatstate(runtime, chatId, "typing", env).catch(() => false))) throw error;
  }
}

export async function clearLocalWhatsAppChatTypingState(runtime, chatId, env = process.env) {
  const id = String(chatId || "").trim();
  if (!runtime?.client || !id) return { ok: false, chatApiOk: false, directOk: false, reason: !id ? "missing_chat_id" : "missing_client" };
  const chat = await withTypingOperationTimeout(runtime.client.getChatById(id), "typing_get_chat", env);
  let chatApiOk = false;
  let directOk = false;
  let chatApiError = "";
  let directError = "";
  if (typeof chat?.clearState === "function") {
    try {
      await withTypingOperationTimeout(chat.clearState(), "typing_clear_state", env);
      chatApiOk = true;
    } catch (error) {
      chatApiError = error?.message || String(error);
    }
  }
  try {
    directOk = await directChatstate(runtime, id, "stop", env);
  } catch (error) {
    directError = error?.message || String(error);
  }
  if (!chatApiOk && !directOk) {
    const error = new Error(directError || chatApiError || "typing_clear_failed");
    error.chatApiError = chatApiError;
    error.directError = directError;
    throw error;
  }
  return { ok: true, chatApiOk, directOk };
}

function scheduleTypingClearRetries({ accountId = "", chatId = "", env = process.env } = {}) {
  const selectedAccountId = String(accountId || "").trim();
  const id = String(chatId || "").trim();
  if (!selectedAccountId || !id) return;
  const key = typingKey(selectedAccountId, id);
  const delays = localWhatsAppTypingClearRetryDelaysMs(env);
  clearTypingClearRetryTimers(key);
  if (!delays.length) return;
  const timers = delays.map((delayMs) => {
    const timer = setTimeout(() => {
      const remaining = (typingClearRetryTimers.get(key) || []).filter((item) => item !== timer);
      if (remaining.length) typingClearRetryTimers.set(key, remaining);
      else typingClearRetryTimers.delete(key);
      if (typingSessions.has(key)) return;
      const runtime = runtimes.get(selectedAccountId);
      const state = accountStates.get(selectedAccountId);
      if (!runtime?.client || !state?.ready) return;
      sendChatTypingState(runtime, id, false, env)
        .then(() => appendEvent({ type: "whatsapp_local_typing_clear_retry", accountId: selectedAccountId, chatId: id, delayMs }, env).catch(() => {}))
        .catch((error) => {
          appendEvent({ type: "whatsapp_local_typing_clear_retry_failed", accountId: selectedAccountId, chatId: id, delayMs, error: error.message || String(error) }, env).catch(() => {});
        });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  });
  typingClearRetryTimers.set(key, timers);
}

export async function startLocalWhatsAppTyping({ chatId = "", accountId = "", env = process.env } = {}) {
  const selectedAccountId = accountId
    ? normalizeAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const id = String(chatId || "").trim();
  const runtime = selectedAccountId ? runtimes.get(selectedAccountId) : null;
  const state = selectedAccountId ? accountStates.get(selectedAccountId) : null;
  if (!id || !runtime?.client || !state?.ready) return { ok: false, reason: !id ? "missing_chat_id" : "whatsapp_local_bridge_not_ready" };
  const key = typingKey(selectedAccountId, id);
  const inFlight = typingStartPromises.get(key);
  if (inFlight) {
    const result = await inFlight;
    return { ...result, reused: true };
  }
  if (typingSessions.has(key)) {
    armTypingSessionTtl(typingSessions.get(key), key, env);
    return { ok: true, active: true, reused: true, accountId: selectedAccountId, chatId: id };
  }
  const startPromise = (async () => {
    clearTypingClearRetryTimers(key);
    const session = {
      accountId: selectedAccountId,
      chatId: id,
      interval: null,
      startedAt: Date.now(),
      lastSyncedAt: Date.now(),
      ttlTimer: null,
      generation: ++typingSessionGeneration,
      refreshFailureCount: 0,
      refreshInFlight: false,
      closed: false,
    };
    typingSessions.set(key, session);
    try {
      await sendChatTypingState(runtime, id, true, env);
    } catch (error) {
      if (typingSessions.get(key) === session) typingSessions.delete(key);
      clearTypingSessionTimers(session);
      throw error;
    }
    const currentSession = typingSessions.get(key);
    if (currentSession !== session) {
      clearTypingSessionTimers(session);
      if (!currentSession) {
        await sendChatTypingState(runtime, id, false, env).catch((error) => {
          appendEvent({ type: "whatsapp_local_typing_clear_failed", accountId: selectedAccountId, chatId: id, error: error.message || String(error) }, env).catch(() => {});
        });
      }
      return { ok: true, active: false, cancelled: true, reused: false, accountId: selectedAccountId, chatId: id };
    }
    const interval = setInterval(() => {
      void refreshTypingSession(session, key, runtime, env);
    }, typingRefreshMs(env));
    if (typeof interval.unref === "function") interval.unref();
    session.interval = interval;
    session.lastSyncedAt = Date.now();
    armTypingSessionTtl(session, key, env);
    await appendEvent({ type: "whatsapp_local_typing_started", accountId: selectedAccountId, chatId: id, generation: session.generation }, env).catch(() => {});
    return { ok: true, active: true, reused: false, accountId: selectedAccountId, chatId: id };
  })();
  typingStartPromises.set(key, startPromise);
  try {
    return await startPromise;
  } finally {
    if (typingStartPromises.get(key) === startPromise) typingStartPromises.delete(key);
  }
}

export async function stopLocalWhatsAppTyping({ chatId = "", accountId = "", env = process.env } = {}) {
  const selectedAccountId = accountId
    ? normalizeAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const id = String(chatId || "").trim();
  if (!selectedAccountId || !id) return { ok: false, reason: "missing_target" };
  const key = typingKey(selectedAccountId, id);
  const session = typingSessions.get(key);
  clearTypingSessionTimers(session);
  typingSessions.delete(key);
  const runtime = runtimes.get(selectedAccountId);
  const state = accountStates.get(selectedAccountId);
  if (runtime?.client && state?.ready) {
    await sendChatTypingState(runtime, id, false, env).catch((error) => {
      appendEvent({ type: "whatsapp_local_typing_clear_failed", accountId: selectedAccountId, chatId: id, error: error.message || String(error) }, env).catch(() => {});
    });
    scheduleTypingClearRetries({ accountId: selectedAccountId, chatId: id, env });
  }
  if (session) await appendEvent({ type: "whatsapp_local_typing_stopped", accountId: selectedAccountId, chatId: id }, env).catch(() => {});
  return { ok: true, active: false, accountId: selectedAccountId, chatId: id };
}

export async function syncLocalWhatsAppTypingTargets(targets = [], env = process.env) {
  const active = new Set();
  const started = [];
  const kept = [];
  const stopped = [];
  const now = Date.now();
  const stopGraceMs = typingStopGraceMs(env);
  for (const target of targets) {
    const chatId = String(target?.chatId || "").trim();
    if (!chatId) continue;
    let selectedAccountId = "";
    if (target?.accountId) {
      try {
        selectedAccountId = normalizeAccountId(target.accountId, env);
      } catch {
        selectedAccountId = "";
      }
    }
    selectedAccountId ||= localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready) || "";
    if (!selectedAccountId) continue;
    const result = await startLocalWhatsAppTyping({ accountId: selectedAccountId, chatId, env }).catch((error) => ({ ok: false, error: error.message || String(error) }));
    if (!result?.ok) continue;
    active.add(typingKey(result.accountId || selectedAccountId, chatId));
    if (result?.ok && !result.reused) started.push(result);
  }
  for (const session of [...typingSessions.values()]) {
    if (active.has(typingKey(session.accountId, session.chatId))) continue;
    const ageMs = now - Number(session.lastSyncedAt || session.startedAt || now);
    if (stopGraceMs > 0 && ageMs < stopGraceMs) {
      const key = typingKey(session.accountId, session.chatId);
      active.add(key);
      kept.push({ ok: true, active: true, accountId: session.accountId, chatId: session.chatId, graceMs: stopGraceMs, ageMs });
      continue;
    }
    const result = await stopLocalWhatsAppTyping({ accountId: session.accountId, chatId: session.chatId, env });
    if (result?.ok) stopped.push(result);
  }
  return { ok: true, active: active.size, started, kept, stopped };
}

export function setLocalWhatsAppRuntimeForTest(accountId = "", runtime = {}, statePatch = {}, env = process.env) {
  const normalized = normalizeAccountId(accountId, env);
  runtimes.set(normalized, runtime);
  setAccountState(normalized, {
    state: "ready",
    ready: true,
    authenticated: true,
    started: true,
    qrAvailable: false,
    error: "",
    ...runtimeAccountIdentity(runtime),
    ...statePatch,
  });
  return normalized;
}

export async function resetLocalWhatsAppBridgeForTest(env = process.env) {
  await stopLocalWhatsAppBridge(env).catch(() => {});
  accountStates.clear();
  outboundMessageIds.clear();
  outboundMessageTextKeys.clear();
  outboundAttachmentKeys.clear();
  inboundFailureNoticeKeys.clear();
  inboundForwardLedgerKeys.clear();
  typingStartPromises.clear();
  typingClearRetryTimers.clear();
  localWhatsAppStartPromises.clear();
  runtimeRecoveryHooksForTest = null;
}

export function setLocalWhatsAppRuntimeRecoveryHooksForTest(hooks = null) {
  runtimeRecoveryHooksForTest = hooks && typeof hooks === "object" ? hooks : null;
}

function authReadyTimeoutMs(env = process.env, options = {}) {
  const parsed = Number(options.authReadyTimeoutMs || env.WA_AUTH_READY_TIMEOUT_MS || env.WHATSAPP_AUTH_READY_TIMEOUT_MS || 180_000);
  return Number.isFinite(parsed) ? Math.max(30_000, parsed) : 180_000;
}

function startupTimeoutMs(env = process.env, options = {}) {
  const parsed = Number(options.startupTimeoutMs || env.WA_STARTUP_TIMEOUT_MS || env.WHATSAPP_STARTUP_TIMEOUT_MS || 90_000);
  return Number.isFinite(parsed) ? Math.max(100, parsed) : 90_000;
}

function puppeteerProtocolTimeoutMs(env = process.env) {
  const parsed = Number(env.WA_PUPPETEER_PROTOCOL_TIMEOUT_MS || env.WHATSAPP_PUPPETEER_PROTOCOL_TIMEOUT_MS || 300_000);
  return Number.isFinite(parsed) ? Math.max(30_000, parsed) : 300_000;
}

export function localWhatsAppReadyFallbackEligible(state = {}) {
  if (state.ready || !state.authenticated) return false;
  const percent = Number(state.loadingPercent ?? 0);
  if (percent >= 100) return true;
  const message = String(state.loadingMessage || "").trim().toLowerCase();
  return percent >= 99 && message === "whatsapp";
}

export function localWhatsAppConnectedPageReadyFallbackEligible(state = {}, page = {}) {
  if (state.ready) return false;
  const hasSynced = page.hasSynced === true || page.hasSynced === "function";
  if (!hasSynced) return false;
  const appState = String(page.appState || page.waState || "").trim().toUpperCase();
  return appState === "CONNECTED";
}

function connectedPageReadyFallbackDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_CONNECTED_READY_FALLBACK_MS || env.WHATSAPP_CONNECTED_READY_FALLBACK_MS || 15_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 15_000;
}

function connectedPageReadyFallbackAttempts(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_CONNECTED_READY_FALLBACK_ATTEMPTS || env.WHATSAPP_CONNECTED_READY_FALLBACK_ATTEMPTS || 8);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(24, Math.floor(parsed))) : 8;
}

function safeFilePart(value = "", fallback = "attachment") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function extensionForMime(mimetype = "") {
  const normalized = String(mimetype || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("pdf")) return ".pdf";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("mp4")) return ".mp4";
  if (normalized.includes("csv")) return ".csv";
  if (normalized.includes("json")) return ".json";
  if (normalized.includes("plain")) return ".txt";
  return ".bin";
}

async function saveInboundMedia(accountId, message, env = process.env) {
  if (!message?.hasMedia || typeof message.downloadMedia !== "function") return [];
  let media = null;
  try {
    media = await message.downloadMedia();
  } catch (error) {
    await appendEvent({
      type: "whatsapp_local_inbound_media_download_failed",
      accountId,
      eventId: String(message.id?._serialized || ""),
      error: error.message || String(error),
    }, env).catch(() => {});
    return [];
  }
  if (!media?.data) return [];
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(inboundMediaRoot(env), date);
  await fs.mkdir(outDir, { recursive: true });
  const eventId = safeFilePart(String(message.id?._serialized || `${accountId}-${Date.now()}`), "message");
  const originalName = safeFilePart(media.filename || message._data?.filename || "", "");
  const ext = path.extname(originalName) || extensionForMime(media.mimetype);
  const baseName = originalName
    ? `${eventId}-${originalName}`
    : `${eventId}-attachment${ext}`;
  const filePath = path.join(outDir, baseName);
  await fs.writeFile(filePath, Buffer.from(media.data, "base64"));
  return [{
    path: filePath,
    filename: originalName || path.basename(filePath),
    mimetype: media.mimetype || "",
    kind: message.type || "",
    size: Buffer.byteLength(media.data, "base64"),
  }];
}

function attachmentSummaryText(attachments = []) {
  if (!attachments.length) return "";
  return [
    "WhatsApp attachment received.",
    ...attachments.map((attachment, index) => [
      `Attachment ${index + 1}: ${attachment.path}`,
      attachment.filename ? `filename: ${attachment.filename}` : "",
      attachment.mimetype ? `mimetype: ${attachment.mimetype}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function publicHelpUrl(env = process.env) {
  const configured = [
    tenantPublicSetupUrl({}, env),
    publicTenantVmSetupUrl(env),
    env.ORKESTR_CONNECT_PUBLIC_SETUP_URL,
    env.ORKESTR_PAIRING_URL,
    env.ORKESTR_PUBLIC_AUTH_URL,
    env.ORKESTR_PUBLIC_SITE_URL,
    env.ORKESTR_PUBLIC_HELP_URL,
  ].map((value) => publicHttpUrl(value)).find(Boolean) || "";
  const fallback = "https://orkestr.example.test/";
  try {
    return new URL(configured || fallback).toString();
  } catch {
    return fallback;
  }
}

function publicTenantVmSetupUrl(env = process.env) {
  const base = publicHttpUrl(env.ORKESTR_CONNECT_PUBLIC_BASE_URL || env.ORKESTR_CONNECT_PUBLIC_URL);
  const tenantVmId = String(env.ORKESTR_TENANT_VM_ID || "").trim();
  if (!base || !tenantVmId) return "";
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/i/${encodeURIComponent(tenantVmId)}/app/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function inboundRoutingFailureNoticeText(error, { env = process.env } = {}) {
  const reason = String(error?.message || error || "routing_failed").trim();
  const failure = routingFailureFromError(error, { reason });
  const lowered = reason.toLowerCase();
  const failureText = `${failure.code} ${failure.reason} ${failure.safeMessage}`.toLowerCase();
  if (failureText.includes("whatsapp_inbound_token")) {
    return "This chat route is configured, but the target Orkestr instance rejected or is missing the broker WhatsApp token. Your message was not delivered; ask the admin to sync the target inbound token, then resend.";
  }
  if (reason === "llm_sanitizer_unconfigured") {
    return "Orkestr could not accept your message because the isolated-user LLM sanitizer is not configured. Ask the admin to connect the sanitizer, then resend.";
  }
  if (/^llm_sanitizer_(?:http_(?:408|409|425|429|5\d\d)|timeout|empty_response|invalid_json|unavailable|(?:codex|ollama)_(?:timeout|unavailable|failed|invalid_json|http_(?:408|409|425|429|5\d\d)))$/i.test(reason)) {
    return "Orkestr could not safely verify this message because the isolated-user safety service was temporarily unavailable. Please resend it in a moment.";
  }
  if (failure.code === "target_codex_not_configured" || failure.userFacingCategory === "codex") {
    const actionUrl = String(failure.appUrl || failure.setupUrl || "").trim();
    return actionUrl
      ? `This Orkestr VM is not ready for chat yet. Open ${actionUrl} and enable Codex in the web UI, then resend your message.`
      : "This Orkestr VM is not ready for chat yet. Open the Orkestr web UI and enable Codex on the VM, then resend your message.";
  }
  if (failure.code === "target_instance_unhealthy" || failure.userFacingCategory === "instance_health") {
    return "This Orkestr instance is temporarily unavailable for this chat. Your message was not delivered; please resend it after the instance is healthy.";
  }
  if (failure.code === "whatsapp_binding_disabled" || failure.code === "disabled_whatsapp_binding" || reason === "whatsapp_binding_disabled") {
    return "This WhatsApp chat is connected to Orkestr, but inbound messages are currently disabled for the bound thread. Your message was not delivered; ask the admin to enable the WhatsApp binding, then resend.";
  }
  if (failure.code === "whatsapp_inbound_sender_denied" || failure.reason === "unknown_sender") {
    return failure.safeMessage || "This WhatsApp sender is not allowed to control this Orkestr chat.";
  }
  if (failure.capability === "timers" || failure.userFacingCategory === "timer" || lowered.includes("timer")) {
    return "Timers are not available for this chat right now. Please try again after Orkestr is healthy.";
  }
  if (reason === "browser_pairing_required") {
    return `This Orkestr chat needs browser pairing approval before it can accept messages. Open ${publicHelpUrl(env)} to complete pairing, then resend.`;
  }
  if (reason === "whatsapp_target_required") {
    return "Orkestr could not route your message because this WhatsApp chat is not connected to a thread.";
  }
  if (lowered.includes("gmail")) {
    return "Gmail is not connected or enabled for this chat yet. Ask the Orkestr admin to connect Gmail for this user, then resend.";
  }
  if (lowered.includes("outlook")) {
    return "Outlook is not connected or enabled for this chat yet. Ask the Orkestr admin to connect Outlook for this user, then resend.";
  }
  if (lowered.includes("linkedin") || lowered.includes("desktop")) {
    return "The managed desktop is not connected or enabled for this chat yet. Ask the Orkestr admin to enable the desktop for this user, then resend.";
  }
  if (lowered.includes("whatsapp") || lowered.includes("connector") || lowered.includes("capability") || lowered.includes("account identity")) {
    return "This chat is missing a required Orkestr capability or connector setup. Please retry after the chat setup is healthy.";
  }
  if (reason.startsWith("llm_sanitizer")) {
    return "Orkestr could not accept your message because the isolated-user safety policy blocked or could not verify it. Please retry with a simpler request, or ask the admin to check the chat setup.";
  }
  return `Orkestr could not route your message: ${reason}.`;
}

function inboundRoutingFailureShouldNotify(error) {
  const reason = String(error?.message || error || "").trim();
  const failure = routingFailureFromError(error, { reason });
  if (reason === "whatsapp_target_required" || failure.code === "whatsapp_target_required") return false;
  if (reason === "message_text_required" || failure.code === "message_text_required") return false;
  return true;
}

function disabledBindingRoutingError(routed = {}) {
  const error = new Error("whatsapp_binding_disabled");
  error.routingFailure = normalizeRoutingFailure({
    code: "whatsapp_binding_disabled",
    reason: "disabled_whatsapp_binding",
    threadId: String(routed?.threadId || ""),
    safeMessage: "This WhatsApp chat is connected to Orkestr, but inbound messages are disabled for the bound thread.",
    userFacingCategory: "connector",
    retryable: false,
  }, {
    reason: "disabled_whatsapp_binding",
  });
  return error;
}

async function sendInboundRoutingFailureNotice({ accountId = "", chatId = "", eventId = "", error = null, client = null, env = process.env } = {}) {
  const selectedAccountId = String(accountId || "").trim();
  const id = String(chatId || "").trim();
  const sourceEventId = String(eventId || "").trim();
  if (!selectedAccountId || !id || !sourceEventId) return { sent: false, reason: "missing_target" };
  if (!inboundRoutingFailureShouldNotify(error)) return { sent: false, reason: "routing_failure_not_user_notifiable" };
  if (hasInboundFailureNotice(selectedAccountId, sourceEventId)) return { sent: false, reason: "already_notified" };
  const text = inboundRoutingFailureNoticeText(error, { env });
  rememberInboundFailureNotice(selectedAccountId, sourceEventId);
  try {
    if (client) {
      rememberOutboundText(selectedAccountId, id, text, env);
      const message = await sendWhatsAppTextWithConfirmation({ client, chatId: id, text, env });
      rememberOutboundMessageId(serializedMessageId(message));
    } else {
      await sendLocalWhatsAppText({ accountId: selectedAccountId, chatId: id, text, env });
    }
    await appendEvent({
      type: "whatsapp_local_inbound_failure_notice_delivered",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
      reason: String(error?.message || error || ""),
    }, env).catch(() => {});
    return { sent: true };
  } catch (noticeError) {
    await appendEvent({
      type: "whatsapp_local_inbound_failure_notice_failed",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
      reason: String(error?.message || error || ""),
      error: noticeError?.message || String(noticeError),
    }, env).catch(() => {});
    return { sent: false, reason: noticeError?.message || String(noticeError) };
  }
}

function forwardedSecurityApprovalNoticeText(payload = {}) {
  if (payload?.approvedSecurityChallenge !== true) return "";
  return "Orkestr access approved. Return to the Orkestr web UI to continue.";
}

async function sendForwardedSecurityApprovalNotice({ accountId = "", chatId = "", eventId = "", forwarded = null, client = null, env = process.env } = {}) {
  const selectedAccountId = String(accountId || "").trim();
  const id = String(chatId || "").trim();
  const sourceEventId = String(eventId || "").trim();
  const text = forwardedSecurityApprovalNoticeText(forwarded?.payload || {});
  if (!text) return { sent: false, reason: "not_security_approval" };
  if (!selectedAccountId || !id || !sourceEventId) return { sent: false, reason: "missing_target" };
  try {
    if (client) {
      rememberOutboundText(selectedAccountId, id, text, env);
      const message = await sendWhatsAppTextWithConfirmation({ client, chatId: id, text, env });
      rememberOutboundMessageId(serializedMessageId(message));
      await appendEvent({
        type: "whatsapp_local_forwarded_security_approval_notice_delivered",
        accountId: selectedAccountId,
        eventId: sourceEventId,
        chatId: id,
        messageId: serializedMessageId(message),
      }, env).catch(() => {});
      return { sent: true, messageId: serializedMessageId(message) };
    }
    await sendLocalWhatsAppText({ accountId: selectedAccountId, chatId: id, text, env });
    await appendEvent({
      type: "whatsapp_local_forwarded_security_approval_notice_delivered",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
    }, env).catch(() => {});
    return { sent: true };
  } catch (noticeError) {
    await appendEvent({
      type: "whatsapp_local_forwarded_security_approval_notice_failed",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
      error: noticeError?.message || String(noticeError),
    }, env).catch(() => {});
    return { sent: false, reason: noticeError?.message || String(noticeError) };
  }
}

async function clearQr(accountId, env = process.env) {
  await fs.unlink(qrPath(accountId, env)).catch(() => {});
}

async function writeQr(accountId, qr, qrcode, env = process.env) {
  await ensureBridgeDirs(env);
  const svg = await qrcode.toString(qr, { type: "svg", margin: 1, width: 320 });
  await fs.writeFile(qrPath(accountId, env), svg);
}

function localWhatsAppApiAgentAutoRun(env = process.env) {
  return String(env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN || "1").trim().toLowerCase() !== "0";
}

export async function handleInboundMessage(accountId, message, env = process.env, options = {}) {
  const fromMe = Boolean(message?.fromMe);
  if (options.ownOnly && !fromMe) return { skipped: "not_own_message" };
  if (message?.isStatus) return { skipped: "status_message" };
  const text = String(message?.body || "").trim();
  const { chatId, from, fromMe: routeFromMe } = localWhatsAppMessageRouteFields(message);
  const eventId = String(message.id?._serialized || `${accountId}:${chatId}:${message.timestamp || Date.now()}`).trim();
  if (fromMe && outboundMessageIds.has(eventId)) return { skipped: "outbound_echo_id", eventId, chatId };
  if (outboundTextRecentlySent(accountId, chatId, text, env)) {
    return { skipped: fromMe ? "outbound_echo_text" : "outbound_echo_cross_account_text", eventId, chatId };
  }
  if (outboundAttachmentsRecentlySent(accountId, chatId, inboundAttachmentEchoCandidates(message), env)) {
    return { skipped: fromMe ? "outbound_echo_attachment" : "outbound_echo_cross_account_attachment", eventId, chatId };
  }
  const attachments = await saveInboundMedia(accountId, message, env).catch((error) => {
    void appendEvent({
      type: "whatsapp_local_inbound_media_save_failed",
      accountId,
      eventId: String(message?.id?._serialized || ""),
      error: error.message || String(error),
    }, env).catch(() => {});
    return [];
  });
  if (!text && !attachments.length) return { skipped: "empty_message" };
  if (outboundAttachmentsRecentlySent(accountId, chatId, attachments, env, { allowSizeOnly: fromMe })) {
    return { skipped: fromMe ? "outbound_echo_attachment" : "outbound_echo_cross_account_attachment", eventId, chatId };
  }
  const routeAccountId = String(options.routeAccountId || accountId || "").trim();
  const routedText = text || attachmentSummaryText(attachments);
  const inbound = {
    eventId,
    chatId,
    from,
    accountId: routeAccountId,
    fromMe: routeFromMe,
    text: routedText,
    attachments,
    timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : nowIso(),
  };
  try {
    const forwarded = await forwardLocalWhatsAppInbound(inbound, env);
    if (forwarded) {
      const approvalNotice = await sendForwardedSecurityApprovalNotice({
        accountId,
        chatId,
        eventId,
        forwarded,
        client: options.client || null,
        env,
      });
      return { routed: forwarded.payload, forwarded: true, eventId, chatId, from, fromMe: routeFromMe, approvalNotice };
    }
    const { deliverWhatsAppReplies, routeWhatsAppInbound } = await import("./whatsapp.js");
    const routed = await routeWhatsAppInbound({ ...inbound, deferApiAgentAutoRun: true }, env);
    if (routed?.ignoredDisabledBinding) {
      const error = disabledBindingRoutingError(routed);
      const notice = await sendInboundRoutingFailureNotice({
        accountId,
        chatId,
        eventId,
        error,
        client: options.client || null,
        env,
      }).catch((noticeError) => ({ sent: false, reason: noticeError?.message || String(noticeError) }));
      return {
        routed,
        eventId,
        chatId,
        from,
        fromMe: routeFromMe,
        noticeSent: notice?.sent === true,
        noticeReason: notice?.reason || "",
        routingFailure: error.routingFailure,
      };
    }
    if (routed.threadId && !routed.duplicate) {
      const thread = await getThread(routed.threadId, env).catch(() => null);
      if (threadUsesApiAgent(thread || {}, env)) {
        await deliverWhatsAppReplies(env).catch(() => {});
        if (localWhatsAppApiAgentAutoRun(env)) await processApiAgentThreadInput(thread.id, env).catch(() => null);
        await deliverWhatsAppReplies(env).catch(() => {});
        return { routed: { ...routed, runtimeKind: "api-agent" }, eventId, chatId, from, fromMe: routeFromMe };
      }
      await deliverWhatsAppReplies(env).catch(() => {});
      requestThreadInputDelivery(routed.threadId, env);
    }
    return { routed, eventId, chatId, from, fromMe: routeFromMe };
  } catch (error) {
    const routingFailure = routingFailureFromError(error);
    const deliveredElsewhere = await findInboundForwardLedgerEntry({ chatId, eventId }, env).catch(() => null);
    if (deliveredElsewhere) {
      await appendEvent({
        type: "whatsapp_local_inbound_failure_notice_suppressed",
        accountId,
        eventId,
        chatId,
        reason: "source_event_already_forwarded",
        threadId: deliveredElsewhere.threadId || null,
        messageId: deliveredElsewhere.messageId || null,
      }, env).catch(() => {});
      return {
        routed: {
          duplicate: true,
          threadId: deliveredElsewhere.threadId || null,
          messageId: deliveredElsewhere.messageId || null,
        },
        eventId,
        chatId,
        from,
        fromMe: routeFromMe,
        skipped: "source_event_already_forwarded",
        noticeSent: false,
      };
    }
    const notice = await sendInboundRoutingFailureNotice({
      accountId,
      chatId,
      eventId,
      error,
      client: options.client || null,
      env,
    }).catch((noticeError) => ({ sent: false, reason: noticeError?.message || String(noticeError) }));
    await appendEvent(
      {
        type: "whatsapp_local_inbound_failed",
        accountId,
        eventId,
        chatId,
        from,
        fromMe: routeFromMe,
        error: error.message || String(error),
        routingFailure,
        noticeSent: notice?.sent === true,
        noticeReason: notice?.reason || "",
      },
      env,
    );
    return { error: error.message || String(error), routingFailure, eventId, chatId, from, fromMe: routeFromMe, noticeSent: notice?.sent === true, noticeReason: notice?.reason || "" };
  }
}

export async function recoverLocalWhatsAppChatMessages({ accountId = "", chatId = "", limit = 20, unreadOnly = true, markSeen = true, sinceMs = 0 } = {}, env = process.env) {
  return recoverLocalWhatsAppChatMessagesWithClient({ accountId, chatId, limit, unreadOnly, markSeen, sinceMs }, env);
}

function localWhatsAppMessageTimestampMs(message = {}) {
  const raw = Number(message?.timestamp || message?.timestampMs || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1_000_000_000_000 ? raw : raw * 1000;
}

async function recoverLocalWhatsAppChatMessagesWithClient({ accountId = "", chatId = "", limit = 20, unreadOnly = true, markSeen = true, sinceMs = 0 } = {}, env = process.env, options = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const client = options.client || runtimes.get(normalized)?.client;
  const state = options.state || accountStates.get(normalized) || defaultAccountState(normalized);
  if (!client || !state.ready) {
    return { ok: false, accountId: normalized, chatId: id, ready: false, state: state.state || "idle", routed: [], skipped: [] };
  }
  const chat = options.chat || await client.getChatById(id);
  const fetchLimit = Math.max(1, Math.min(100, Number(limit || 20) || 20));
  const messages = await chat.fetchMessages({ limit: fetchLimit });
  const unreadCount = Number(chat?.unreadCount || 0) || 0;
  let candidates = unreadOnly && unreadCount > 0
    ? messages.slice(-Math.min(unreadCount, messages.length))
    : messages;
  const minTimestampMs = Number(sinceMs || 0) || 0;
  if (minTimestampMs > 0) {
    candidates = candidates.filter((message) => {
      const timestampMs = localWhatsAppMessageTimestampMs(message);
      return timestampMs > 0 && timestampMs >= minTimestampMs;
    });
  }
  const routed = [];
  const skipped = [];
  for (const message of candidates) {
    const eventId = String(message?.id?._serialized || "").trim();
    if (message?.fromMe) {
      skipped.push({ eventId, reason: "from_me" });
      continue;
    }
    const result = await handleInboundMessage(normalized, message, env, { client });
    if (result?.routed?.threadId && !result.routed.duplicate) routed.push({ eventId, threadId: result.routed.threadId, messageId: result.routed.messageId });
    else skipped.push({ eventId, reason: result?.routed?.duplicate ? "duplicate" : result?.skipped || result?.error || "not_routed", noticeSent: result?.noticeSent === true });
  }
  const notifiedFailures = skipped.filter((entry) => entry.noticeSent === true).length;
  if (markSeen && (routed.length || notifiedFailures) && typeof chat.sendSeen === "function") await chat.sendSeen().catch(() => {});
  await appendEvent({
    type: "whatsapp_local_chat_recovered",
    accountId: normalized,
    chatId: id,
    unreadOnly: unreadOnly !== false,
    sinceMs: minTimestampMs || null,
    unreadCount,
    fetched: messages.length,
    candidates: candidates.length,
    routed: routed.length,
    skipped: skipped.length,
  }, env).catch(() => {});
  return { ok: true, accountId: normalized, chatId: id, unreadOnly: unreadOnly !== false, sinceMs: minTimestampMs || null, unreadCount, fetched: messages.length, candidates: candidates.length, routed, skipped };
}

function localWhatsAppUnreadRecoveryEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY || env.WHATSAPP_LOCAL_UNREAD_RECOVERY || "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function localWhatsAppUnreadRecoveryIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_MS || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(10_000, parsed) : 30_000;
}

function localWhatsAppUnreadRecoveryFetchLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_FETCH_LIMIT || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_FETCH_LIMIT || 20);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
}

function localWhatsAppRecentRecoveryEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_RECENT_RECOVERY || env.WHATSAPP_LOCAL_RECENT_RECOVERY || "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function localWhatsAppRecentRecoveryMaxAgeMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_RECENT_RECOVERY_MAX_AGE_MS || env.WHATSAPP_LOCAL_RECENT_RECOVERY_MAX_AGE_MS || 10 * 60_000);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(24 * 60 * 60_000, parsed)) : 10 * 60_000;
}

function localWhatsAppUnreadRecoveryMaxChats(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_MAX_CHATS || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_MAX_CHATS || 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 10;
}

export function localWhatsAppUnreadRecoveryBoundChats(threads = [], accountId = "", env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const byChatId = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    if (!whatsappBindingIsRouteEligible(binding)) continue;
    const chatId = String(binding.chatId || "").trim();
    if (!chatId) continue;
    const accounts = [...whatsappBindingAccountIds(binding)];
    if (accounts.length && !accounts.some((candidate) => localAccountMatches(candidate, selectedAccountId, env))) continue;
    byChatId.set(chatId, {
      chatId,
      threadId: String(thread?.id || "").trim(),
      accountId: selectedAccountId,
    });
  }
  for (const chatId of localWhatsAppInboundForwardChatIds(env)) {
    if (byChatId.has(chatId)) continue;
    byChatId.set(chatId, {
      chatId,
      threadId: "",
      accountId: selectedAccountId,
      source: "inbound_forward_map",
    });
  }
  return [...byChatId.values()];
}

async function localWhatsAppUnreadRecoveryTenantRouteChats(accountId = "", env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const routes = await listTenantWhatsAppRoutes(env).catch(() => []);
  const chats = [];
  for (const route of Array.isArray(routes) ? routes : []) {
    if (route?.enabled !== true || route?.forwardingReady !== true) continue;
    const chatId = String(route.chatId || "").trim();
    if (!chatId) continue;
    const routeAccountId = String(route.accountId || "").trim();
    if (routeAccountId && !localAccountMatches(routeAccountId, selectedAccountId, env)) continue;
    chats.push({
      chatId,
      threadId: "",
      accountId: selectedAccountId,
      source: "tenant_whatsapp_route",
      tenantVmId: String(route.tenantVmId || "").trim(),
    });
  }
  return chats;
}

function optionMapLookup(collection, key) {
  if (!collection) return undefined;
  if (collection instanceof Map) return collection.get(key);
  return collection[key];
}

async function recoverUnreadLocalWhatsAppMessagesOnce(env = process.env, options = {}) {
  const accountIds = options.accountIds || localWhatsAppAccountIdsForEnv(env);
  const threads = options.threads || await listThreads(env).catch(() => []);
  const maxChats = localWhatsAppUnreadRecoveryMaxChats(env);
  const limit = Number(options.limit || localWhatsAppUnreadRecoveryFetchLimit(env));
  const nowMs = Number(options.nowMs || Date.now());
  const recentEnabled = localWhatsAppRecentRecoveryEnabled(env);
  const recentSinceMs = Number(options.recentSinceMs || (nowMs - localWhatsAppRecentRecoveryMaxAgeMs(env)));
  const checked = [];
  const recovered = [];
  const skipped = [];
  const failed = [];
  for (const accountId of accountIds) {
    const normalized = normalizeAccountId(accountId, env);
    const state = optionMapLookup(options.accountStates, normalized) || accountStates.get(normalized) || defaultAccountState(normalized);
    const client = optionMapLookup(options.clients, normalized) || optionMapLookup(options.runtimes, normalized)?.client || runtimes.get(normalized)?.client;
    const boundChatMap = new Map(localWhatsAppUnreadRecoveryBoundChats(threads, normalized, env).map((chat) => [chat.chatId, chat]));
    for (const chat of await localWhatsAppUnreadRecoveryTenantRouteChats(normalized, env)) {
      if (!boundChatMap.has(chat.chatId)) boundChatMap.set(chat.chatId, chat);
    }
    const boundChats = [...boundChatMap.values()];
    checked.push({ accountId: normalized, boundChats: boundChats.length, ready: Boolean(client && state.ready) });
    if (!boundChats.length) continue;
    if (!client || !state.ready) {
      skipped.push({ accountId: normalized, reason: "not_ready" });
      continue;
    }
    let chats = [];
    try {
      chats = optionMapLookup(options.chatsByAccount, normalized) || await client.getChats();
    } catch (error) {
      failed.push({ accountId: normalized, reason: "list_chats_failed", error: error?.message || String(error) });
      continue;
    }
    const boundIds = new Set(boundChats.map((chat) => chat.chatId));
    const chatEntries = (Array.isArray(chats) ? chats : [])
      .map((chat) => ({
        chat,
        chatId: String(chat?.id?._serialized || chat?.id || "").trim(),
        unreadCount: Number(chat?.unreadCount || 0) || 0,
      }))
      .filter((entry) => entry.chatId && boundIds.has(entry.chatId));
    const unreadChats = chatEntries.filter((entry) => entry.unreadCount > 0).slice(0, maxChats);
    const unreadIds = new Set(unreadChats.map((entry) => entry.chatId));
    const recentChats = recentEnabled
      ? chatEntries.filter((entry) => !unreadIds.has(entry.chatId)).slice(0, Math.max(0, maxChats - unreadChats.length))
      : [];
    if (!unreadChats.length && !recentChats.length) continue;
    for (const entry of unreadChats) {
      try {
        const result = await recoverLocalWhatsAppChatMessagesWithClient({
          accountId: normalized,
          chatId: entry.chatId,
          limit,
          unreadOnly: true,
          markSeen: true,
        }, env, { client, state, chat: entry.chat });
        recovered.push(result);
      } catch (error) {
        failed.push({ accountId: normalized, chatId: entry.chatId, error: error?.message || String(error) });
      }
    }
    for (const entry of recentChats) {
      try {
        const result = await recoverLocalWhatsAppChatMessagesWithClient({
          accountId: normalized,
          chatId: entry.chatId,
          limit,
          unreadOnly: false,
          markSeen: false,
          sinceMs: recentSinceMs,
        }, env, { client, state, chat: entry.chat });
        if (result.candidates > 0 || result.routed.length > 0) recovered.push({ ...result, recoveryMode: "recent" });
      } catch (error) {
        failed.push({ accountId: normalized, chatId: entry.chatId, error: error?.message || String(error) });
      }
    }
  }
  const routed = recovered.reduce((count, result) => count + Number(result?.routed?.length || 0), 0);
  if (recovered.length || failed.length) {
    await appendEvent({
      type: "whatsapp_local_unread_recovery_checked",
      checked: checked.length,
      recovered: recovered.length,
      routed,
      failed: failed.length,
    }, env).catch(() => {});
  }
  return { enabled: true, checked, recovered, routed, skipped, failed };
}

export async function recoverUnreadLocalWhatsAppMessages(env = process.env, options = {}) {
  if (!localWhatsAppUnreadRecoveryEnabled(env) && !options.force) {
    return { enabled: false, checked: [], recovered: [], routed: 0, skipped: [], failed: [] };
  }
  const nowMs = Number(options.nowMs || Date.now());
  const intervalMs = localWhatsAppUnreadRecoveryIntervalMs(env);
  if (!options.force && localWhatsAppUnreadRecoveryLastRunMs && nowMs - localWhatsAppUnreadRecoveryLastRunMs < intervalMs) {
    return { enabled: true, checked: [], recovered: [], routed: 0, skipped: [{ reason: "cooldown", intervalMs }], failed: [] };
  }
  if (localWhatsAppUnreadRecoveryInFlight) return localWhatsAppUnreadRecoveryInFlight;
  localWhatsAppUnreadRecoveryLastRunMs = nowMs;
  localWhatsAppUnreadRecoveryInFlight = recoverUnreadLocalWhatsAppMessagesOnce(env, options).finally(() => {
    localWhatsAppUnreadRecoveryInFlight = null;
  });
  return localWhatsAppUnreadRecoveryInFlight;
}

function localWhatsAppAutostartEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_AUTOSTART || env.WHATSAPP_LOCAL_AUTOSTART || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function localWhatsAppAutostartAccountIds(env = process.env) {
  if (!localWhatsAppAutostartEnabled(env)) return [];
  const accountIds = splitAccountList(env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS || env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS);
  return accountIds.length ? accountIds : localWhatsAppAccountIdsForEnv(env);
}

export async function startConfiguredLocalWhatsAppAccounts(env = process.env) {
  if (!localWhatsAppAutostartEnabled(env)) return { enabled: false, accounts: [] };
  const selected = localWhatsAppAutostartAccountIds(env);
  const accounts = await Promise.all(selected.map((accountId) => startLocalWhatsAppAccount(accountId, env)));
  return { enabled: true, accounts };
}

const localWhatsAppRecoveryAttempts = new Map();
const recoverableLocalWhatsAppStates = new Set(["startup_timeout", "auth_ready_timeout", "disconnected", "stale_runtime"]);
const localWhatsAppChromeLockFiles = new Set(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
let localWhatsAppUnreadRecoveryInFlight = null;
let localWhatsAppUnreadRecoveryLastRunMs = 0;

function chromeLockPidFromText(value = "") {
  const matches = String(value || "").match(/\b[1-9]\d{1,9}\b/g) || [];
  for (const match of matches.reverse()) {
    const pid = Number(match);
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function chromeLockPid(filePath) {
  const stats = await fs.lstat(filePath).catch(() => null);
  if (!stats) return null;
  const candidates = [];
  if (stats.isSymbolicLink()) {
    candidates.push(await fs.readlink(filePath).catch(() => ""));
  }
  if (stats.isFile() && stats.size <= 1024) {
    candidates.push(await fs.readFile(filePath, "utf8").catch(() => ""));
  }
  for (const candidate of candidates) {
    const pid = chromeLockPidFromText(candidate);
    if (pid) return pid;
  }
  return null;
}

async function moveStaleChromeLock(filePath, index, nowMs) {
  const destination = `${filePath}.orkestr-stale-${nowMs}-${index}`;
  await fs.rename(filePath, destination);
  return destination;
}

function chromeUserDataDirFromArgv(argv = []) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item || "")) : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--user-data-dir=")) return arg.slice("--user-data-dir=".length).trim();
    if (arg === "--user-data-dir") return String(args[index + 1] || "").trim();
  }
  return "";
}

function chromeProcessCommand(argv = [], command = "") {
  return path.basename(String(argv?.[0] || command || "").trim()).toLowerCase();
}

function localWhatsAppChromeProcess(processInfo = {}, profileDirs = []) {
  const argv = Array.isArray(processInfo.argv)
    ? processInfo.argv
    : Array.isArray(processInfo.cmdline)
      ? processInfo.cmdline
      : String(processInfo.cmdline || "")
        .split(/\0|\s+/g)
        .filter(Boolean);
  const command = chromeProcessCommand(argv, processInfo.command);
  if (!/(?:^|-)chrome(?:$|-)|chromium|google-chrome/.test(command)) return null;
  const userDataDir = chromeUserDataDirFromArgv(argv);
  if (!userDataDir) return null;
  const matchedProfileDir = profileDirs.find((dir) => sameOrInsidePath(dir, userDataDir));
  if (!matchedProfileDir) return null;
  const pid = Number(processInfo.pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  return { pid, command, userDataDir: path.resolve(userDataDir), profileDir: matchedProfileDir };
}

async function listLocalChromeProcessesFromProc(procRoot = "/proc") {
  const entries = await fs.readdir(procRoot, { withFileTypes: true }).catch(() => []);
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const cmdlinePath = path.join(procRoot, entry.name, "cmdline");
    const raw = await fs.readFile(cmdlinePath).catch(() => null);
    if (!raw?.length) continue;
    const argv = raw.toString("utf8").split("\0").filter(Boolean);
    processes.push({ pid, argv, command: argv[0] || "" });
  }
  return processes;
}

async function waitForProcessExit(pid, options = {}) {
  const processAlive = options.processAlive || pidAlive;
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 1500) || 0);
  const intervalMs = Math.max(25, Math.min(250, Number(options.intervalMs || 100) || 100));
  const startedAt = Date.now();
  while (processAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

async function terminateChromeProcess(pid, options = {}) {
  const killProcess = options.killProcess || ((targetPid, signal) => process.kill(targetPid, signal));
  const processAlive = options.processAlive || pidAlive;
  try {
    await killProcess(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { terminated: false, alreadyExited: true };
    throw error;
  }
  const exited = await waitForProcessExit(pid, {
    processAlive,
    timeoutMs: options.graceMs,
    intervalMs: options.pollMs,
  });
  if (exited || !processAlive(pid)) return { terminated: true, signal: "SIGTERM" };
  try {
    await killProcess(pid, "SIGKILL");
    await waitForProcessExit(pid, {
      processAlive,
      timeoutMs: Math.min(1000, Math.max(100, Number(options.graceMs || 1000) || 1000)),
      intervalMs: options.pollMs,
    });
    return { terminated: true, signal: "SIGKILL" };
  } catch (error) {
    if (error?.code === "ESRCH") return { terminated: true, signal: "SIGTERM", alreadyExited: true };
    throw error;
  }
}

export async function cleanupLocalWhatsAppOrphanChromeProcesses(accountId = "", env = process.env, options = {}) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  if (runtimes.get(normalized)?.client) {
    return { accountId: normalized, killed: [], skipped: [{ reason: "active_runtime" }] };
  }
  const profileDirs = localWhatsAppChromeProfileDirsForAccount(normalized, env);
  const listProcesses = options.listChromeProcesses || options.listProcesses || listLocalChromeProcessesFromProc;
  const processes = await listProcesses(options.procRoot || "/proc");
  const matches = [];
  const seenPids = new Set();
  for (const processInfo of processes || []) {
    const match = localWhatsAppChromeProcess(processInfo, profileDirs);
    if (!match || seenPids.has(match.pid)) continue;
    seenPids.add(match.pid);
    matches.push(match);
  }
  const killed = [];
  const skipped = [];
  for (const match of matches) {
    try {
      const result = await terminateChromeProcess(match.pid, {
        killProcess: options.killChromeProcess || options.killProcess,
        processAlive: options.isChromeProcessAlive || options.processAlive,
        graceMs: options.orphanChromeGraceMs ?? options.graceMs,
        pollMs: options.orphanChromePollMs ?? options.pollMs,
      });
      if (result.terminated || result.alreadyExited) killed.push({ ...match, signal: result.signal || null, alreadyExited: result.alreadyExited === true });
    } catch (error) {
      skipped.push({ ...match, reason: error?.message || String(error) });
    }
  }
  if (killed.length || skipped.length) {
    await appendEvent({
      type: "whatsapp_local_orphan_chrome_cleanup",
      accountId: normalized,
      killed: killed.length,
      skipped: skipped.length,
      pids: killed.map((item) => item.pid),
    }, env).catch(() => {});
  }
  return { accountId: normalized, profileDirs, killed, skipped };
}

function recoverableLocalWhatsAppFailure(account = {}) {
  const state = String(account?.state || "").trim();
  if (recoverableLocalWhatsAppStates.has(state)) return true;
  if (state !== "failed") return false;
  const error = String(account?.error || "").toLowerCase();
  return error.includes("target closed") ||
    error.includes("runtime.addbinding") ||
    error.includes("browser is already running") ||
    error.includes("userdatadir");
}

function localWhatsAppRecoveryCooldownMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_AUTO_RECOVER_MS || env.WHATSAPP_LOCAL_AUTO_RECOVER_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 60_000;
}

export function recoverableLocalWhatsAppAccountIds(accounts = [], selectedAccountIds = []) {
  const selected = new Set(selectedAccountIds.map((accountId) => String(accountId || "").trim()).filter(Boolean));
  return accounts
    .filter((account) => {
      const accountId = String(account?.accountId || "").trim();
      return accountId &&
        selected.has(accountId) &&
        account.ready !== true &&
        recoverableLocalWhatsAppFailure(account);
    })
    .map((account) => String(account.accountId).trim());
}

export async function cleanupLocalWhatsAppChromeLocks(accountId = "", env = process.env) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  const root = sessionRootForAccount(normalized, env);
  const clientId = clientIdForAccount(normalized, env);
  const candidates = new Set([root, path.join(root, `session-${clientId}`)]);
  const firstLevel = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of firstLevel) {
    if (entry.isDirectory()) candidates.add(path.join(root, entry.name));
  }
  const removed = [];
  const moved = [];
  const stalePids = new Set();
  const nowMs = Date.now();
  for (const dir of candidates) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const lockPaths = entries
      .filter((entry) => localWhatsAppChromeLockFiles.has(entry.name))
      .map((entry) => path.join(dir, entry.name));
    const staleLocks = [];
    for (const filePath of lockPaths) {
      const pid = await chromeLockPid(filePath);
      if (!pid || pidAlive(pid)) continue;
      staleLocks.push({ filePath, pid });
      stalePids.add(pid);
    }
    if (!staleLocks.length) continue;
    for (const filePath of lockPaths) {
      try {
        const destination = await moveStaleChromeLock(filePath, moved.length + 1, nowMs);
        removed.push(filePath);
        moved.push({ from: filePath, to: destination });
      } catch {
        // If Chrome already removed the marker between scan and rename, there is nothing left to recover.
      }
    }
  }
  if (removed.length) {
    await appendEvent({
      type: "whatsapp_local_chrome_locks_moved",
      accountId: normalized,
      count: removed.length,
      stalePids: [...stalePids],
    }, env).catch(() => {});
  }
  return { accountId: normalized, removed, moved, stalePids: [...stalePids] };
}

export async function restartRecoverableLocalWhatsAppAccount(accountId = "", env = process.env, options = {}) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  const runtime = runtimes.get(normalized);
  if (runtime?.client) {
    runtime.clearAuthReadyTimer?.();
    runtime.clearPairingCodeUnhandledRejectionHandler?.();
    await runtime.client.destroy().catch(() => {});
  }
  runtimes.delete(normalized);
  clearAccountTypingStartPromises(normalized);
  for (const key of [...typingClearRetryTimers.keys()].filter((item) => item.startsWith(`${normalized}:`))) {
    clearTypingClearRetryTimers(key);
  }
  for (const session of [...typingSessions.values()].filter((item) => item.accountId === normalized)) {
    clearTypingSessionTimers(session);
    typingSessions.delete(typingKey(session.accountId, session.chatId));
  }
  const orphanCleanup = await cleanupLocalWhatsAppOrphanChromeProcesses(normalized, env, options);
  const cleanup = await cleanupLocalWhatsAppChromeLocks(normalized, env);
  setAccountState(normalized, {
    state: "idle",
    ready: false,
    authenticated: false,
    started: false,
    qrAvailable: false,
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    authenticatedAt: null,
    loadingPercent: null,
    loadingMessage: "",
    waState: "",
    error: "",
  });
  await appendEvent({
    type: "whatsapp_local_auto_recover_reset",
    accountId: normalized,
    reason: String(options.reason || "auto_recover"),
    hadRuntime: Boolean(runtime?.client),
    killedChromeProcesses: orphanCleanup.killed.length,
    removedChromeLocks: cleanup.removed.length,
  }, env).catch(() => {});
  return {
    accountId: normalized,
    hadRuntime: Boolean(runtime?.client),
    killedChromeProcesses: orphanCleanup.killed.length,
    removedChromeLocks: cleanup.removed.length,
  };
}

export async function recoverConfiguredLocalWhatsAppAccounts(env = process.env, options = {}) {
  const selected = localWhatsAppAutostartAccountIds(env);
  if (!selected.length) return { enabled: false, recovered: [], skipped: [] };
  const status = options.status || await getLocalWhatsAppBridgeStatus(env);
  const resetCandidates = recoverableLocalWhatsAppAccountIds(status.accounts || [], selected);
  const resetCandidateSet = new Set(resetCandidates);
  const selectedSet = new Set(selected.map((accountId) => String(accountId || "").trim()).filter(Boolean));
  const startCandidates = (status.accounts || [])
    .map((account) => ({
      accountId: String(account?.accountId || "").trim(),
      state: String(account?.state || "").trim(),
      ready: account?.ready === true,
    }))
    .filter((account) =>
      account.accountId &&
      selectedSet.has(account.accountId) &&
      !resetCandidateSet.has(account.accountId) &&
      account.ready !== true &&
      account.state === "idle"
    )
    .map((account) => account.accountId);
  const candidates = [
    ...resetCandidates.map((accountId) => ({ accountId, reset: true })),
    ...startCandidates.map((accountId) => ({ accountId, reset: false })),
  ];
  const cooldownMs = localWhatsAppRecoveryCooldownMs(env);
  const nowMs = Number(options.nowMs || Date.now());
  const recovered = [];
  const skipped = [];
  for (const candidate of candidates) {
    const { accountId, reset } = candidate;
    const lastAttemptMs = Number(localWhatsAppRecoveryAttempts.get(accountId) || 0);
    if (!options.force && lastAttemptMs && nowMs - lastAttemptMs < cooldownMs) {
      skipped.push({ accountId, reason: "cooldown" });
      continue;
    }
    localWhatsAppRecoveryAttempts.set(accountId, nowMs);
    await appendEvent({ type: reset ? "whatsapp_local_auto_recover_start" : "whatsapp_local_auto_start_start", accountId }, env).catch(() => {});
    try {
      const restartAccount = options.restartAccount || restartRecoverableLocalWhatsAppAccount;
      const startAccount = options.startAccount || startLocalWhatsAppAccount;
      if (reset) await restartAccount(accountId, env, { reason: "auto_recover" });
      const account = await startAccount(accountId, env, options.startOptions || {});
      recovered.push({ accountId, state: account.state, ready: account.ready === true });
      await appendEvent({ type: "whatsapp_local_auto_recover_started", accountId, state: account.state, ready: account.ready === true }, env).catch(() => {});
    } catch (error) {
      skipped.push({ accountId, reason: error?.message || String(error) });
      await appendEvent({ type: "whatsapp_local_auto_recover_failed", accountId, error: error?.message || String(error) }, env).catch(() => {});
    }
  }
  return { enabled: true, recovered, skipped };
}

export async function startLocalWhatsAppAccount(accountId = "", env = process.env, options = {}) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  const pairingPhoneNumber = normalizePairingPhoneNumber(options.phoneNumber);
  if (options.phoneNumber && !pairingPhoneNumber) {
    const error = new Error("whatsapp_pairing_phone_number_invalid");
    error.statusCode = 400;
    throw error;
  }
  const inFlight = localWhatsAppStartPromises.get(normalized);
  if (inFlight) return inFlight;
  const promise = startLocalWhatsAppAccountOnce(normalized, env, options, pairingPhoneNumber).finally(() => {
    if (localWhatsAppStartPromises.get(normalized) === promise) localWhatsAppStartPromises.delete(normalized);
  });
  localWhatsAppStartPromises.set(normalized, promise);
  return promise;
}

async function startLocalWhatsAppAccountOnce(normalized, env = process.env, options = {}, pairingPhoneNumber = "") {
  const existingRuntime = runtimes.get(normalized);
  if (existingRuntime) {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    const shouldReplaceRuntime = Boolean(pairingPhoneNumber) &&
      !state.ready &&
      !state.authenticated &&
      state.state !== "pairing_code";
    if (!shouldReplaceRuntime) return accountSnapshot(normalized, env);
    existingRuntime.clearStartupTimer?.();
    existingRuntime.clearAuthReadyTimer?.();
    existingRuntime.clearPairingCodeUnhandledRejectionHandler?.();
    await existingRuntime.client?.destroy?.().catch(() => {});
    runtimes.delete(normalized);
    await clearQr(normalized, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_local_pairing_runtime_replaced",
      accountId: normalized,
      previousState: String(state.state || ""),
    }, env).catch(() => {});
  }
  await ensureBridgeDirs(env);
  const orphanCleanup = await cleanupLocalWhatsAppOrphanChromeProcesses(normalized, env, options);
  const staleLockCleanup = await cleanupLocalWhatsAppChromeLocks(normalized, env);
  setAccountState(normalized, {
    state: "starting",
    started: true,
    ready: false,
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: maskPairingPhoneNumber(pairingPhoneNumber),
    error: "",
    ...(orphanCleanup.killed.length
      ? {
          lastRecoveryReason: "orphan_chrome_recovered",
          lastRecoveryAt: nowIso(),
          recoveredChromeProcesses: orphanCleanup.killed.length,
        }
      : {}),
    ...(staleLockCleanup.moved.length
      ? {
          lastRecoveryReason: orphanCleanup.killed.length ? "orphan_chrome_and_stale_lock_recovered" : "stale_lock_recovered",
          lastRecoveryAt: nowIso(),
          recoveredChromeLocks: staleLockCleanup.moved.length,
        }
      : {}),
  });

  let dependencies;
  try {
    dependencies = typeof options.loadBridgeDependencies === "function"
      ? await options.loadBridgeDependencies()
      : await loadBridgeDependencies();
  } catch (error) {
    setAccountState(normalized, {
      state: "dependency_missing",
      started: false,
      error: "Install whatsapp-web.js and qrcode dependencies before starting the local bridge.",
    });
    await appendEvent({ type: "whatsapp_local_dependency_missing", accountId: normalized, error: error.message || String(error) }, env);
    return accountSnapshot(normalized, env);
  }

  const { Client, LocalAuth } = dependencies.whatsapp;
  const authTimeoutMs = authReadyTimeoutMs(env, options);
  const startTimeoutMs = startupTimeoutMs(env, options);
  let startupTimer = null;
  let startupSettled = false;
  const clearStartupTimer = () => {
    if (!startupTimer) return;
    clearTimeout(startupTimer);
    startupTimer = null;
  };
  let authReadyTimer = null;
  const clearAuthReadyTimer = () => {
    if (!authReadyTimer) return;
    clearTimeout(authReadyTimer);
    authReadyTimer = null;
  };
  let pairingCodeUnhandledRejectionHandler = null;
  const clearPairingCodeUnhandledRejectionHandler = () => {
    if (!pairingCodeUnhandledRejectionHandler) return;
    process.off("unhandledRejection", pairingCodeUnhandledRejectionHandler);
    pairingCodeUnhandledRejectionHandler = null;
  };
  const armPairingCodeUnhandledRejectionHandler = () => {
    if (!pairingPhoneNumber || pairingCodeUnhandledRejectionHandler) return;
    pairingCodeUnhandledRejectionHandler = (error) => {
      if (!pairingCodeRequestError(error)) return;
      clearPairingCodeUnhandledRejectionHandler();
      clearAuthReadyTimer();
      clearReadyFallbackTimer();
      clearConnectedPageReadyFallbackTimer();
      const message = error?.message && error.message !== "t"
        ? error.message
        : "WhatsApp pairing code request failed. Remove the stale linked-device entry on the phone if it appears linked, then request a new code.";
      setAccountState(normalized, {
        state: "pairing_code_failed",
        ready: false,
        authenticated: false,
        started: false,
        pairingCode: "",
        pairingCodeUpdatedAt: null,
        error: message,
      });
      runtimes.delete(normalized);
      void appendEvent({
        type: "whatsapp_local_pairing_code_failed",
        accountId: normalized,
        error: message,
      }, env).catch(() => {});
      void client.destroy().catch(() => {});
    };
    process.on("unhandledRejection", pairingCodeUnhandledRejectionHandler);
  };
  const scheduleAuthReadyTimer = () => {
    clearAuthReadyTimer();
    authReadyTimer = setTimeout(() => {
      void handleAuthReadyTimeout();
    }, authTimeoutMs);
    if (typeof authReadyTimer.unref === "function") authReadyTimer.unref();
  };
  const handleStartupTimeout = async () => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (startupSettled || state.ready || state.authenticated || state.qrAvailable || state.pairingCode || state.state !== "starting") return;
    const message = `WhatsApp bridge did not emit QR, pairing, auth, or ready within ${Math.round(startTimeoutMs / 1000)}s. Restart the bridge or re-link the device.`;
    setAccountState(normalized, {
      state: "startup_timeout",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: message,
    });
    runtimes.delete(normalized);
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    await clearQr(normalized, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_local_startup_timeout",
      accountId: normalized,
      timeoutMs: startTimeoutMs,
    }, env).catch(() => {});
    await client.destroy().catch(() => {});
  };
  const handleAuthReadyTimeout = async () => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (state.ready || state.state !== "authenticated") return;
    const message = `WhatsApp authenticated but did not become ready within ${Math.round(authTimeoutMs / 1000)}s. Restart the bridge or re-link the device.`;
    setAccountState(normalized, {
      state: "auth_ready_timeout",
      ready: false,
      authenticated: true,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: message,
    });
    runtimes.delete(normalized);
    clearPairingCodeUnhandledRejectionHandler();
    await clearQr(normalized, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_local_auth_ready_timeout",
      accountId: normalized,
      timeoutMs: authTimeoutMs,
      waState: state.waState || "",
      loadingPercent: state.loadingPercent ?? null,
      loadingMessage: state.loadingMessage || "",
    }, env).catch(() => {});
    await client.destroy().catch(() => {});
  };
  let readyFallbackTriggered = false;
  let readyFallbackTimer = null;
  let connectedPageReadyFallbackTimer = null;
  let connectedPageReadyFallbackCount = 0;
  const clearReadyFallbackTimer = () => {
    if (!readyFallbackTimer) return;
    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = null;
  };
  const clearConnectedPageReadyFallbackTimer = () => {
    if (!connectedPageReadyFallbackTimer) return;
    clearTimeout(connectedPageReadyFallbackTimer);
    connectedPageReadyFallbackTimer = null;
  };
  const triggerReadyFallback = async (reason, options = {}) => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (readyFallbackTriggered || state.ready) return;
    const allowConnectedPage = options.allowConnectedPage === true;
    if (!state.authenticated && !allowConnectedPage) return;
    readyFallbackTriggered = true;
    try {
      const result = await client.pupPage?.evaluate(async ({ allowConnectedPage }) => {
        const page = {
          hasSynced: typeof window.onAppStateHasSyncedEvent,
          title: document.title,
          wwebjs: typeof window.WWebJS,
          appState: window.AuthStore?.AppState?.state || window.Store?.AppState?.state || "",
        };
        if (typeof window.onAppStateHasSyncedEvent !== "function") {
          return { ok: false, reason: "callback_missing", ...page };
        }
        if (allowConnectedPage && String(page.appState || "").trim().toUpperCase() !== "CONNECTED") {
          return { ok: false, reason: "page_not_connected", ...page };
        }
        await window.onAppStateHasSyncedEvent();
        return { ok: true, ...page };
      }, { allowConnectedPage });
      await appendEvent({
        type: "whatsapp_local_ready_fallback_triggered",
        accountId: normalized,
        reason: String(reason || ""),
        ok: result?.ok === true,
        fallbackReason: String(result?.reason || ""),
        wwebjs: String(result?.wwebjs || ""),
        appState: String(result?.appState || ""),
      }, env).catch(() => {});
      if (result?.ok !== true) readyFallbackTriggered = false;
    } catch (error) {
      readyFallbackTriggered = false;
      await appendEvent({
        type: "whatsapp_local_ready_fallback_failed",
        accountId: normalized,
        reason: String(reason || ""),
        error: error?.message || String(error),
      }, env).catch(() => {});
    }
  };
  const scheduleReadyFallback = (reason) => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (readyFallbackTriggered || state.ready || !state.authenticated) return;
    if (!localWhatsAppReadyFallbackEligible(state)) return;
    clearReadyFallbackTimer();
    readyFallbackTimer = setTimeout(() => {
      readyFallbackTimer = null;
      void triggerReadyFallback(reason);
    }, 3000);
    if (typeof readyFallbackTimer.unref === "function") readyFallbackTimer.unref();
  };
  const scheduleConnectedPageReadyFallback = (reason) => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (readyFallbackTriggered || state.ready) return;
    if (connectedPageReadyFallbackTimer) return;
    const maxAttempts = connectedPageReadyFallbackAttempts(env);
    if (!maxAttempts || connectedPageReadyFallbackCount >= maxAttempts) return;
    connectedPageReadyFallbackTimer = setTimeout(async () => {
      connectedPageReadyFallbackTimer = null;
      const current = accountStates.get(normalized) || defaultAccountState(normalized);
      if (readyFallbackTriggered || current.ready || !runtimes.has(normalized)) return;
      connectedPageReadyFallbackCount += 1;
      await triggerReadyFallback(reason, { allowConnectedPage: true });
      const latest = accountStates.get(normalized) || defaultAccountState(normalized);
      if (!latest.ready && !readyFallbackTriggered && runtimes.has(normalized)) {
        scheduleConnectedPageReadyFallback(reason);
      }
    }, connectedPageReadyFallbackDelayMs(env));
    if (typeof connectedPageReadyFallbackTimer.unref === "function") connectedPageReadyFallbackTimer.unref();
  };
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: clientIdForAccount(normalized, env), dataPath: sessionRootForAccount(normalized, env) }),
    puppeteer: puppeteerOptions(env),
    userAgent: whatsappUserAgent(env),
    webVersionCache: {
      type: "local",
      path: webCacheRoot(env),
    },
    ...(pairingPhoneNumber
      ? {
          pairWithPhoneNumber: {
            phoneNumber: pairingPhoneNumber,
            showNotification: options.showNotification !== false,
            intervalMs: Number(options.intervalMs || 180000) || 180000,
          },
        }
      : {}),
  });

  client.on("qr", async (qr) => {
    try {
      startupSettled = true;
      clearStartupTimer();
      await writeQr(normalized, qr, dependencies.qrcode, env);
      setAccountState(normalized, {
        state: "qr_needed",
        ready: false,
        authenticated: false,
        started: true,
        qrAvailable: true,
        pairingCode: "",
        pairingCodeUpdatedAt: null,
        error: "",
      });
      await appendEvent({ type: "whatsapp_local_qr_ready", accountId: normalized }, env);
    } catch (error) {
      setAccountState(normalized, { state: "failed", error: error.message || String(error) });
      await appendEvent({ type: "whatsapp_local_qr_failed", accountId: normalized, error: error.message || String(error) }, env);
    }
  });

  client.on("code", async (code) => {
    startupSettled = true;
    clearStartupTimer();
    setAccountState(normalized, {
      state: "pairing_code",
      ready: false,
      authenticated: false,
      started: true,
      qrAvailable: false,
      pairingCode: String(code || "").trim(),
      pairingCodeUpdatedAt: nowIso(),
      error: "",
    });
    await appendEvent({ type: "whatsapp_local_pairing_code_ready", accountId: normalized }, env);
  });

  client.on("authenticated", async () => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    setAccountState(normalized, {
      state: "authenticated",
      authenticated: true,
      authenticatedAt: nowIso(),
      started: true,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: "",
    });
    scheduleAuthReadyTimer();
    scheduleReadyFallback("authenticated");
    await appendEvent({ type: "whatsapp_local_authenticated", accountId: normalized }, env);
  });

  client.on("ready", async () => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    await clearQr(normalized, env);
    setAccountState(normalized, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      qrAvailable: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      loadingPercent: null,
      loadingMessage: "",
      error: "",
      ...runtimeAccountIdentity({ client }),
    });
    await appendEvent({ type: "whatsapp_local_ready", accountId: normalized }, env);
  });

  client.on("auth_failure", async (message) => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    setAccountState(normalized, {
      state: "auth_failure",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: String(message || "WhatsApp authentication failed."),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_auth_failure", accountId: normalized }, env);
  });

  client.on("disconnected", async (reason) => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    const current = accountStates.get(normalized) || defaultAccountState(normalized);
    if (["auth_failure", "auth_ready_timeout", "failed"].includes(current.state)) {
      runtimes.delete(normalized);
      await appendEvent({ type: "whatsapp_local_disconnected_after_failure", accountId: normalized, reason: String(reason || "") }, env);
      return;
    }
    setAccountState(normalized, {
      state: "disconnected",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: String(reason || ""),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_disconnected", accountId: normalized, reason: String(reason || "") }, env);
  });

  client.on("loading_screen", async (percent, message) => {
    setAccountState(normalized, {
      loadingPercent: Number(percent),
      loadingMessage: String(message || ""),
    });
    scheduleReadyFallback("loading_screen");
    await appendEvent({
      type: "whatsapp_local_loading_screen",
      accountId: normalized,
      percent: Number(percent),
      message: String(message || ""),
    }, env).catch(() => {});
  });

  client.on("change_state", async (state) => {
    setAccountState(normalized, { waState: String(state || "") });
    await appendEvent({ type: "whatsapp_local_state_changed", accountId: normalized, state: String(state || "") }, env).catch(() => {});
  });

  client.on("error", async (error) => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    setAccountState(normalized, {
      state: "failed",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: error?.message || String(error),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_client_error", accountId: normalized, error: error?.message || String(error) }, env).catch(() => {});
    await client.destroy().catch(() => {});
  });

  client.on("message", (message) => {
    void handleInboundMessage(normalized, message, env, { client });
  });

  client.on("message_create", (message) => {
    void handleInboundMessage(normalized, message, env, { ownOnly: true, client });
  });

  armPairingCodeUnhandledRejectionHandler();
  startupTimer = setTimeout(() => {
    void handleStartupTimeout();
  }, startTimeoutMs);
  if (typeof startupTimer.unref === "function") startupTimer.unref();
  const initializePromise = client.initialize().catch(async (error) => {
    startupSettled = true;
    clearStartupTimer();
    clearPairingCodeUnhandledRejectionHandler();
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    clearConnectedPageReadyFallbackTimer();
    await client.destroy().catch(() => {});
    setAccountState(normalized, {
      state: "failed",
      ready: false,
      authenticated: false,
      started: false,
      error: error.message || String(error),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_start_failed", accountId: normalized, error: error.message || String(error) }, env);
  });
  runtimes.set(normalized, { client, initializePromise, clearStartupTimer, clearAuthReadyTimer, clearPairingCodeUnhandledRejectionHandler });
  scheduleConnectedPageReadyFallback("startup_connected_page");
  await appendEvent({ type: "whatsapp_local_start_requested", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function logoutLocalWhatsAppAccount(accountId = "", env = process.env) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  for (const session of [...typingSessions.values()].filter((item) => item.accountId === normalized)) {
    await stopLocalWhatsAppTyping({ accountId: session.accountId, chatId: session.chatId, env }).catch(() => {});
  }
  clearAccountTypingStartPromises(normalized);
  for (const key of [...typingClearRetryTimers.keys()].filter((item) => item.startsWith(`${normalized}:`))) {
    clearTypingClearRetryTimers(key);
  }
  const runtime = runtimes.get(normalized);
  if (runtime?.client) {
    runtime.clearStartupTimer?.();
    runtime.clearAuthReadyTimer?.();
    runtime.clearPairingCodeUnhandledRejectionHandler?.();
    await runtime.client.logout().catch(() => {});
    await runtime.client.destroy().catch(() => {});
  }
  runtimes.delete(normalized);
  await clearQr(normalized, env);
  setAccountState(normalized, {
    state: "idle",
    ready: false,
    authenticated: false,
    started: false,
    qrAvailable: false,
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: "",
    authenticatedAt: null,
    loadingPercent: null,
    loadingMessage: "",
    waState: "",
    error: "",
  });
  await appendEvent({ type: "whatsapp_local_logged_out", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function stopLocalWhatsAppBridge(env = process.env) {
  const entries = [...runtimes.entries()];
  for (const session of [...typingSessions.values()]) {
    clearTypingSessionTimers(session);
  }
  typingSessions.clear();
  typingStartPromises.clear();
  for (const key of [...typingClearRetryTimers.keys()]) clearTypingClearRetryTimers(key);
  runtimes.clear();
  await Promise.all(entries.map(async ([accountId, runtime]) => {
    if (runtime?.client) {
      runtime.clearStartupTimer?.();
      runtime.clearAuthReadyTimer?.();
      await runtime.client.destroy().catch(() => {});
    }
    await clearQr(accountId, env).catch(() => {});
    setAccountState(accountId, {
      state: "idle",
      ready: false,
      authenticated: false,
      started: false,
      qrAvailable: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      authenticatedAt: null,
      loadingPercent: null,
      loadingMessage: "",
      waState: "",
      error: "",
    });
  }));
  if (entries.length > 0) {
    await appendEvent({ type: "whatsapp_local_bridge_stopped", accounts: entries.map(([accountId]) => accountId) }, env).catch(() => {});
  }
}

export async function getLocalWhatsAppQrSvg(accountId = "", env = process.env) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  return fs.readFile(qrPath(normalized, env), "utf8").catch(() => "");
}

export async function listLocalWhatsAppChats(accountId = "", env = process.env) {
  const normalized = await normalizeManagedAccountId(accountId, env);
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  const knownChats = await knownLocalWhatsAppChats(normalized, env);
  const suppressedChatIds = await suppressedLocalWhatsAppChatIds(normalized, env);
  if (!runtime?.client || !state.ready) {
    return {
      accountId: normalized,
      state: state.state || "idle",
      ready: false,
      chats: knownChats,
    };
  }
  const chats = await runtime.client.getChats();
  const merged = new Map();
  for (const chat of knownChats) addChat(merged, chat);
  for (const chat of chats) {
    const id = String(chat?.id?._serialized || "");
    if (suppressedChatIds.has(id)) continue;
    addChat(merged, {
      id,
      name: String(chat?.name || chat?.formattedTitle || chat?.id?.user || ""),
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
      timestamp: chat?.timestamp ? new Date(Number(chat.timestamp) * 1000).toISOString() : null,
      source: "whatsapp_client",
      accountId: normalized,
    });
  }
  return {
    accountId: normalized,
    state: state.state || "ready",
    ready: true,
    chats: [...merged.values()],
  };
}

export async function listLocalWhatsAppChatMessages({ accountId = "", chatId = "", limit = 30, env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  if (!runtime?.client || !state.ready) {
    return { accountId: normalized, chatId: id, ready: false, messages: [] };
  }
  const max = Math.max(1, Math.min(100, Number(limit || 30) || 30));
  const chat = await runtime.client.getChatById(id);
  const messages = await chat.fetchMessages({ limit: max });
  return {
    accountId: normalized,
    chatId: id,
    ready: true,
    messages: (Array.isArray(messages) ? messages : []).map((message) => ({
      id: serializedMessageId(message),
      body: String(message?.body || ""),
      type: String(message?.type || ""),
      fromMe: Boolean(message?.fromMe),
      from: serializedId(message?.from),
      to: serializedId(message?.to),
      author: serializedId(message?.author),
      timestamp: message?.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : null,
      hasMedia: Boolean(message?.hasMedia),
    })),
  };
}

function localWhatsAppOperationRuntime(normalized = "") {
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  return {
    runtime,
    state,
    ready: Boolean(runtime?.client && state.ready),
    staleReadyRuntime: Boolean(state.ready && !runtime?.client),
  };
}

function localWhatsAppNotReadyError(message = "whatsapp_local_bridge_not_ready", statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function listLocalWhatsAppChatParticipants({ accountId = "", chatId = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const { runtime, state, ready, staleReadyRuntime } = localWhatsAppOperationRuntime(normalized);
  if (!ready) {
    if (staleReadyRuntime) {
      return recoverLocalWhatsAppAccountAfterGroupReadError(
        normalized,
        localWhatsAppNotReadyError("whatsapp_local_bridge_stale_runtime"),
        env,
      );
    }
    return { accountId: normalized, chatId: id, ready: false, participants: [] };
  }
  let chat;
  try {
    chat = await runtime.client.getChatById(id);
  } catch (error) {
    if (recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterGroupReadError(normalized, error, env);
    }
    throw error;
  }
  const participants = Array.isArray(chat?.participants)
    ? chat.participants.map((participant) => ({
      id: serializedId(participant?.id || participant),
      name: String(participant?.name || participant?.pushname || participant?.shortName || "").trim(),
      isAdmin: Boolean(participant?.isAdmin),
      isSuperAdmin: Boolean(participant?.isSuperAdmin),
    })).filter((participant) => participant.id)
    : [];
  return {
    accountId: normalized,
    chatId: id,
    ready: Boolean(state.ready),
    participants,
  };
}

/**
 * @param {{ accountId?: string, chatId?: string, participantIds?: string[] | string, autoSendInviteV4?: boolean, comment?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function addLocalWhatsAppGroupParticipants({ accountId = "", chatId = "", participantIds = [], autoSendInviteV4 = true, comment = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  const participants = normalizeGroupParticipantIds(participantIds);
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  if (!participants.length) {
    const error = new Error("whatsapp_group_participants_required");
    error.statusCode = 400;
    throw error;
  }
  const { runtime, ready, staleReadyRuntime } = localWhatsAppOperationRuntime(normalized);
  if (!ready) {
    if (staleReadyRuntime) {
      return recoverLocalWhatsAppAccountAfterGroupParticipantAddError(
        normalized,
        localWhatsAppNotReadyError("whatsapp_local_bridge_stale_runtime"),
        env,
      );
    }
    throw localWhatsAppNotReadyError();
  }
  try {
    const chat = await runtime.client.getChatById(id);
    if (!chat?.isGroup || typeof chat.addParticipants !== "function") {
      const error = new Error("whatsapp_group_chat_required");
      error.statusCode = 400;
      throw error;
    }
    const existing = new Set((Array.isArray(chat.participants) ? chat.participants : [])
      .map((participant) => serializedId(participant?.id || participant).toLowerCase())
      .filter(Boolean));
    const alreadyParticipantIds = participants.filter((participant) => existing.has(participant.toLowerCase()));
    const missingParticipantIds = participants.filter((participant) => !existing.has(participant.toLowerCase()));
    if (!missingParticipantIds.length) {
      return { ok: true, accountId: normalized, chatId: id, participantIds: [], alreadyParticipantIds, result: {} };
    }
    const result = await chat.addParticipants(missingParticipantIds, {
      autoSendInviteV4: autoSendInviteV4 !== false,
      comment: String(comment || ""),
    });
    await appendEvent({
      type: "whatsapp_local_group_participants_added",
      accountId: normalized,
      chatId: id,
      participantIds: missingParticipantIds,
      alreadyParticipantIds,
      result,
    }, env).catch(() => {});
    return { ok: true, accountId: normalized, chatId: id, participantIds: missingParticipantIds, alreadyParticipantIds, result };
  } catch (error) {
    if (recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterGroupParticipantAddError(normalized, error, env);
    }
    throw error;
  }
}

/**
 * @param {{ name?: string, senderAccountId?: string, responderAccountId?: string, participantIds?: string[] | string, adminParticipantIds?: string[] | string, promoteParticipantsAsAdmins?: boolean, generatePicture?: boolean, env?: Record<string, string | undefined> }} [options]
 */
export async function createLocalWhatsAppChat({ name = "", senderAccountId = "", responderAccountId = "", participantIds = [], adminParticipantIds = [], promoteParticipantsAsAdmins = false, generatePicture = true, env = process.env } = {}) {
  const title = String(name || "").trim();
  if (!title) {
    const error = new Error("whatsapp_chat_name_required");
    error.statusCode = 400;
    throw error;
  }
  const participants = normalizeGroupParticipantIds(participantIds);
  const adminParticipants = normalizeGroupParticipantIds(adminParticipantIds);
  const responder = await normalizeManagedAccountId(responderAccountId || senderAccountId || defaultResponderAccountId(env), env);
  const sender = await normalizeManagedAccountId(senderAccountId || responder, env);
  const responderRuntime = runtimes.get(responder);
  const responderState = accountStates.get(responder) || defaultAccountState(responder);
  if (!responderRuntime?.client || !responderState.ready) {
    const error = new Error("whatsapp_responder_account_not_ready");
    error.statusCode = 400;
    throw error;
  }
  const senderRuntime = runtimes.get(sender);
  const senderState = accountStates.get(sender) || defaultAccountState(sender);
  const responderContactId = runtimeIdentity(responderRuntime);
  let senderContactId = sender === responder ? responderContactId : runtimeIdentity(senderRuntime);
  if (participants.length) senderContactId = participants[0];
  if (!senderContactId) {
    const error = new Error(sender === responder ? "whatsapp_account_identity_unavailable" : "whatsapp_sender_account_not_ready");
    error.statusCode = 400;
    throw error;
  }

  let chatId = "";
  let createdGroup = null;
  try {
    if (participants.length) {
      createdGroup = await responderRuntime.client.createGroup(title, participants, { announce: false });
      chatId = groupIdFromCreateResult(createdGroup);
    } else if (sender === responder) {
      chatId = senderContactId;
    } else {
      if (!senderState.ready || !senderRuntime?.client) {
        const error = new Error("whatsapp_sender_account_not_ready");
        error.statusCode = 400;
        throw error;
      }
      createdGroup = await responderRuntime.client.createGroup(title, [senderContactId]);
      chatId = groupIdFromCreateResult(createdGroup);
    }
  } catch (error) {
    if (recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterChatCreateError(responder, error, env);
    }
    throw error;
  }
  if (!chatId) {
    const error = new Error("whatsapp_chat_create_failed");
    error.statusCode = 502;
    throw error;
  }
  const promoteIds = normalizeGroupParticipantIds([
    ...(promoteParticipantsAsAdmins ? participants : []),
    ...adminParticipants,
  ]);
  let adminPromotion = null;
  if (promoteIds.length && isGroupChatId(chatId)) {
    adminPromotion = await promoteLocalWhatsAppGroupParticipants({
      accountId: responder,
      chatId,
      participantIds: promoteIds,
      env,
    }).catch((error) => ({ ok: false, error: error?.message || String(error), participantIds: promoteIds }));
  }
  let picture = null;
  if (generatePicture && isGroupChatId(chatId)) {
    try {
      const dependencies = await loadBridgeDependencies();
      picture = await setGeneratedLocalWhatsAppGroupPicture({
        client: responderRuntime.client,
        MessageMedia: dependencies.whatsapp.MessageMedia,
        chatId,
        title,
        accountId: responder,
        env,
      });
    } catch (error) {
      picture = { updated: false, error: error?.message || String(error) };
      await appendEvent({
        type: "whatsapp_chat_picture_generate_error",
        chatId,
        name: title,
        accountId: responder,
        error: picture.error,
      }, env);
    }
  }
  await appendEvent({
    type: "whatsapp_local_chat_created",
    chatId,
    name: title,
    senderAccountId: sender,
    responderAccountId: responder,
    participantIds: participants,
    adminParticipantIds: adminParticipants,
    promotedParticipantIds: promoteIds,
  }, env);
  return {
    ok: true,
    chat: {
      id: chatId,
      name: title,
      isGroup: isGroupChatId(chatId),
      generated: true,
    },
    senderAccountId: sender,
    responderAccountId: responder,
    senderContactId,
    responderContactId,
    participantIds: participants,
    adminParticipantIds: adminParticipants,
    adminPromotion,
    picture,
    bridgeResponse: createdGroup,
  };
}

export async function generateLocalWhatsAppChatPicture({ accountId = "", chatId = "", title = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  if (!runtime?.client || !state.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  const chat = await runtime.client.getChatById(id);
  const requestedTitle = String(title || chat?.name || chat?.formattedTitle || id).trim();
  const dependencies = await loadBridgeDependencies();
  const picture = await setGeneratedLocalWhatsAppGroupPicture({
    client: runtime.client,
    MessageMedia: dependencies.whatsapp.MessageMedia,
    chatId: id,
    title: requestedTitle,
    accountId: normalized,
    env,
  });
  return { ok: Boolean(picture.updated), chatId: id, title: requestedTitle, ...picture };
}

/**
 * @param {{ accountId?: string, chatId?: string, participantIds?: string[] | string, env?: Record<string, string | undefined> }} [options]
 */
export async function promoteLocalWhatsAppGroupParticipants({ accountId = "", chatId = "", participantIds = [], env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  const participants = normalizeGroupParticipantIds(participantIds);
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  if (!participants.length) {
    const error = new Error("whatsapp_admin_participants_required");
    error.statusCode = 400;
    throw error;
  }
  const { runtime, ready, staleReadyRuntime } = localWhatsAppOperationRuntime(normalized);
  if (!ready) {
    if (staleReadyRuntime) {
      return recoverLocalWhatsAppAccountAfterGroupAdminError(
        normalized,
        localWhatsAppNotReadyError("whatsapp_local_bridge_stale_runtime"),
        env,
      );
    }
    throw localWhatsAppNotReadyError();
  }
  try {
    const chat = await runtime.client.getChatById(id);
    if (!chat?.isGroup || typeof chat.promoteParticipants !== "function") {
      const error = new Error("whatsapp_group_chat_required");
      error.statusCode = 400;
      throw error;
    }
    const result = await chat.promoteParticipants(participants);
    await appendEvent({
      type: "whatsapp_local_group_admins_promoted",
      accountId: normalized,
      chatId: id,
      participantIds: participants,
      result,
    }, env).catch(() => {});
    return { ok: true, accountId: normalized, chatId: id, participantIds: participants, result };
  } catch (error) {
    if (recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterGroupAdminError(normalized, error, env);
    }
    throw error;
  }
}

/**
 * @param {{ accountId?: string, chatId?: string, participantIds?: string[] | string, env?: Record<string, string | undefined> }} [options]
 */
export async function demoteLocalWhatsAppGroupParticipants({ accountId = "", chatId = "", participantIds = [], env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  const participants = normalizeGroupParticipantIds(participantIds);
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  if (!participants.length) {
    const error = new Error("whatsapp_admin_participants_required");
    error.statusCode = 400;
    throw error;
  }
  const { runtime, ready, staleReadyRuntime } = localWhatsAppOperationRuntime(normalized);
  if (!ready) {
    if (staleReadyRuntime) {
      return recoverLocalWhatsAppAccountAfterGroupAdminError(
        normalized,
        localWhatsAppNotReadyError("whatsapp_local_bridge_stale_runtime"),
        env,
      );
    }
    throw localWhatsAppNotReadyError();
  }
  try {
    const chat = await runtime.client.getChatById(id);
    if (!chat?.isGroup || typeof chat.demoteParticipants !== "function") {
      const error = new Error("whatsapp_group_chat_required");
      error.statusCode = 400;
      throw error;
    }
    const result = await chat.demoteParticipants(participants);
    await appendEvent({
      type: "whatsapp_local_group_admins_demoted",
      accountId: normalized,
      chatId: id,
      participantIds: participants,
      result,
    }, env).catch(() => {});
    return { ok: true, accountId: normalized, chatId: id, participantIds: participants, result };
  } catch (error) {
    if (recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterGroupAdminError(normalized, error, env);
    }
    throw error;
  }
}

function recoverableLocalWhatsAppRuntimeError(error) {
  const reason = [
    error?.message,
    error?.stack,
    error?.cause?.message,
    String(error || ""),
  ].filter(Boolean).join("\n").toLowerCase();
  return reason.includes("detached frame") ||
    reason.includes("frame was detached") ||
    reason.includes("target closed") ||
    reason.includes("session closed") ||
    reason.includes("protocol error") ||
    reason.includes("before startcomms") ||
    reason.includes("singletonorthrowifuninitialized") ||
    reason.includes("deprecatedsendstanzaandreturnack") ||
    reason.includes("sendiq called before startcomms") ||
    reason.includes("whatsapp_send_message_timeout") ||
    reason.includes("whatsapp_send_media_timeout") ||
    reason.includes("whatsapp_send_not_confirmed");
}

async function recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env = process.env, options = {}) {
  const eventPrefix = String(options.eventPrefix || "whatsapp_local_runtime_recovery");
  const reason = String(options.reason || "runtime_error");
  const retryMessage = String(options.retryMessage || "whatsapp_local_bridge_not_ready_recovered_after_runtime_error");
  const hooks = runtimeRecoveryHooksForTest || {};
  const restartAccount = hooks.restartAccount || restartRecoverableLocalWhatsAppAccount;
  const startAccount = hooks.startAccount || startLocalWhatsAppAccount;
  await appendEvent({
    type: `${eventPrefix}_start`,
    accountId,
    error: error?.message || String(error),
  }, env).catch(() => {});
  await restartAccount(accountId, env, { reason });
  const account = await startAccount(accountId, env, { showNotification: false });
  await appendEvent({
    type: `${eventPrefix}_started`,
    accountId,
    state: account?.state || "",
    ready: account?.ready === true,
  }, env).catch(() => {});
  const retry = new Error(retryMessage);
  retry.statusCode = 503;
  retry.cause = error;
  throw retry;
}

async function recoverLocalWhatsAppAccountAfterSendError(accountId, error, env = process.env) {
  return recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env, {
    eventPrefix: "whatsapp_local_send_runtime_recovery",
    reason: "send_runtime_error",
    retryMessage: "whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error",
  });
}

async function recoverLocalWhatsAppAccountAfterChatCreateError(accountId, error, env = process.env) {
  return recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env, {
    eventPrefix: "whatsapp_local_chat_create_runtime_recovery",
    reason: "chat_create_runtime_error",
    retryMessage: "whatsapp_local_bridge_not_ready_recovered_after_chat_create_runtime_error",
  });
}

async function recoverLocalWhatsAppAccountAfterGroupReadError(accountId, error, env = process.env) {
  return recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env, {
    eventPrefix: "whatsapp_local_group_read_runtime_recovery",
    reason: "group_read_runtime_error",
    retryMessage: "whatsapp_local_bridge_not_ready_recovered_after_group_read_runtime_error",
  });
}

async function recoverLocalWhatsAppAccountAfterGroupParticipantAddError(accountId, error, env = process.env) {
  return recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env, {
    eventPrefix: "whatsapp_local_group_participant_add_runtime_recovery",
    reason: "group_participant_add_runtime_error",
    retryMessage: "whatsapp_local_bridge_not_ready_recovered_after_group_participant_add_runtime_error",
  });
}

async function recoverLocalWhatsAppAccountAfterGroupAdminError(accountId, error, env = process.env) {
  return recoverLocalWhatsAppAccountAfterRuntimeError(accountId, error, env, {
    eventPrefix: "whatsapp_local_group_admin_runtime_recovery",
    reason: "group_admin_runtime_error",
    retryMessage: "whatsapp_local_bridge_not_ready_recovered_after_group_admin_runtime_error",
  });
}

/**
 * @param {{ chatId?: string, text?: string, accountId?: string, attachments?: Array<Record<string, unknown>>, env?: Record<string, string | undefined>, crossAccountEchoSuppression?: boolean, routeSentMessage?: boolean }} [options]
 */
export async function sendLocalWhatsAppMessage({ chatId = "", text = "", accountId = "", attachments = [], env = process.env, crossAccountEchoSuppression = true, routeSentMessage = false } = {}) {
  const selectedAccountId = accountId
    ? await normalizeManagedAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const runtime = selectedAccountId ? runtimes.get(selectedAccountId) : null;
  const state = selectedAccountId ? accountStates.get(selectedAccountId) : null;
  if (!runtime?.client || !state?.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  await stopLocalWhatsAppTyping({ accountId: selectedAccountId, chatId, env }).catch(() => {});
  const sent = [];
  const routed = [];
  try {
    const cleanText = String(text || "");
    if (cleanText.trim()) {
      const routeOwnText = routeSentMessage === true;
      if (!routeOwnText) {
        rememberOutboundText(selectedAccountId, chatId, cleanText, env, { crossAccount: crossAccountEchoSuppression !== false });
      } else {
        outboundMessageTextKeys.delete(textKey(selectedAccountId, chatId, cleanText));
        outboundMessageTextKeys.delete(anyAccountTextKey(chatId, cleanText));
      }
      const message = await sendWhatsAppTextWithConfirmation({
        client: runtime.client,
        chatId,
        text: cleanText,
        env,
      });
      const messageId = serializedMessageId(message);
      if (routeOwnText) {
        const routableMessage = {
          ...message,
          id: message?.id || { _serialized: messageId },
          fromMe: true,
          to: message?.to || chatId,
          body: sentMessageText(message) || cleanText,
          timestamp: message?.timestamp || Math.floor(Date.now() / 1000),
        };
        const result = await handleInboundMessage(selectedAccountId, routableMessage, env, { client: runtime.client });
        routed.push({
          id: messageId,
          threadId: result?.routed?.threadId || "",
          messageId: result?.routed?.messageId || "",
          skipped: result?.skipped || result?.routed?.skipped || "",
          duplicate: result?.routed?.duplicate === true,
        });
      } else {
        rememberOutboundMessageId(messageId);
      }
      sent.push({
        id: messageId,
        kind: "text",
      });
    }
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.map((attachment) => ({
          ...attachment,
          path: String(attachment?.path || "").trim(),
        })).filter((attachment) => attachment.path)
      : [];
    if (normalizedAttachments.length) {
      const MessageMedia = runtime.MessageMedia || (await loadBridgeDependencies()).whatsapp.MessageMedia;
      for (const attachment of normalizedAttachments) {
        const stat = await fs.stat(attachment.path);
        rememberOutboundAttachment(selectedAccountId, chatId, { ...attachment, size: stat.size }, env, {
          crossAccount: crossAccountEchoSuppression !== false,
        });
        const sourceMedia = MessageMedia.fromFilePath(attachment.path);
        const mimetype = String(attachment.mimetype || sourceMedia?.mimetype || "").toLowerCase();
        const extension = path.extname(attachment.path).toLowerCase();
        const sendMediaAsDocument = !(mimetype.startsWith("image/") || [".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(extension));
        const media = sendMediaAsDocument
          ? sourceMedia
          : new MessageMedia(sourceMedia.mimetype, sourceMedia.data);
        const sendOptions = sendMediaAsDocument ? { sendMediaAsDocument: true } : {};
        const message = await withSendOperationTimeout(
          runtime.client.sendMessage(chatId, media, sendOptions),
          "whatsapp_send_media",
          env,
        );
        rememberOutboundMessageId(message?.id?._serialized);
        sent.push({
          id: String(message?.id?._serialized || ""),
          kind: "attachment",
          path: attachment.path,
          filename: attachment.filename || path.basename(attachment.path),
          mimetype: attachment.mimetype || "",
        });
      }
    }
  } catch (error) {
    if (selectedAccountId && recoverableLocalWhatsAppRuntimeError(error)) {
      return recoverLocalWhatsAppAccountAfterSendError(selectedAccountId, error, env);
    }
    throw error;
  }
  if (!sent.length) {
    const error = new Error("whatsapp_message_text_or_attachment_required");
    error.statusCode = 400;
    throw error;
  }
  return {
    ok: true,
    id: sent.map((entry) => entry.id).find(Boolean) || "",
    ids: sent.map((entry) => entry.id).filter(Boolean),
    accountId: selectedAccountId,
    sent,
    ...(routed.length ? { routed } : {}),
  };
}

export async function sendLocalWhatsAppText(options = {}) {
  return sendLocalWhatsAppMessage(options);
}
