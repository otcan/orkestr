import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  connectorAuthStatus,
  disconnectConnectorAuth,
  startConnectorAuth as beginConnectorAuth,
} from "../../connectors/src/connector-auth.js";
import { startCodexAppServerThread } from "./codex-app-server.js";
import {
  listBrowserSessions,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  restartVirtualBrowser,
  stopVirtualBrowser,
} from "../../browsers/src/browsers.js";
import { operateManagedDesktop } from "../../browsers/src/desktop-operator.js";
import { getGmailMessage, listGmailMessages } from "../../connectors/src/gmail.js";
import {
  createGmailNotificationForPrincipal,
  deleteGmailNotificationForPrincipal,
  listGmailNotificationsForPrincipal,
  runGmailNotificationNowForPrincipal,
  updateGmailNotificationForPrincipal,
} from "./gmail-notifications.js";
import { runTenantApiAgentProfileTool, tenantApiAgentProfileToolDefinitions } from "./tenant-api-agent-profile-tools.js";
import {
  runTenantApiAgentGoogleWorkspaceTool,
  tenantApiAgentGoogleWorkspaceToolDefinitions,
} from "../../connectors/src/google-workspace-api-agent-tools.js";
import { findActionRegistryEntry, listActionRegistry } from "./action-registry.js";
import {
  createAutomationForPrincipal,
  deleteAutomationForPrincipal,
  listAutomationsForPrincipal,
  runAutomationForPrincipal,
  setAutomationEnabledForPrincipal,
  updateAutomationForPrincipal,
} from "./automations.js";
import { doctorAutomationsForPrincipal } from "./automation-doctor.js";
import { runTenantApiAgentTimerTool, tenantApiAgentTimerToolDefinitions } from "./tenant-api-agent-timer-tools.js";
import { whereAmI } from "./whereiam.js";
import { desktopProvisioningMessage } from "./desktop-provisioning.js";
import { createDesktopShare } from "./desktop-shares.js";
import { updateThread } from "./threads.js";
import {
  createUserSkillForPrincipal,
  deleteUserSkillForPrincipal,
  getUserSkillForPrincipal,
  listUserSkillsForPrincipal,
  searchUserSkillsForPrincipal,
  setUserSkillForPrincipal,
  userScopedCapabilityHints,
} from "./user-skills.js";
import { linkUserPrivateIdentity } from "./users.js";
import { fileBrowserRootsForPrincipal, listFilesForPrincipal } from "./workspace-files.js";

function clean(value) {
  return String(value || "").trim();
}

const PROVIDER_SPECIFIC_MODEL_TOOLS = new Set([
  "orkestr_list_action_registry",
  "orkestr_list_timers",
  "orkestr_create_timer",
  "orkestr_delete_timer",
  "orkestr_run_timer",
  "orkestr_modify_gmail_message",
  "orkestr_create_gmail_draft",
  "orkestr_send_gmail_draft",
  "orkestr_send_gmail_message",
  "orkestr_list_google_calendar_events",
  "orkestr_create_google_calendar_event",
  "orkestr_update_google_calendar_event",
  "orkestr_delete_google_calendar_event",
  "orkestr_get_google_drive_file",
  "orkestr_search_gmail",
  "orkestr_read_gmail_message",
  "orkestr_read_latest_gmail_message",
  "orkestr_create_gmail_notification",
  "orkestr_update_gmail_notification",
  "orkestr_list_gmail_notifications",
  "orkestr_delete_gmail_notification",
  "orkestr_run_gmail_notification_now",
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function actionParametersFromJson(value = "") {
  const text = clean(value);
  if (!text) return {};
  try {
    return plainObject(JSON.parse(text));
  } catch {
    const error = new Error("invalid_action_parameters_json");
    error.statusCode = 400;
    throw error;
  }
}

function actionParameters(args = {}) {
  if (typeof args.parameters === "string") return actionParametersFromJson(args.parameters);
  return { ...plainObject(args.parameters) };
}

function actionError(message = "action_not_available", statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function automationArgsForAction(action = {}, parameters = {}, thread = null) {
  const object = clean(action.object).toLowerCase();
  const provider = clean(action.provider).toLowerCase();
  const base = { ...parameters };
  if (provider === "timer" && object === "timer") return { ...base, type: "timer", provider: "timer" };
  if (provider === "gmail" && object === "notification") return { ...base, type: "gmail_notification", provider: "gmail" };
  if (provider === "push" && object === "connector_push") return { ...base, type: "push", provider: clean(base.provider || "gmail") || "gmail" };
  return base;
}

function automationIdArgsForAction(action = {}, parameters = {}) {
  const provider = clean(action.provider).toLowerCase();
  const object = clean(action.object).toLowerCase();
  const type = provider === "timer" && object === "timer"
    ? "timer"
    : provider === "gmail" && object === "notification"
      ? "gmail_notification"
      : provider === "push" && object === "connector_push"
        ? "push"
        : clean(parameters.type);
  const id = clean(parameters.automationId || parameters.id || parameters.timerId || parameters.notificationId);
  return { ...parameters, automationId: id, type };
}

function automationDoctorOptions(context = {}, env = process.env) {
  const principal = context.principal || null;
  return {
    connectorStatusProvider: (provider, connectorPrincipal = principal) => connectorAuthStatus(provider, env, { principal: connectorPrincipal }),
    browserSessionsProvider: () => listBrowserSessions(env, { principal }),
  };
}

async function runAction(args = {}, context = {}, env = process.env) {
  const principal = context.principal || null;
  const thread = context.thread || null;
  const fetchImpl = context.fetchImpl || fetch;
  const action = findActionRegistryEntry({
    actionKey: args.actionKey,
    provider: args.provider,
    verb: args.verb,
    object: args.object,
  });
  if (!action) throw actionError("action_not_found", 404);
  if (action.status && action.status !== "available") {
    return { ok: false, error: "action_not_available", action };
  }
  const parameters = actionParameters(args);
  let result = null;
  if (action.handler === "orkestr_search_gmail") result = await searchGmail(parameters, principal, env, fetchImpl);
  else if (action.handler === "orkestr_read_gmail_message") result = await readGmailMessage(parameters, principal, env, fetchImpl);
  else if (action.handler === "orkestr_read_latest_gmail_message") result = await readLatestGmailMessage(parameters, principal, env, fetchImpl);
  else if (action.handler === "orkestr_create_automation") result = await createAutomationForPrincipal(automationArgsForAction(action, parameters, thread), principal, env, { thread, fetchImpl });
  else if (action.handler === "orkestr_update_automation") result = await updateAutomationForPrincipal(automationIdArgsForAction(action, parameters), principal, env, { thread, fetchImpl });
  else if (action.handler === "orkestr_delete_automation") result = await deleteAutomationForPrincipal(automationIdArgsForAction(action, parameters), principal, env);
  else if (action.handler === "orkestr_pause_automation") result = await setAutomationEnabledForPrincipal(automationIdArgsForAction(action, parameters), false, principal, env);
  else if (action.handler === "orkestr_resume_automation") result = await setAutomationEnabledForPrincipal(automationIdArgsForAction(action, parameters), true, principal, env);
  else if (action.handler === "orkestr_doctor_automations") result = await doctorAutomationsForPrincipal(principal, env, new Date(), automationDoctorOptions(context, env));
  else if (action.handler === "orkestr_run_automation") {
    let sourceItems = Array.isArray(parameters.sourceItems) ? parameters.sourceItems : [];
    if (!sourceItems.length && clean(parameters.sourceItemsJson)) {
      try {
        const parsed = JSON.parse(parameters.sourceItemsJson);
        sourceItems = Array.isArray(parsed) ? parsed : [];
      } catch {
        return { ok: false, error: "invalid_source_items_json", action };
      }
    }
    result = await runAutomationForPrincipal({ ...automationIdArgsForAction(action, parameters), sourceItems }, principal, env, { thread, fetchImpl });
  } else {
    const googleWorkspaceTool = await runTenantApiAgentGoogleWorkspaceTool(action.handler, parameters, { principal, thread, fetchImpl }, env);
    if (googleWorkspaceTool.handled) result = googleWorkspaceTool.result;
  }
  if (!result) throw actionError("action_handler_not_available", 501);
  return {
    ...result,
    ok: result.ok !== false,
    action,
    handler: action.handler,
    result,
  };
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scopedFilePath(rawPath = "", principal = {}, env = process.env) {
  const roots = await fileBrowserRootsForPrincipal(principal, env);
  const requested = clean(rawPath);
  const resolved = path.resolve(requested || roots[0]?.path || "");
  if (!roots.some((root) => pathInside(root.path || root, resolved))) {
    const error = new Error("file_path_forbidden");
    error.statusCode = 403;
    throw error;
  }
  return resolved;
}

function safeText(value = "", max = 60_000) {
  return String(value || "").slice(0, max);
}

function webFetchEnabled(env = process.env) {
  return !falsey(env.ORKESTR_API_AGENT_WEB_FETCH_ENABLED);
}

function webFetchMaxBytes(env = process.env) {
  const value = Number(env.ORKESTR_API_AGENT_WEB_FETCH_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1_000_000) : 300_000;
}

function webFetchTimeoutMs(env = process.env) {
  const value = Number(env.ORKESTR_API_AGENT_WEB_FETCH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30_000) : 15_000;
}

function isPrivateIp(address = "") {
  const ip = clean(address);
  const version = net.isIP(ip);
  if (!version) return false;
  if (version === 4) {
    const parts = ip.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224;
  }
  const normalized = ip.toLowerCase();
  return normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized === "::" ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.");
}

function normalizePublicHttpUrl(rawUrl = "", baseUrl = "") {
  let parsed;
  try {
    parsed = new URL(clean(rawUrl), baseUrl || undefined);
  } catch {
    const error = new Error("invalid_url");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("unsupported_url_protocol");
    error.statusCode = 400;
    throw error;
  }
  const hostname = clean(parsed.hostname).toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIp(hostname)) {
    const error = new Error("url_host_forbidden");
    error.statusCode = 403;
    throw error;
  }
  parsed.hash = "";
  return parsed;
}

async function assertPublicHostname(parsedUrl, env = process.env) {
  if (truthy(env.ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK)) return;
  const records = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true }).catch((error) => {
    const failed = new Error(`url_dns_lookup_failed:${clean(error?.code || error?.message || error)}`);
    failed.statusCode = 502;
    throw failed;
  });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    const error = new Error("url_resolves_to_forbidden_address");
    error.statusCode = 403;
    throw error;
  }
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlToText(html = "", maxChars = 20_000) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n"))
    .trim()
    .slice(0, maxChars);
}

function extractHtmlTitle(html = "") {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities((match?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
}

function extractHtmlLinks(html = "", baseUrl = "", maxLinks = 80) {
  const links = [];
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= maxLinks) break;
    const attrs = match[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = clean(hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3]);
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let url = "";
    try {
      url = new URL(decodeHtmlEntities(href), baseUrl).toString();
    } catch {
      continue;
    }
    const inner = match[2] || "";
    const countMatch = inner.match(/<small[^>]*>\s*([\d.,]+)\s*<\/small>/i);
    const text = decodeHtmlEntities(inner.replace(/<small[\s\S]*?<\/small>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text) continue;
    links.push({
      text: text.slice(0, 500),
      url: url.slice(0, 1000),
      ...(countMatch ? { count: Number(clean(countMatch[1]).replace(/[.,]/g, "")) || null } : {}),
    });
  }
  return links;
}

async function fetchPublicWebPage(args = {}, env = process.env, fetchImpl = fetch) {
  if (!webFetchEnabled(env)) {
    const error = new Error("web_fetch_disabled");
    error.statusCode = 403;
    throw error;
  }
  const maxLinks = Math.max(0, Math.min(120, Number(args.maxLinks) || 80));
  const maxChars = Math.max(1000, Math.min(40_000, Number(args.maxChars) || 20_000));
  const maxBytes = webFetchMaxBytes(env);
  const startedUrl = normalizePublicHttpUrl(args.url);
  let currentUrl = startedUrl;
  let response = null;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    await assertPublicHostname(currentUrl, env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), webFetchTimeoutMs(env));
    try {
      response = await fetchImpl(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "Orkestr API-agent web fetch",
          accept: "text/html,text/plain,application/xhtml+xml",
        },
        signal: controller.signal,
      });
    } catch (error) {
      const failed = new Error(error?.name === "AbortError" ? "web_fetch_timeout" : `web_fetch_failed:${clean(error?.message || error)}`);
      failed.statusCode = error?.name === "AbortError" ? 504 : 502;
      throw failed;
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(Number(response.status))) break;
    const location = response.headers?.get?.("location");
    if (!location) break;
    currentUrl = normalizePublicHttpUrl(location, currentUrl.toString());
    if (redirect === 4) {
      const error = new Error("web_fetch_redirect_limit");
      error.statusCode = 400;
      throw error;
    }
  }
  if (!response?.ok) {
    const error = new Error(`web_fetch_http_${response?.status || "unknown"}`);
    error.statusCode = response?.status || 502;
    throw error;
  }
  const contentType = clean(response.headers?.get?.("content-type")).toLowerCase();
  if (contentType && !/(text\/html|text\/plain|application\/xhtml\+xml)/i.test(contentType)) {
    const error = new Error("web_fetch_unsupported_content_type");
    error.statusCode = 415;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const truncated = buffer.length > maxBytes;
  const body = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    ok: true,
    url: currentUrl.toString(),
    requestedUrl: startedUrl.toString(),
    status: response.status,
    contentType,
    truncated,
    title: extractHtmlTitle(body),
    text: stripHtmlToText(body, maxChars),
    links: extractHtmlLinks(body, currentUrl.toString(), maxLinks),
    fetchedAt: new Date().toISOString(),
  };
}

function safeUrl(value = "") {
  const text = clean(value);
  return /^(https?:|\/)/i.test(text) ? text.slice(0, 1000) : "";
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function falsey(value = "") {
  return ["0", "false", "off", "no"].includes(lower(value));
}

function truthy(value = "") {
  return ["1", "true", "on", "yes"].includes(lower(value));
}

function workspaceRuntimeAvailable(env = process.env) {
  const runtimeCommand = clean(env.ORKESTR_RUNTIME_CODEX_COMMAND);
  const codexBin = clean(env.ORKESTR_CODEX_BIN);
  if (/^__orkestr_codex_disabled/i.test(runtimeCommand)) return false;
  if (/^__orkestr_codex_disabled/i.test(codexBin)) return false;
  if (["0", "false", "off", "no"].includes(lower(env.ORKESTR_CODEX_ESCALATION_ENABLED))) return false;
  return true;
}

function principalUserId(principal = {}) {
  const userId = clean(principal?.userId);
  if (!userId) {
    const error = new Error("user_required");
    error.statusCode = 403;
    throw error;
  }
  return userId;
}

function skillPatchFromArgs(args = {}) {
  const patch = {};
  if (clean(args.name)) patch.name = clean(args.name);
  if (clean(args.description)) patch.description = clean(args.description);
  if (clean(args.instructions)) patch.instructions = clean(args.instructions);
  if (args.enabled !== undefined) patch.enabled = args.enabled === true || args.enabled === "true";
  return patch;
}

async function linkConnectorIdentity(provider = "", account = "", principal = {}, env = process.env, args = {}) {
  const userId = principalUserId(principal);
  const normalizedProvider = clean(provider).toLowerCase();
  const normalizedAccount = clean(account).toLowerCase();
  if (!normalizedAccount) return [];
  return linkUserPrivateIdentity(userId, {
    provider: normalizedProvider,
    accountId: normalizedAccount,
    externalId: normalizedAccount,
    displayName: clean(args.displayName || args.name || normalizedAccount),
    source: "chat",
  }, {
    env,
    actorUserId: userId,
    migrate: args.migrate === true,
  });
}

async function startConnectorAuth(args = {}, principal = {}, env = process.env, fetchImpl = fetch, context = {}) {
  const provider = clean(args.provider).toLowerCase();
  const account = clean(args.account).toLowerCase();
  const oauth = await beginConnectorAuth(args, principal, env, fetchImpl, { thread: context.thread });
  const identities = await linkConnectorIdentity(provider, account, principal, env, args);
  return { ...oauth, identities };
}

function safeLease(lease = null) {
  if (!lease || typeof lease !== "object") return null;
  return {
    desktopSlug: clean(lease.desktopSlug),
    ownerUserId: clean(lease.ownerUserId),
    threadId: clean(lease.threadId),
    threadName: clean(lease.threadName || lease.ownerThreadLabel),
    mode: clean(lease.mode),
    stale: lease.stale === true,
    stealable: lease.stealable === true,
    acquiredAt: clean(lease.acquiredAt),
    heartbeatAt: clean(lease.heartbeatAt),
    expiresAt: clean(lease.expiresAt),
  };
}

function desktopActions(session = {}) {
  const control = session.control && typeof session.control === "object" ? session.control : {};
  const actions = new Set(["status"]);
  const openUrl = safeUrl(session.desk_url || session.url);
  const controllable = Boolean(session.cdp_url || control.start === true);
  if (openUrl || control.start === true) actions.add("open");
  if (control.prepare === true || control.health === true) actions.add("prepare");
  if (control.start === true) actions.add("start");
  if (control.stop === true) actions.add("stop");
  if (control.restart === true) actions.add("restart");
  if (control.start === true) actions.add("open_url");
  if (controllable) {
    actions.add("observe");
    actions.add("navigate");
    actions.add("click");
    actions.add("type");
    actions.add("extract");
  }
  return [...actions];
}

function publicDesktopRecord(session = {}) {
  const slug = clean(session.slug || session.id);
  return {
    slug,
    id: slug,
    label: clean(session.label || slug || "Desktop"),
    type: clean(session.type || "desktop"),
    access: clean(session.access || "desktop"),
    state: clean(session.state || session.status || "unknown"),
    status: clean(session.status || session.state || "unknown"),
    url: safeUrl(session.desk_url || session.url),
    availableActions: desktopActions(session),
    control: {
      prepare: session.control?.prepare === true || session.control?.health === true,
      start: session.control?.start === true,
      stop: session.control?.stop === true,
      restart: session.control?.restart === true,
    },
    lease: safeLease(session.lease),
    leased: session.leased === true,
    leaseOwnerThreadId: clean(session.leaseOwnerThreadId),
    leaseOwnerLabel: clean(session.leaseOwnerLabel),
    notes: clean(session.notes || session.purpose).slice(0, 1000),
    source: clean(session.source),
  };
}

async function createDesktopActionShare(slug = "", label = "", principal = {}, env = process.env) {
  const share = await createDesktopShare({
    desktopSlug: slug,
    principal,
    label: clean(label || slug || "Desktop"),
    env,
  });
  return {
    url: safeUrl(share.url),
    share: share.share || null,
    wildcardSubdomainConfigured: share.wildcardSubdomainConfigured === true,
  };
}

function uniqueClean(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = clean(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function desktopSlugCandidatesForSkill(skill = {}, env = process.env, args = {}) {
  const explicit = clean(args.target || args.slug);
  if (explicit) return [explicit];
  const id = lower(skill.id);
  const required = clean(skill.requiredDesktop || skill.requiresDesktop);
  return uniqueClean([
    required,
    id === "linkedin" ? clean(env.ORKESTR_LINKEDIN_DESKTOP_SLUG || env.ORKESTR_LINKEDIN_BROWSER_SLUG) : "",
    clean(env.ORKESTR_DEFAULT_DESKTOP_SLUG),
    clean(env.ORKESTR_MANUAL_INTERVENTION_DESKTOP_SLUG),
    (id === "linkedin" || required) ? "desktop" : "",
  ]);
}

function genericDesktopFallback(desktops = []) {
  const list = Array.isArray(desktops) ? desktops : [];
  const exact = list.find((desktop) => clean(desktop.slug) === "desktop");
  if (exact) return exact;
  if (list.length !== 1) return null;
  const [only] = list;
  const label = lower(`${only.slug || ""} ${only.label || ""}`);
  if (/(gmail|outlook|mail)/i.test(label)) return null;
  return /desktop|browser|managed/.test(label) ? only : null;
}

function desktopForSkill(skill = {}, desktops = [], env = process.env, args = {}) {
  const list = Array.isArray(desktops) ? desktops : [];
  for (const slug of desktopSlugCandidatesForSkill(skill, env, args)) {
    const desktop = list.find((item) => clean(item.slug) === slug);
    if (desktop) return desktop;
  }
  return clean(args.target || args.slug) ? null : genericDesktopFallback(list);
}

async function safeDesktopInventory(principal = {}, env = process.env) {
  try {
    const payload = await listBrowserSessions(env, { principal });
    return {
      ok: payload?.ok !== false,
      source: clean(payload?.source),
      error: clean(payload?.error),
      message: clean(payload?.message),
      desktops: (payload?.sessions || []).map(publicDesktopRecord).filter((desktop) => desktop.slug),
    };
  } catch (error) {
    return {
      ok: false,
      source: "browser",
      error: clean(error?.message || error || "desktop_inventory_failed"),
      message: clean(error?.message || error || "Desktop inventory failed."),
      desktops: [],
    };
  }
}

function skillActionNames(skill = {}, capabilities = {}, desktops = null, env = process.env) {
  const id = clean(skill.id).toLowerCase();
  if (!skillAvailableFromCapabilities(skill, capabilities)) return ["status"];
  if (id === "whereiam") return ["status"];
  if (id === "files") return capabilities.files === true ? ["list", "read", "write"] : ["status"];
  if (id === "timers") return capabilities.timers === true ? ["list", "create", "update", "pause", "resume", "delete", "run", "automations"] : ["status"];
  if (id === "gmail") return ["status", "search", "read", "notify", "list_notifications", "automations", "actions", "draft", "send", "calendar", "drive_file"];
  if (["outlook", "jira", "shopify", "whatsapp"].includes(id)) return ["status"];
  if (clean(skill.requiresDesktop)) {
    if (!desktops) return ["status", "list_actions"];
    const desktop = desktopForSkill(skill, desktops, env);
    return desktop ? desktop.availableActions : ["status"];
  }
  return ["status"];
}

function skillAvailableFromCapabilities(skill = {}, capabilities = {}) {
  if (skill.enabled !== true) return false;
  const id = clean(skill.id).toLowerCase();
  const connector = clean(skill.requiresConnector).toLowerCase();
  const scopedConnectors = capabilities.scopedConnectors && typeof capabilities.scopedConnectors === "object" ? capabilities.scopedConnectors : {};
  if (connector) return scopedConnectors[connector] === true && capabilities[connector] === true;
  if (clean(skill.requiresDesktop)) return capabilities.desktopLeases === true || capabilities.virtualBrowsers === true || capabilities.linkedin === true;
  if (id === "files") return capabilities.files === true;
  if (id === "timers") return capabilities.timers === true;
  if (id === "whatsapp") return capabilities.whatsapp === true;
  if (id === "gmail") return capabilities.gmail === true;
  if (id === "outlook") return capabilities.outlook === true;
  if (id === "linkedin") return capabilities.linkedin === true || capabilities.desktopLeases === true || capabilities.virtualBrowsers === true;
  if (id === "learning") return capabilities.learning === true;
  return true;
}

async function skillActionInventory(principal = {}, thread = null, env = process.env, options = {}) {
  const userId = principalUserId(principal);
  const listed = await listUserSkillsForPrincipal(userId, principal, env);
  const capabilities = await userScopedCapabilityHints({ userId, thread }, env).catch((error) => ({
    files: false,
    timers: true,
    virtualBrowsers: false,
    desktopLeases: false,
    whatsapp: Boolean(thread?.binding?.connector === "whatsapp" || thread?.binding?.chatId),
    gmail: false,
    outlook: false,
    linkedin: false,
    learning: false,
    enabledSkills: ["timers"],
    disabledSkills: [],
    scopedConnectors: {
      whatsapp: Boolean(thread?.binding?.connector === "whatsapp" || thread?.binding?.chatId),
      gmail: false,
      outlook: false,
      jira: false,
      shopify: false,
      linkedin: false,
    },
    desktopProvisioning: {
      available: false,
      setupState: "instance_desktops_not_provisioned",
      reason: "capability_lookup_failed",
      message: desktopProvisioningMessage("instance_desktops_not_provisioned"),
    },
    capabilityDecision: {
      result: "fallback",
      reason: clean(error?.message || error || "capability_lookup_failed"),
    },
  }));
  const skillFilter = clean(options.skillId).toLowerCase();
  const desktopInventory = options.includeDesktopInventory === true ? await safeDesktopInventory(principal, env) : null;
  const desktops = desktopInventory?.desktops || null;
  const skills = listed.skills
    .filter((skill) => !skillFilter || skill.id === skillFilter)
    .map((skill) => {
      const requiredDesktop = clean(skill.requiresDesktop);
      const matchingDesktop = requiredDesktop && desktops ? desktopForSkill(skill, desktops, env) : null;
      const registryEnabled = skill.enabled === true;
      const capabilityAvailable = skillAvailableFromCapabilities(skill, capabilities);
      const desktopProvisioning = requiredDesktop && capabilities.desktopProvisioning && typeof capabilities.desktopProvisioning === "object"
        ? capabilities.desktopProvisioning
        : null;
      const available = capabilityAvailable && (!requiredDesktop || !desktops || Boolean(matchingDesktop));
      const unavailableReason = available
        ? ""
        : !registryEnabled
          ? "skill_disabled"
          : requiredDesktop && clean(desktopProvisioning?.setupState) && clean(desktopProvisioning?.setupState) !== "available"
            ? clean(desktopProvisioning.setupState)
            : requiredDesktop && desktops && !matchingDesktop
              ? "user_desktop_not_provisioned"
              : "capability_not_available";
      return {
        ...skill,
        registryEnabled,
        available,
        enabled: capabilityAvailable,
        setupState: available ? "available" : unavailableReason,
        message: available ? "" : clean(desktopProvisioning?.message),
        availableActions: skillActionNames(skill, capabilities, desktops, env),
        actionTool: "orkestr_run_skill_action",
        ...(requiredDesktop ? {
          requiredDesktop,
          resolvedDesktop: clean(matchingDesktop?.slug),
          desktops: matchingDesktop ? [matchingDesktop] : [],
        } : {}),
      };
    });
  return {
    ok: true,
    userId,
    skills,
    enabledSkills: capabilities.enabledSkills || [],
    disabledSkills: capabilities.disabledSkills || [],
    availableSkills: skills.filter((skill) => skill.available).map((skill) => skill.id),
    desktopInventory: desktopInventory ? {
      ok: desktopInventory.ok,
      source: desktopInventory.source,
      error: desktopInventory.error,
      message: desktopInventory.message,
      desktops: desktopInventory.desktops,
    } : undefined,
    generatedAt: new Date().toISOString(),
  };
}

async function runSkillAction(args = {}, principal = {}, thread = null, env = process.env, fetchImpl = fetch) {
  const skillId = clean(args.skillId).toLowerCase();
  const action = clean(args.action).toLowerCase();
  if (!skillId) {
    const error = new Error("skill_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!action) {
    const error = new Error("skill_action_required");
    error.statusCode = 400;
    throw error;
  }
  const inventory = await skillActionInventory(principal, thread, env, { skillId, includeDesktopInventory: true });
  const skill = inventory.skills[0] || null;
  if (!skill) {
    const error = new Error("skill_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (action === "status" || action === "list_actions") return { ok: true, action, skill, desktopInventory: inventory.desktopInventory };
  if (clean(skill.requiresDesktop)) {
    const desktops = inventory.desktopInventory?.desktops || [];
    const desktop = desktopForSkill(skill, desktops, env, args);
    const slug = clean(desktop?.slug || args.target || args.slug || skill.requiredDesktop || skill.requiresDesktop);
    if (!desktop) return { ok: false, error: "desktop_not_available", action, skill, desktopInventory: inventory.desktopInventory };
    if (!desktop.availableActions.includes(action)) return { ok: false, error: "skill_action_not_available", action, skill, desktop };
    let result;
    let share = null;
    if (action === "prepare") result = await prepareVirtualBrowser(slug, env, { principal });
    else if (action === "start") result = await openVirtualBrowser(slug, env, "", { principal });
    else if (action === "open") {
      if (desktop.url && !desktop.availableActions.includes("start")) {
        share = await createDesktopActionShare(slug, desktop.label || slug, principal, env);
        return {
          ok: true,
          action,
          skill,
          desktop,
          message: "Desktop is already available.",
          shareUrl: share.url,
          desktopShare: share.share,
          wildcardSubdomainConfigured: share.wildcardSubdomainConfigured,
        };
      }
      result = await openVirtualBrowser(slug, env, "", { principal });
    } else if (action === "open_url") {
      result = await openUrlInVirtualBrowser(slug, args.url, env, { principal });
    } else if (action === "stop") result = await stopVirtualBrowser(slug, env, { principal });
    else if (action === "restart") result = await restartVirtualBrowser(slug, env, { principal });
    else return { ok: false, error: "skill_action_not_implemented", action, skill, desktop };
    if (["open", "start", "open_url"].includes(action)) {
      share = await createDesktopActionShare(slug, result?.label || desktop.label || slug, principal, env);
    }
    return {
      ok: true,
      action,
      skill: { ...skill, desktops: undefined },
      desktop: publicDesktopRecord(result),
      url: "",
      openedUrl: safeUrl(result?.openedUrl),
      shareUrl: share?.url || "",
      desktopShare: share?.share || null,
      wildcardSubdomainConfigured: share?.wildcardSubdomainConfigured === true,
      message: "Skill action completed.",
    };
  }
  return { ok: false, error: "skill_action_not_available", action, skill };
}

async function connectWorkspaceRuntime(args = {}, thread = null, env = process.env) {
  if (!thread?.id) {
    const error = new Error("thread_required");
    error.statusCode = 400;
    throw error;
  }
  if (!workspaceRuntimeAvailable(env)) {
    return { ok: false, error: "workspace_runtime_not_available", connected: false };
  }
  const updated = await updateThread(thread.id, {
    runtimeKind: "codex-app-server",
    executorId: "codex",
    executor: {
      ...(thread.executor || {}),
      type: "codex",
      metadata: {
        ...(thread.executor?.metadata || {}),
        runtimeKind: "codex-app-server",
      },
    },
  }, env);
  const started = await startCodexAppServerThread(updated, env).catch((error) => ({
    ok: false,
    error: clean(error?.message || error || "workspace_runtime_start_failed"),
  }));
  if (started?.ok === false) {
    await updateThread(thread.id, {
      runtimeKind: clean(thread.runtimeKind || thread.runtime?.runtimeKind || "api-agent"),
      executorId: clean(thread.executorId || thread.executor?.id || "api-agent"),
      executor: thread.executor || { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
      runtime: thread.runtime || null,
    }, env).catch(() => null);
    return { ok: false, connected: false, started: false, error: started.error, reason: clean(args.reason) };
  }
  return {
    ok: true,
    connected: true,
    started: true,
    runtimeKind: "codex-app-server",
    reason: clean(args.reason),
  };
}

async function assertConnectorConnected(provider = "", principal = {}, env = process.env) {
  const status = await connectorAuthStatus(provider, env, { principal });
  if (status.connected !== true) {
    const error = new Error(`${provider}_not_connected`);
    error.statusCode = 403;
    throw error;
  }
  return status;
}

function publicGmailMessage(message = {}, options = {}) {
  const includeText = options.includeText === true;
  return {
    id: clean(message.id),
    threadId: clean(message.threadId),
    subject: clean(message.subject),
    from: clean(message.from),
    to: clean(message.to),
    date: clean(message.date),
    internalDate: clean(message.internalDate),
    snippet: clean(message.snippet).slice(0, 1000),
    labelIds: Array.isArray(message.labelIds) ? message.labelIds.slice(0, 20).map(clean).filter(Boolean) : [],
    ...(includeText ? { text: safeText(message.text, 20_000) } : {}),
  };
}

async function searchGmail(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const maxResults = Math.max(1, Math.min(10, Number(args.maxResults) || 5));
  const listed = await listGmailMessages({
    maxResults,
    query: clean(args.query),
  }, env, fetchImpl, { principal });
  const messages = [];
  for (const item of (listed.messages || []).slice(0, maxResults)) {
    const id = clean(item.id);
    if (!id) continue;
    const message = await getGmailMessage(id, env, fetchImpl, { principal });
    messages.push(publicGmailMessage(message));
  }
  return {
    ok: true,
    provider: "gmail",
    query: clean(args.query),
    resultSizeEstimate: listed.resultSizeEstimate || messages.length,
    nextPageToken: clean(listed.nextPageToken),
    messages,
  };
}

async function readGmailMessage(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const message = await getGmailMessage(args.messageId, env, fetchImpl, { principal });
  return {
    ok: true,
    provider: "gmail",
    message: publicGmailMessage(message, { includeText: true }),
  };
}

async function readLatestGmailMessage(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const listed = await listGmailMessages({
    maxResults: 1,
    query: clean(args.query),
  }, env, fetchImpl, { principal });
  const id = clean(listed.messages?.[0]?.id);
  if (!id) {
    return {
      ok: true,
      provider: "gmail",
      query: clean(args.query),
      message: null,
      resultSizeEstimate: listed.resultSizeEstimate || 0,
    };
  }
  const message = await getGmailMessage(id, env, fetchImpl, { principal });
  return {
    ok: true,
    provider: "gmail",
    query: clean(args.query),
    message: publicGmailMessage(message, { includeText: true }),
    resultSizeEstimate: listed.resultSizeEstimate || 1,
  };
}

function gmailNotificationInput(args = {}, thread = null) {
  const targetType = clean(args.targetType || "thread").toLowerCase();
  const target = clean(args.target || (targetType === "thread" ? thread?.id : ""));
  return {
    label: clean(args.label || "Gmail notifications"),
    targetType,
    target,
    query: clean(args.query),
    interval: clean(args.interval || args.every),
    maxItemsPerRun: Number(args.maxItemsPerRun || 1) || 1,
    enabled: args.enabled !== false,
    allowBroadQuery: args.allowBroadQuery === true,
  };
}

function gmailNotificationUpdateInput(args = {}, thread = null) {
  const input = { notificationId: clean(args.notificationId || args.id) };
  if (args.label !== undefined) input.label = clean(args.label);
  if (clean(args.query)) input.query = clean(args.query);
  if (args.useDefaultQuery === true) input.query = "";
  if (clean(args.interval || args.every)) input.interval = clean(args.interval || args.every);
  if (Number(args.maxItemsPerRun || args.maxResults || 0) > 0) input.maxItemsPerRun = Number(args.maxItemsPerRun || args.maxResults || 1) || 1;
  if (args.enabled !== undefined) input.enabled = args.enabled !== false;
  if (args.allowBroadQuery !== undefined) input.allowBroadQuery = args.allowBroadQuery === true;
  if (clean(args.targetType)) input.targetType = clean(args.targetType).toLowerCase();
  if (clean(args.target) || clean(args.threadId) || clean(args.agentId)) {
    const targetType = clean(input.targetType || args.targetType || "thread").toLowerCase();
    input.target = clean(args.target || (targetType === "thread" ? (args.threadId || thread?.id) : args.agentId));
  }
  if (args.promptTemplate !== undefined || args.prompt !== undefined) input.promptTemplate = clean(args.promptTemplate || args.prompt);
  if (args.noReply === true) input.noReply = true;
  if (clean(args.noReplyBehavior)) input.noReplyBehavior = clean(args.noReplyBehavior);
  if (args.fromMe === true) input.fromMe = true;
  if (clean(args.from)) input.from = clean(args.from);
  if (clean(args.fromAddress || args.senderAddress || args.senderEmail)) {
    input.fromAddress = clean(args.fromAddress || args.senderAddress || args.senderEmail);
  }
  if (clean(args.account)) input.account = clean(args.account);
  return input;
}

async function createGmailNotification(args = {}, principal = {}, thread = null, env = process.env) {
  await assertConnectorConnected("gmail", principal, env);
  return {
    ok: true,
    notification: await createGmailNotificationForPrincipal(gmailNotificationInput(args, thread), principal, env, { thread }),
  };
}

async function updateGmailNotification(args = {}, principal = {}, thread = null, env = process.env) {
  await assertConnectorConnected("gmail", principal, env);
  return {
    ok: true,
    notification: await updateGmailNotificationForPrincipal(
      clean(args.notificationId || args.id),
      gmailNotificationUpdateInput(args, thread),
      principal,
      env,
      { thread },
    ),
  };
}

export function tenantApiAgentToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_whereiam",
      description: "Return this tenant's scoped Orkestr runtime context, capabilities, thread, and workspace.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_skills",
      description: "List this user's Orkestr skills, whether each skill is enabled and currently available, and the generic actions each skill may expose. Use this when the user asks what skills or capabilities are available.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    ...tenantApiAgentProfileToolDefinitions(),
    {
      type: "function",
      name: "orkestr_get_skill",
      description: "View one of this user's Orkestr skills by id.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to view." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_search_skills",
      description: "Search this user's Orkestr skills by id, name, description, or instructions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_skill",
      description: "Create a user-specific skill record. Refuse instead of calling this for requests involving scams, credential theft, unauthorized account access, or abuse.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short user-facing skill name." },
          description: { type: "string", description: "What this skill lets the assistant help with for this user." },
          instructions: { type: "string", description: "User-specific operating instructions. Do not include secrets or passwords." },
          enabled: { type: "boolean", description: "Whether the skill should be enabled immediately." },
        },
        required: ["name", "description", "instructions", "enabled"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_skill",
      description: "Update a user-specific Orkestr skill or enable/disable an existing skill.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to update." },
          name: { type: "string", description: "New skill name, or empty string to keep it unchanged." },
          description: { type: "string", description: "New description, or empty string to keep it unchanged." },
          instructions: { type: "string", description: "New instructions, or empty string to keep them unchanged." },
          enabled: { type: "boolean", description: "Whether the skill should be enabled." },
        },
        required: ["skillId", "name", "description", "instructions", "enabled"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_skill",
      description: "Delete a user-created skill. For built-in skills this disables the skill instead of removing the built-in record.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to delete or disable." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_skill_actions",
      description: "Inspect live action availability for one skill, including related desktops when a skill needs a managed desktop. Use this before answering action questions such as whether a skill can open, start, stop, or inspect something.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id to inspect, or empty string to inspect all skills." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_skill_action",
      description: "Run a generic action exposed by an enabled tenant skill. Use only after inspecting skill actions. For managed desktop skills this can start/open/stop/restart the tenant desktop when allowed.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id, for example linkedin." },
          action: { type: "string", enum: ["status", "list_actions", "prepare", "open", "start", "stop", "restart", "open_url"], description: "Action to run." },
          target: { type: "string", description: "Optional target resource such as a desktop slug, or empty string to use the skill default." },
          url: { type: "string", description: "Optional URL for open_url actions, otherwise empty string." },
        },
        required: ["skillId", "action", "target", "url"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_operate_desktop",
      description: "Observe and control a tenant-managed virtual desktop through Orkestr. Use this after inspecting skill actions when the user asks you to work inside a desktop, check login state, gather page data, navigate, click, or type. Returns structured page text, links, buttons, and fields.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Related skill id such as linkedin, or empty string." },
          target: { type: "string", description: "Desktop slug to operate, or empty string to use the skill default." },
          operation: { type: "string", enum: ["observe", "navigate", "click", "type", "extract"], description: "Desktop operation to perform." },
          url: { type: "string", description: "URL for navigate, otherwise empty string." },
          selector: { type: "string", description: "CSS selector for click/type, otherwise empty string." },
          text: { type: "string", description: "Visible text to click, or optional note for observe/extract." },
          field: { type: "string", description: "Field label/name/placeholder for type, otherwise empty string." },
          value: { type: "string", description: "Value to type into the field, otherwise empty string." },
          waitMs: { type: "number", description: "Optional wait after the operation in milliseconds." },
          maxText: { type: "number", description: "Maximum page text characters to return." },
        },
        required: ["skillId", "target", "operation", "url", "selector", "text", "field", "value", "waitMs", "maxText"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_connect_workspace_runtime",
      description: "Connect this chat to the stronger workspace runtime for future messages. Use only after the user explicitly asks to connect/bind Codex or accepts a suggestion to switch this chat to Codex.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short reason the user gave for connecting the workspace runtime." },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_fetch_web_page",
      description: "Fetch a public HTTP(S) web page and return safe extracted title, text, and links. Use this for current public page content when the user asks to inspect a public site. Do not use it for private, internal, account-only, or authenticated URLs.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http(s) URL to fetch." },
          maxLinks: { type: "number", description: "Maximum links to return, from 0 to 120." },
          maxChars: { type: "number", description: "Maximum extracted text characters to return, from 1000 to 40000." },
        },
        required: ["url", "maxLinks", "maxChars"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_files",
      description: "List files and directories inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional absolute or scoped path to list." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_file",
      description: "Read a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_write_file",
      description: "Write a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          text: { type: "string", description: "UTF-8 text content to write." },
        },
        required: ["path", "text"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_actions",
      description: "List the tenant action registry as provider + verb + object + actionKey + options. Use this before running tenant-scoped Gmail, Calendar, Drive, timer, push, Jira, Outlook, or WhatsApp actions.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Optional provider filter such as gmail, outlook, calendar, jira, whatsapp, drive, timer, or push. Empty string returns all providers." },
          verb: { type: "string", description: "Optional verb filter such as list, read, create, update, delete, send, run, watch, pause, or resume. Empty string returns all verbs." },
          object: { type: "string", description: "Optional object filter such as message, event, issue, chat, notification, timer, connector_push, or file. Empty string returns all objects." },
        },
        required: ["provider", "verb", "object"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_action",
      description: "Run one available tenant action from orkestr_list_actions. Use actionKey when available, or provider + verb + object, and put provider-specific inputs under parameters.",
      parameters: {
        type: "object",
        properties: {
          actionKey: { type: "string", description: "Stable action key from orkestr_list_actions, such as gmail.search.message. Use empty string when provider/verb/object are supplied instead." },
          provider: { type: "string", description: "Provider such as gmail, calendar, drive, timer, or push. Use empty string when actionKey is supplied." },
          verb: { type: "string", description: "Action verb such as search, read, create, update, delete, run, send, watch, or modify. Use empty string when actionKey is supplied." },
          object: { type: "string", description: "Action object such as message, event, file, timer, notification, or connector_push. Use empty string when actionKey is supplied." },
          idempotencyKey: { type: "string", description: "Optional stable key for retried user requests; empty string when not available." },
          parameters: { type: "string", description: "JSON object string with provider-specific action parameters matching the selected action options. Use \"{}\" when no parameters are needed." },
        },
        required: ["actionKey", "provider", "verb", "object", "idempotencyKey", "parameters"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_action_registry",
      description: "Legacy alias for listing the action registry. Prefer orkestr_list_actions.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Optional provider filter." },
          verb: { type: "string", description: "Optional verb filter." },
          object: { type: "string", description: "Optional object filter." },
        },
        required: ["provider", "verb", "object"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_automations",
      description: "List this tenant's timers and connector prompt pushes in one normalized automation list.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_automation",
      description: "Create a timer, Gmail notification, or connector prompt push. Timers are prompts that fire into a target chat/thread and can call tools when they run. Use this when the user asks to add, create, schedule, watch, notify, monitor, or push updates.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["timer", "gmail_notification", "push"], description: "Automation type to create." },
          provider: { type: "string", enum: ["", "gmail", "outlook", "calendar", "jira", "whatsapp", "drive", "timer", "push"], description: "Connector provider. Use gmail for Gmail notifications or Gmail prompt pushes, timer for timers, empty string when not applicable." },
          label: { type: "string", description: "Short automation label." },
          targetType: { type: "string", enum: ["thread", "agent"], description: "Usually thread for the current chat." },
          target: { type: "string", description: "Target thread or agent id. Use empty string to target the current chat." },
          cadence: { type: "string", enum: ["", "once", "daily", "weekly", "interval"], description: "Timer cadence, or empty string for non-timers." },
          delay: { type: "string", description: "Relative one-shot timer delay, or empty string." },
          runAt: { type: "string", description: "Absolute one-shot timer ISO time, or empty string." },
          time: { type: "string", description: "Daily/weekly timer clock time, or empty string." },
          timezone: { type: "string", description: "IANA timezone for clock timers, or empty string." },
          every: { type: "string", description: "Interval expression for timers or pushes, such as 5m, 1h, or 1d. Empty string when unused." },
          prompt: { type: "string", description: "Timer prompt or connector push prompt. For timer automations, this is the instruction injected when the timer fires." },
          promptTemplate: { type: "string", description: "Connector push prompt template, or empty string." },
          query: { type: "string", description: "Connector source query, such as a Gmail search query. Empty string uses the safe default for Gmail notifications." },
          maxItemsPerRun: { type: "number", description: "Maximum source items per run, 1 to 5." },
          enabled: { type: "boolean", description: "Whether the automation starts enabled." },
          allowBroadQuery: { type: "boolean", description: "True only when the user explicitly asks for a broad query." },
        },
        required: ["type", "provider", "label", "targetType", "target", "cadence", "delay", "runAt", "time", "timezone", "every", "prompt", "promptTemplate", "query", "maxItemsPerRun", "enabled", "allowBroadQuery"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_automation",
      description: "Modify an existing timer, Gmail notification, or connector prompt push. Use automation ids returned by orkestr_list_automations, such as timer:<id>, gmail_notification:<id>, or push:<id>.",
      parameters: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation id, preferably prefixed with timer:, gmail_notification:, or push:." },
          type: { type: "string", enum: ["", "timer", "gmail_notification", "push"], description: "Automation type when automationId is not prefixed. Empty string when prefixed." },
          label: { type: "string", description: "Replacement label, or empty string to keep existing." },
          targetType: { type: "string", enum: ["", "thread", "agent"], description: "Replacement target type, or empty string." },
          target: { type: "string", description: "Replacement target id, or empty string." },
          cadence: { type: "string", enum: ["", "once", "daily", "weekly", "interval"], description: "Replacement timer cadence, or empty string." },
          delay: { type: "string", description: "Replacement one-shot delay, or empty string." },
          runAt: { type: "string", description: "Replacement absolute one-shot ISO time, or empty string." },
          time: { type: "string", description: "Replacement clock time, or empty string." },
          timezone: { type: "string", description: "Replacement IANA timezone, or empty string." },
          every: { type: "string", description: "Replacement interval expression, or empty string." },
          prompt: { type: "string", description: "Replacement timer or push prompt, or empty string." },
          promptTemplate: { type: "string", description: "Replacement push prompt template, or empty string." },
          query: { type: "string", description: "Replacement connector query, or empty string." },
          maxItemsPerRun: { type: "number", description: "Replacement max items per run. Use 0 to keep existing." },
          enabled: { type: "string", enum: ["", "true", "false"], description: "Replacement enabled state. Use empty string to keep existing." },
          allowBroadQuery: { type: "string", enum: ["", "true", "false"], description: "True only when broad query is explicitly requested. Use empty string to keep existing." },
          noReplyBehavior: { type: "string", enum: ["", "suppress"], description: "Optional connector push no-reply behavior." },
        },
        required: ["automationId", "type", "label", "targetType", "target", "cadence", "delay", "runAt", "time", "timezone", "every", "prompt", "promptTemplate", "query", "maxItemsPerRun", "enabled", "allowBroadQuery", "noReplyBehavior"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_automation",
      description: "Delete an existing timer, Gmail notification, or connector prompt push.",
      parameters: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation id, preferably prefixed with timer:, gmail_notification:, or push:." },
          type: { type: "string", enum: ["", "timer", "gmail_notification", "push"], description: "Automation type when automationId is not prefixed. Empty string when prefixed." },
        },
        required: ["automationId", "type"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_automation",
      description: "Run an existing timer, Gmail notification, or connector prompt push now. Timers enqueue their prompt into the target chat/thread; Gmail notifications poll Gmail; connector pushes use provided sourceItems.",
      parameters: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation id, preferably prefixed with timer:, gmail_notification:, or push:." },
          type: { type: "string", enum: ["", "timer", "gmail_notification", "push"], description: "Automation type when automationId is not prefixed. Empty string when prefixed." },
          force: { type: "boolean", description: "Bypass min-interval safety when supported." },
          sourceItemsJson: { type: "string", description: "JSON array of source items for connector prompt pushes. Use [] for timers and Gmail notifications." },
        },
        required: ["automationId", "type", "force", "sourceItemsJson"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_pause_automation",
      description: "Disable a timer, Gmail notification, or connector prompt push without deleting it.",
      parameters: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation id, preferably prefixed with timer:, gmail_notification:, or push:." },
          type: { type: "string", enum: ["", "timer", "gmail_notification", "push"], description: "Automation type when automationId is not prefixed. Empty string when prefixed." },
        },
        required: ["automationId", "type"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_resume_automation",
      description: "Re-enable a paused timer, Gmail notification, or connector prompt push.",
      parameters: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation id, preferably prefixed with timer:, gmail_notification:, or push:." },
          type: { type: "string", enum: ["", "timer", "gmail_notification", "push"], description: "Automation type when automationId is not prefixed. Empty string when prefixed." },
        },
        required: ["automationId", "type"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_doctor_automations",
      description: "Inspect timers, Gmail notification watches, connector prompt pushes, required connectors, required desktops, overdue schedules, paused state, and previous run errors for this tenant.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_start_connector_auth",
      description: "Start user-owned, tenant-scoped Gmail, Outlook, Jira, or Shopify sign-in from this chat using the parent Orkestr connector app. Use this when the user asks to connect, sign in, log in, set up, or reconnect one of these connectors. Do not describe this as admin setup.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify"], description: "Connector provider to sign in." },
          account: { type: "string", description: "Email/account hint. For Gmail sign-in, ask the user for the exact Gmail address before starting auth if they did not provide one." },
          shop: { type: "string", description: "Shopify shop domain/name for Shopify sign-in, or empty string for other providers." },
        },
        required: ["provider", "account", "shop"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_connector_status",
      description: "Return safe connection and setup state for a tenant connector without reading connector data or exposing tokens. Use this when the user asks whether a connector is connected, available, enabled, configured, accessible, or usable.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify", "whatsapp"], description: "Connector provider to inspect." },
        },
        required: ["provider"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_search_gmail",
      description: "Search or list this user's scoped Gmail messages. Returns safe metadata and snippets, not full message bodies. Use this when Gmail capability is true and the user asks for latest mail, unread mail, or a Gmail search.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query. Use an empty string for latest messages." },
          maxResults: { type: "number", description: "Maximum messages to return, 1 to 10." },
        },
        required: ["query", "maxResults"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_gmail_message",
      description: "Read one full scoped Gmail message by id for this user. Use after orkestr_search_gmail or when private connector notification context supplies a Gmail message id and the user asks to open, read, summarize, extract details from, or act on that message.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Gmail message id returned by orkestr_search_gmail." },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_latest_gmail_message",
      description: "Read the latest full scoped Gmail message matching an optional Gmail query. Use this directly when Gmail capability is true and the user asks to read or summarize the latest, most recent, unread, or searched email.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional Gmail search query. Use an empty string for the latest message overall." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_gmail_notification",
      description: "Create a persisted background Gmail notification rule for this chat. Use immediately when the user asks to notify, alert, push, monitor, or periodically check new Gmail; do not ask for yes/no confirmation when the safe defaults are enough. Default query is scoped to recent unread mail; do not request broad all-mail notifications unless the user explicitly asks.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short notification label." },
          query: { type: "string", description: "Gmail search query. Use empty string for the safe default recent unread query." },
          interval: { type: "string", description: "Polling interval such as 5m, 15m, 1h. Values below the configured minimum are rounded up." },
          targetType: { type: "string", enum: ["thread", "agent"], description: "Usually thread for the current chat." },
          target: { type: "string", description: "Target thread or agent id. Use empty string to target the current chat." },
          maxItemsPerRun: { type: "number", description: "Maximum new messages to deliver per run, 1 to 5." },
          enabled: { type: "boolean", description: "Whether the notification should start enabled." },
          allowBroadQuery: { type: "boolean", description: "True only when the user explicitly requests a broad all-mail query." },
        },
        required: ["label", "query", "interval", "targetType", "target", "maxItemsPerRun", "enabled", "allowBroadQuery"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_gmail_notification",
      description: "Update one persisted Gmail background notification rule for this chat. Use this when the user asks to change, narrow, mute, silence, disable, re-enable, or retarget an existing Gmail notification. If notificationId is empty and exactly one rule exists for this chat, that rule is updated; if multiple match, the tool returns a selection error. Use noReply/noReplyBehavior=suppress for silent rules that should not send a chat message unless a later tool action produces a real answer.",
      parameters: {
        type: "object",
        properties: {
          notificationId: { type: "string", description: "Notification id to update. Use empty string to update the single matching current-chat rule." },
          label: { type: "string", description: "Optional replacement label. Empty means keep the current label." },
          query: { type: "string", description: "Optional replacement Gmail search query. Empty means keep the current query." },
          useDefaultQuery: { type: "boolean", description: "True to reset the rule to the safe default recent unread query." },
          interval: { type: "string", description: "Optional polling interval such as 5m, 15m, 1h." },
          targetType: { type: "string", enum: ["", "thread", "agent"], description: "Optional replacement target type. Empty means keep current." },
          target: { type: "string", description: "Optional replacement target id. Empty means keep the current target unless targetType is explicitly supplied for the current chat." },
          maxItemsPerRun: { type: "number", description: "Optional maximum new messages to deliver per run, 1 to 5." },
          enabled: { type: "boolean", description: "Optional enabled state." },
          allowBroadQuery: { type: "boolean", description: "True only when the user explicitly requests a broad all-mail query." },
          fromMe: { type: "boolean", description: "True when the user explicitly wants the rule to match mail sent by their own Gmail account." },
          fromAddress: { type: "string", description: "Exact sender email address to use with fromMe or sender-scoped rules." },
          account: { type: "string", description: "Gmail account address hint for fromMe and scoped account selection." },
          promptTemplate: { type: "string", description: "Optional prompt template. Use NO_REPLY only when the user wants silent notification processing." },
          noReply: { type: "boolean", description: "True to set the notification prompt to NO_REPLY and suppress visible chat output." },
          noReplyBehavior: { type: "string", enum: ["", "suppress"], description: "Set to suppress for silent notification rules." },
        },
        required: ["notificationId"],
        additionalProperties: false,
      },
      strict: false,
    },
    {
      type: "function",
      name: "orkestr_list_gmail_notifications",
      description: "List this tenant's persisted Gmail background notification rules.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_gmail_notification",
      description: "Delete one of this tenant's Gmail background notification rules.",
      parameters: {
        type: "object",
        properties: {
          notificationId: { type: "string", description: "Gmail notification id to delete." },
        },
        required: ["notificationId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_gmail_notification_now",
      description: "Run one of this tenant's Gmail background notification rules immediately.",
      parameters: {
        type: "object",
        properties: {
          notificationId: { type: "string", description: "Gmail notification id to run now." },
        },
        required: ["notificationId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_disconnect_connector",
      description: "Disconnect this user's scoped connector token or pending OAuth state. This does not alter parent app credentials.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify"], description: "Connector provider to disconnect." },
          account: { type: "string", description: "Optional account hint for user-facing confirmation, or empty string." },
        },
        required: ["provider", "account"],
        additionalProperties: false,
      },
      strict: true,
    },
  ].filter((tool) => !PROVIDER_SPECIFIC_MODEL_TOOLS.has(tool.name));
}

export async function runTenantApiAgentTool(name = "", args = {}, context = {}, env = process.env) {
  const principal = context.principal || null;
  const thread = context.thread || null;
  const tool = clean(name);
  if (tool === "orkestr_whereiam") {
    return whereAmI({ threadId: thread?.id || "", cwd: thread?.cwd || thread?.workspace || "", principal }, env);
  }
  if (tool === "orkestr_list_skills") {
    return skillActionInventory(principal, thread, env, { includeDesktopInventory: false });
  }
  const profileTool = await runTenantApiAgentProfileTool(tool, args, { principal }, env);
  if (profileTool.handled) return profileTool.result;
  if (tool === "orkestr_get_skill") {
    return getUserSkillForPrincipal(principalUserId(principal), args.skillId, principal, env);
  }
  if (tool === "orkestr_search_skills") {
    return searchUserSkillsForPrincipal(principalUserId(principal), args.query, principal, env);
  }
  if (tool === "orkestr_create_skill") {
    return createUserSkillForPrincipal(principalUserId(principal), {
      ...skillPatchFromArgs(args),
      createdBy: "chat",
    }, principal, env);
  }
  if (tool === "orkestr_update_skill") {
    return setUserSkillForPrincipal(principalUserId(principal), args.skillId, skillPatchFromArgs(args), principal, env);
  }
  if (tool === "orkestr_delete_skill") {
    return deleteUserSkillForPrincipal(principalUserId(principal), args.skillId, principal, env);
  }
  if (tool === "orkestr_list_skill_actions") {
    return skillActionInventory(principal, thread, env, { skillId: args.skillId, includeDesktopInventory: true });
  }
  if (tool === "orkestr_run_skill_action") {
    return runSkillAction(args, principal, thread, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_operate_desktop") {
    const skillId = clean(args.skillId).toLowerCase();
    let slug = clean(args.target || args.slug);
    if (!slug && skillId) {
      const inventory = await skillActionInventory(principal, thread, env, { skillId, includeDesktopInventory: true });
      const skill = inventory.skills[0] || null;
      const desktop = skill ? desktopForSkill(skill, inventory.desktopInventory?.desktops || [], env, args) : null;
      slug = clean(desktop?.slug || skill?.resolvedDesktop || skill?.requiresDesktop || skill?.requiredDesktop);
    }
    return operateManagedDesktop(slug, {
      operation: args.operation,
      url: args.url,
      selector: args.selector,
      text: args.text,
      field: args.field,
      target: args.field || args.target,
      value: args.value,
      waitMs: args.waitMs,
      maxText: args.maxText,
    }, env, { principal });
  }
  if (tool === "orkestr_connect_workspace_runtime") {
    return connectWorkspaceRuntime(args, thread, env);
  }
  if (tool === "orkestr_fetch_web_page") {
    return fetchPublicWebPage(args, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_list_files") {
    return listFilesForPrincipal(clean(args.path), principal, env);
  }
  if (tool === "orkestr_read_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      const error = new Error("not_a_file");
      error.statusCode = 400;
      throw error;
    }
    if (stats.size > 256 * 1024) {
      const error = new Error("file_too_large");
      error.statusCode = 413;
      throw error;
    }
    return {
      path: filePath,
      text: await fs.readFile(filePath, "utf8"),
      size: stats.size,
    };
  }
  if (tool === "orkestr_write_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, safeText(args.text), "utf8");
    const stats = await fs.stat(filePath).catch(() => null);
    return { ok: true, path: filePath, size: stats?.size ?? null };
  }
  const timerTool = await runTenantApiAgentTimerTool(tool, args, { principal, thread }, env);
  if (timerTool.handled) return timerTool.result;
  if (tool === "orkestr_list_actions" || tool === "orkestr_list_action_registry") {
    return { ok: true, actions: listActionRegistry(args) };
  }
  if (tool === "orkestr_run_action") {
    return runAction(args, { principal, thread, fetchImpl: context.fetchImpl || fetch }, env);
  }
  if (tool === "orkestr_list_automations") {
    return { ok: true, automations: await listAutomationsForPrincipal(principal, env) };
  }
  if (tool === "orkestr_create_automation") {
    return createAutomationForPrincipal(args, principal, env, { thread, fetchImpl: context.fetchImpl || fetch });
  }
  if (tool === "orkestr_update_automation") {
    return updateAutomationForPrincipal(args, principal, env, { thread, fetchImpl: context.fetchImpl || fetch });
  }
  if (tool === "orkestr_delete_automation") {
    return deleteAutomationForPrincipal(args, principal, env);
  }
  if (tool === "orkestr_run_automation") {
    let sourceItems = [];
    if (clean(args.sourceItemsJson)) {
      try {
        const parsed = JSON.parse(args.sourceItemsJson);
        sourceItems = Array.isArray(parsed) ? parsed : [];
      } catch {
        return { ok: false, error: "invalid_source_items_json" };
      }
    }
    return runAutomationForPrincipal({ ...args, sourceItems }, principal, env, { thread, fetchImpl: context.fetchImpl || fetch });
  }
  if (tool === "orkestr_pause_automation") {
    return setAutomationEnabledForPrincipal(args, false, principal, env);
  }
  if (tool === "orkestr_resume_automation") {
    return setAutomationEnabledForPrincipal(args, true, principal, env);
  }
  if (tool === "orkestr_doctor_automations") {
    return doctorAutomationsForPrincipal(principal, env, new Date(), automationDoctorOptions({ principal }, env));
  }
  const googleWorkspaceTool = await runTenantApiAgentGoogleWorkspaceTool(tool, args, { principal, thread, fetchImpl: context.fetchImpl || fetch }, env);
  if (googleWorkspaceTool.handled) return googleWorkspaceTool.result;
  if (tool === "orkestr_start_connector_auth") {
    return startConnectorAuth(args, principal, env, context.fetchImpl || fetch, context);
  }
  if (tool === "orkestr_connector_status") {
    return connectorAuthStatus(args.provider, env, { principal });
  }
  if (tool === "orkestr_search_gmail") {
    return searchGmail(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_read_gmail_message") {
    return readGmailMessage(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_read_latest_gmail_message") {
    return readLatestGmailMessage(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_create_gmail_notification") {
    return createGmailNotification(args, principal, thread, env);
  }
  if (tool === "orkestr_update_gmail_notification") {
    return updateGmailNotification(args, principal, thread, env);
  }
  if (tool === "orkestr_list_gmail_notifications") {
    return { ok: true, notifications: await listGmailNotificationsForPrincipal(principal, env) };
  }
  if (tool === "orkestr_delete_gmail_notification") {
    return { ok: await deleteGmailNotificationForPrincipal(args.notificationId, principal, env) };
  }
  if (tool === "orkestr_run_gmail_notification_now") {
    return runGmailNotificationNowForPrincipal(args.notificationId, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_disconnect_connector") {
    return disconnectConnectorAuth(args, principal, env);
  }
  const error = new Error("api_agent_tool_not_allowed");
  error.statusCode = 403;
  throw error;
}
