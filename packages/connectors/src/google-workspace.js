import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths, listConnectorScopePaths } from "./connector-storage.js";
import {
  encryptBrokerClientPayload,
  ensureBrokerClientRegistration,
} from "../../core/src/broker-instance-registry.js";
import { getGmailAccessToken, readGmailToken, startGmailOAuth } from "./gmail.js";
import {
  googleWorkspaceCapabilityDefinitions,
  googleWorkspaceCapabilityDisclosure,
  googleWorkspaceCapabilityLabels,
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceScopesForCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "./google-workspace-scopes.js";

export { googleWorkspaceConnectHtml } from "./google-workspace-connect-page.js";

const connectFileName = "google-workspace-connect.json";
const gmailApiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendarApiBase = "https://www.googleapis.com/calendar/v3";
const driveApiBase = "https://www.googleapis.com/drive/v3";

function clean(value) {
  return String(value || "").trim();
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso(ttlMs) {
  return new Date(nowMs() + ttlMs).toISOString();
}

function parseTimeMs(value = "") {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function connectLinkTtlMs(env = process.env) {
  const minutes = Number(env.ORKESTR_GOOGLE_WORKSPACE_CONNECT_TTL_MINUTES || 30);
  return Math.max(1, Math.min(240, Number.isFinite(minutes) ? minutes : 30)) * 60_000;
}

function connectorError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePublicUrl(value = "") {
  const text = clean(value).replace(/\/+$/g, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.toString().replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function publicUrlOrigin(value = "") {
  const normalized = normalizePublicUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).origin.replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function publicAppBaseUrl(env = process.env) {
  return clean(
    env.ORKESTR_CONNECT_PUBLIC_URL ||
      env.ORKESTR_PUBLIC_HTTPS_URL ||
      env.ORKESTR_PUBLIC_URL ||
      env.ORKESTR_BASE_URL ||
      env.ORKESTR_APP_URL,
  ).replace(/\/+$/g, "");
}

function publicBrokeredGoogleWorkspaceBaseUrl(env = process.env) {
  return normalizePublicUrl(env.ORKESTR_GOOGLE_WORKSPACE_CONNECT_PUBLIC_URL) ||
    publicUrlOrigin(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL || env.ORKESTR_PAIRING_URL || env.ORKESTR_AUTH_URL) ||
    normalizePublicUrl(
      env.ORKESTR_PUBLIC_APP_URL ||
        env.ORKESTR_PUBLIC_URL ||
        env.ORKESTR_APP_URL ||
        env.ORKESTR_PUBLIC_HTTPS_URL ||
        env.ORKESTR_HTTPS_URL ||
        env.ORKESTR_TAILSCALE_HTTPS_NAME ||
        env.ORKESTR_BASE_URL,
    );
}

function publicConnectUrl(pathname = "", env = process.env, options = {}) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const base = options.brokered === true
    ? publicBrokeredGoogleWorkspaceBaseUrl(env) || publicAppBaseUrl(env)
    : publicAppBaseUrl(env);
  if (!base) return path;
  try {
    return new URL(path, `${base}/`).toString();
  } catch {
    return path;
  }
}

export function googleWorkspaceBrokeredConnectorSetupPath(result = {}, connector = "gmail") {
  const instanceId = clean(result.brokerInstanceId || result.instanceId);
  if (!instanceId) return "";
  const service = clean(connector) || "gmail";
  const userId = clean(result.brokerTenantUserId || result.userId);
  const thread = clean(result.brokerTenantThreadName || result.threadName || result.threadTitle || result.brokerTenantThreadId || result.threadId);
  const target = new URL(`/i/${encodeURIComponent(instanceId)}/app/connectors/${encodeURIComponent(service)}`, "http://localhost");
  target.searchParams.set("mcp", "tools/call");
  target.searchParams.set("tool", "orkestr_auth");
  target.searchParams.set("service", service);
  if (service === "gmail") {
    target.searchParams.set("provider", "google_workspace");
    target.searchParams.set("action", "connect");
  }
  target.searchParams.set("instance_id", instanceId);
  if (userId) target.searchParams.set("user_id", userId);
  if (thread) target.searchParams.set("thread", thread);
  if (clean(result.connectId)) target.searchParams.set("connect", clean(result.connectId));
  target.searchParams.set("auto", "0");
  return `${target.pathname}${target.search}`;
}

export function googleWorkspaceBrokeredConnectorSetupHref(result = {}, env = process.env, connector = "gmail") {
  const path = googleWorkspaceBrokeredConnectorSetupPath(result, connector);
  if (!path) return "";
  return publicConnectUrl(path, env, { brokered: true });
}

function brokeredGoogleWorkspaceConnectEnabled(env = process.env) {
  if (!clean(env.ORKESTR_TENANT_VM_ID)) return false;
  if (truthy(env.ORKESTR_GOOGLE_WORKSPACE_LOCAL_OAUTH)) return false;
  return Boolean(clean(env.ORKESTR_BROKER_BASE_URL || env.ORKESTR_DEMO_BROKER_BASE_URL));
}

async function createBrokeredGoogleWorkspaceConnectLink({
  principal = {},
  thread = {},
  chatId = "",
  accountId = "",
  account = "",
} = {}, env = process.env) {
  const registration = await ensureBrokerClientRegistration(env);
  if (registration?.ok === false || !registration?.instanceId || !registration?.brokerBaseUrl) {
    throw connectorError(registration?.reason || "broker_google_workspace_registration_required", Number(registration?.status || 409) || 409);
  }
  const scope = await connectorScopePaths(env, { principal });
  const threadBinding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const request = {
    tenantVmId: clean(env.ORKESTR_TENANT_VM_ID),
    userId: scope.userId || clean(principal?.userId),
    threadId: clean(thread.id),
    threadName: clean(thread.name || thread.title || thread.displayName),
    chatId: clean(chatId || threadBinding.chatId),
    accountId: clean(accountId || threadBinding.responderAccountId || threadBinding.outboundAccountId),
    account: clean(account).toLowerCase(),
    source: "tenant_whatsapp",
  };
  const body = await encryptBrokerClientPayload(request, registration, env);
  const url = new URL(`/api/broker/instances/${encodeURIComponent(registration.instanceId)}/google-workspace/connect-link`, registration.brokerBaseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw connectorError(payload?.error || payload?.message || `broker_google_workspace_connect_http_${response.status}`, response.status || 502);
  }
  return payload;
}

async function readConnectLedger(scope) {
  const ledger = await readJson(connectorFile(scope, "oauth", connectFileName), { requests: [] });
  return {
    schemaVersion: 1,
    requests: Array.isArray(ledger.requests) ? ledger.requests : [],
  };
}

async function writeConnectLedger(scope, ledger) {
  await writeJson(connectorFile(scope, "oauth", connectFileName), {
    schemaVersion: 1,
    requests: Array.isArray(ledger.requests) ? ledger.requests.slice(-100) : [],
    updatedAt: nowIso(),
  });
}

async function findConnectRequest(connectId = "", env = process.env) {
  const id = clean(connectId);
  if (!id) throw connectorError("google_workspace_connect_id_required", 400);
  for (const scope of await listConnectorScopePaths(env)) {
    const ledger = await readConnectLedger(scope);
    const request = ledger.requests.find((item) => clean(item.connectId) === id);
    if (request) return { scope, ledger, request };
  }
  throw connectorError("google_workspace_connect_link_not_found", 404);
}

function assertConnectRequestUsable(request = {}) {
  if (clean(request.consumedAt)) throw connectorError("google_workspace_connect_link_used", 410);
  if (parseTimeMs(request.expiresAt) && parseTimeMs(request.expiresAt) < nowMs()) {
    throw connectorError("google_workspace_connect_link_expired", 410);
  }
}

export function googleWorkspaceConnectCommand(text = "") {
  const value = clean(text).toLowerCase().replace(/\s+/g, " ");
  return value === "/connect google" || value === "connect google" || value === "/connect workspace";
}

export function googleWorkspaceCapabilitiesFromToken(token = {}, fallback = []) {
  const grantedScopes = Array.isArray(token.grantedScopes)
    ? token.grantedScopes.map(clean).filter(Boolean)
    : clean(token.scope).split(/[\s,]+/g).map(clean).filter(Boolean);
  if (grantedScopes.length) return googleWorkspaceCapabilitiesForScopes(grantedScopes, fallback);
  if (Array.isArray(token.capabilities) && token.capabilities.length) {
    return normalizeGoogleWorkspaceCapabilities(token.capabilities, []);
  }
  return googleWorkspaceCapabilitiesForScopes("", fallback);
}

export function publicGoogleWorkspaceTokenStatus(token = {}) {
  const capabilities = googleWorkspaceCapabilitiesFromToken(token, []);
  return {
    capabilities,
    capabilityLabels: googleWorkspaceCapabilityLabels(capabilities),
    grantedScopes: Array.isArray(token.grantedScopes)
      ? token.grantedScopes.map(clean).filter(Boolean)
      : clean(token.scope).split(/[\s,]+/g).map(clean).filter(Boolean),
  };
}

export async function createGoogleWorkspaceConnectLink({
  principal = {},
  thread = {},
  chatId = "",
  accountId = "",
  account = "",
  brokerInstanceId = "",
  brokerTenantVmId = "",
  brokerTenantUserId = "",
  brokerTenantThreadId = "",
  brokerTenantThreadName = "",
  brokerTenantChatId = "",
  brokerTenantAccountId = "",
  brokerServerRequest = false,
} = {}, env = process.env) {
  if (brokeredGoogleWorkspaceConnectEnabled(env)) {
    return createBrokeredGoogleWorkspaceConnectLink({ principal, thread, chatId, accountId, account }, env);
  }
  const brokerContextProvided = Boolean(clean(
    brokerInstanceId ||
      brokerTenantVmId ||
      brokerTenantUserId ||
      brokerTenantThreadId ||
      brokerTenantThreadName ||
      brokerTenantChatId ||
      brokerTenantAccountId,
  ));
  if (brokerContextProvided && brokerServerRequest !== true) {
    throw connectorError("broker_google_workspace_connect_requires_parent_broker", 409);
  }
  const scope = await connectorScopePaths(env, { principal });
  const connectId = randomUUID();
  const threadBinding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const request = {
    connectId,
    userId: scope.userId || "",
    threadId: clean(thread.id),
    threadName: clean(thread.name || thread.title || thread.displayName),
    chatId: clean(chatId || threadBinding.chatId),
    accountId: clean(accountId || threadBinding.responderAccountId || threadBinding.outboundAccountId),
    account: clean(account).toLowerCase(),
    source: "whatsapp",
    brokerInstanceId: clean(brokerInstanceId),
    brokerTenantVmId: clean(brokerTenantVmId),
    brokerTenantUserId: clean(brokerTenantUserId),
    brokerTenantThreadId: clean(brokerTenantThreadId),
    brokerTenantThreadName: clean(brokerTenantThreadName),
    brokerTenantChatId: clean(brokerTenantChatId),
    brokerTenantAccountId: clean(brokerTenantAccountId),
    createdAt: nowIso(),
    expiresAt: expiresAtIso(connectLinkTtlMs(env)),
  };
  const ledger = await readConnectLedger(scope);
  const cutoff = nowMs() - 24 * 60 * 60 * 1000;
  ledger.requests = [
    ...ledger.requests.filter((item) => parseTimeMs(item.createdAt) >= cutoff && !clean(item.consumedAt)),
    request,
  ];
  await writeConnectLedger(scope, ledger);
  const path = `/connect/google?connect=${encodeURIComponent(connectId)}`;
  const connectLink = publicConnectUrl(path, env, { brokered: Boolean(request.brokerInstanceId || request.brokerTenantVmId) });
  const connectorLink = googleWorkspaceBrokeredConnectorSetupHref(request, env, "gmail");
  const link = connectorLink || connectLink;
  return {
    ok: true,
    connectId,
    connectLink,
    connectorLink,
    link,
    expiresAt: request.expiresAt,
    capabilities: googleWorkspaceCapabilityDefinitions(),
    brokerInstanceId: request.brokerInstanceId,
    message: googleWorkspaceConnectMessage({
      link,
      expiresAt: connectorLink ? "" : request.expiresAt,
      connectorPage: Boolean(connectorLink),
    }),
  };
}

export function googleWorkspaceConnectMessage({ link = "", expiresAt = "", connectorPage = false } = {}) {
  return [
    "Google Workspace is optional. To start it from chat, send this exact command: /connect google",
    connectorPage
      ? "Then open this connector page to view Gmail status or start Google sign-in for this Orkestr instance:"
      : "Then open this one-time link to approve Google sign-in for this Orkestr instance:",
    clean(link),
    "",
    "Requested provider: google_workspace. Requested service: gmail.",
    clean(expiresAt) ? `This one-time link expires at ${clean(expiresAt)}.` : "",
  ].filter((line) => line !== "").join("\n");
}

export async function getGoogleWorkspaceConnectRequest(connectId = "", env = process.env) {
  const { request } = await findConnectRequest(connectId, env);
  if (parseTimeMs(request.expiresAt) && parseTimeMs(request.expiresAt) < nowMs()) {
    return { ok: false, state: "expired", request };
  }
  if (clean(request.consumedAt)) return { ok: false, state: "used", request };
  return { ok: true, state: "ready", request, capabilities: googleWorkspaceCapabilityDefinitions() };
}

export async function startGoogleWorkspaceOAuth(env = process.env, options = {}) {
  const connectId = clean(options.connectId || options.connect);
  const { scope, ledger, request } = await findConnectRequest(connectId, env);
  assertConnectRequestUsable(request);
  const capabilities = normalizeGoogleWorkspaceCapabilities(options.capabilities, ["gmail_read"]);
  const account = clean(options.account).toLowerCase();
  const started = await startGmailOAuth(env, {
    userId: scope.userId || "",
    account,
    threadId: request.threadId,
    chatId: request.chatId,
    accountId: request.accountId,
    provider: "google_workspace",
    connectId,
    capabilities,
    scopes: googleWorkspaceScopesForCapabilities(capabilities),
    ignoreConfiguredAccount: true,
    brokerInstanceId: request.brokerInstanceId,
    brokerTenantVmId: request.brokerTenantVmId,
    brokerTenantUserId: request.brokerTenantUserId,
    brokerTenantThreadId: request.brokerTenantThreadId,
    brokerTenantChatId: request.brokerTenantChatId,
    brokerTenantAccountId: request.brokerTenantAccountId,
  });
  request.consumedAt = nowIso();
  request.selectedCapabilities = capabilities;
  request.oauthState = started.state;
  await writeConnectLedger(scope, ledger);
  return {
    ...started,
    ok: true,
    provider: "google_workspace",
    connectId,
    capabilities,
    disclosure: googleWorkspaceCapabilityDisclosure(capabilities),
  };
}

async function assertGoogleWorkspaceCapability(capability, env = process.env, fetchImpl = fetch, options = {}) {
  const token = await readGmailToken(env, options);
  if (!clean(token.accessToken) && !clean(token.refreshToken)) {
    throw connectorError("google_workspace_not_connected", 403);
  }
  const capabilities = googleWorkspaceCapabilitiesFromToken(token, []);
  if (!capabilities.includes(capability)) {
    throw connectorError(`google_workspace_capability_not_granted:${capability}`, 403);
  }
  await getGmailAccessToken(env, fetchImpl, options);
  return { token, capabilities };
}

async function jsonApiRequest(url, { method = "GET", body = null, accessToken = "", fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw connectorError(payload.error?.message || payload.error || `google_workspace_http_${response.status}`, 502);
  }
  return payload;
}

async function accessTokenWithCapability(capability, env, fetchImpl, options) {
  await assertGoogleWorkspaceCapability(capability, env, fetchImpl, options);
  return getGmailAccessToken(env, fetchImpl, options);
}

function labelPatchForAction(args = {}) {
  const action = clean(args.action).toLowerCase();
  const add = Array.isArray(args.addLabelIds) ? args.addLabelIds.map(clean).filter(Boolean) : [];
  const remove = Array.isArray(args.removeLabelIds) ? args.removeLabelIds.map(clean).filter(Boolean) : [];
  if (action === "archive") remove.push("INBOX");
  if (action === "mark_read") remove.push("UNREAD");
  if (action === "mark_unread") add.push("UNREAD");
  if (action === "add_labels") add.push(...(Array.isArray(args.labelIds) ? args.labelIds.map(clean).filter(Boolean) : []));
  if (action === "remove_labels") remove.push(...(Array.isArray(args.labelIds) ? args.labelIds.map(clean).filter(Boolean) : []));
  return {
    addLabelIds: [...new Set(add)],
    removeLabelIds: [...new Set(remove)],
  };
}

export async function modifyGmailMessage(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const messageId = clean(args.messageId || args.id);
  if (!messageId) throw connectorError("gmail_message_id_required", 400);
  const patch = labelPatchForAction(args);
  if (!patch.addLabelIds.length && !patch.removeLabelIds.length) {
    throw connectorError("gmail_modify_labels_required", 400);
  }
  const accessToken = await accessTokenWithCapability("gmail_actions", env, fetchImpl, options);
  const url = `${gmailApiBase}/messages/${encodeURIComponent(messageId)}/modify`;
  const message = await jsonApiRequest(url, {
    method: "POST",
    body: patch,
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "gmail", messageId, patch, message };
}

function rfc822Headers(args = {}) {
  return [
    ["To", clean(args.to)],
    ["Cc", clean(args.cc)],
    ["Bcc", clean(args.bcc)],
    ["Subject", clean(args.subject)],
  ].filter(([, value]) => value);
}

function gmailRawMessage(args = {}) {
  const body = clean(args.body || args.text);
  const headers = rfc822Headers(args);
  if (!headers.some(([name]) => name === "To")) throw connectorError("gmail_to_required", 400);
  if (!body && !clean(args.subject)) throw connectorError("gmail_message_content_required", 400);
  const message = [
    ...headers.map(([name, value]) => `${name}: ${value.replace(/\r?\n/g, " ")}`),
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

export async function createGmailDraft(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const accessToken = await accessTokenWithCapability("gmail_send", env, fetchImpl, options);
  const draft = await jsonApiRequest(`${gmailApiBase}/drafts`, {
    method: "POST",
    body: { message: { raw: gmailRawMessage(args) } },
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "gmail", draft };
}

export async function sendGmailDraft(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const draftId = clean(args.draftId || args.id);
  if (!draftId) throw connectorError("gmail_draft_id_required", 400);
  const accessToken = await accessTokenWithCapability("gmail_send", env, fetchImpl, options);
  const sent = await jsonApiRequest(`${gmailApiBase}/drafts/send`, {
    method: "POST",
    body: { id: draftId },
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "gmail", draftId, message: sent };
}

export async function sendGmailMessage(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const accessToken = await accessTokenWithCapability("gmail_send", env, fetchImpl, options);
  const sent = await jsonApiRequest(`${gmailApiBase}/messages/send`, {
    method: "POST",
    body: { raw: gmailRawMessage(args) },
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "gmail", message: sent };
}

export async function listGoogleCalendarEvents(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const accessToken = await accessTokenWithCapability("calendar_read", env, fetchImpl, options);
  const calendarId = clean(args.calendarId) || "primary";
  const url = new URL(`${calendarApiBase}/calendars/${encodeURIComponent(calendarId)}/events`);
  for (const [key, value] of Object.entries({
    timeMin: clean(args.timeMin),
    timeMax: clean(args.timeMax),
    maxResults: Math.max(1, Math.min(50, Number(args.maxResults) || 10)),
    singleEvents: args.singleEvents === false ? "false" : "true",
    orderBy: args.orderBy || "startTime",
  })) {
    if (clean(value) !== "") url.searchParams.set(key, String(value));
  }
  const payload = await jsonApiRequest(url, { accessToken, fetchImpl });
  return {
    ok: true,
    provider: "google_calendar",
    calendarId,
    events: Array.isArray(payload.items) ? payload.items : [],
    nextPageToken: clean(payload.nextPageToken),
  };
}

function calendarTimeValue(args = {}, prefix = "start") {
  const objectValue = args[prefix];
  if (objectValue && typeof objectValue === "object" && !Array.isArray(objectValue)) {
    const dateTime = clean(objectValue.dateTime);
    const date = clean(objectValue.date);
    const timeZone = clean(objectValue.timeZone);
    if (dateTime) return { dateTime, ...(timeZone ? { timeZone } : {}) };
    if (date) return { date, ...(timeZone ? { timeZone } : {}) };
  }
  const dateTime = clean(args[`${prefix}DateTime`] || args[`${prefix}Time`]);
  const date = clean(args[`${prefix}Date`]);
  const timeZone = clean(args.timeZone);
  if (dateTime) return { dateTime, ...(timeZone ? { timeZone } : {}) };
  if (date) return { date, ...(timeZone ? { timeZone } : {}) };
  return null;
}

function calendarEventBody(args = {}, { requireTimes = false } = {}) {
  const body = {};
  for (const key of ["summary", "description", "location"]) {
    const value = clean(args[key]);
    if (value) body[key] = value;
  }
  const start = calendarTimeValue(args, "start");
  const end = calendarTimeValue(args, "end");
  if (start) body.start = start;
  if (end) body.end = end;
  if (requireTimes && (!start || !end)) throw connectorError("google_calendar_event_times_required", 400);
  if (!Object.keys(body).length) throw connectorError("google_calendar_event_body_required", 400);
  return body;
}

function calendarEventUrl(calendarId = "primary", eventId = "") {
  const base = `${calendarApiBase}/calendars/${encodeURIComponent(clean(calendarId) || "primary")}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

function appendSendUpdates(url, args = {}) {
  const value = clean(args.sendUpdates);
  if (!value) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("sendUpdates", value);
  return parsed;
}

export async function createGoogleCalendarEvent(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const accessToken = await accessTokenWithCapability("calendar_actions", env, fetchImpl, options);
  const calendarId = clean(args.calendarId) || "primary";
  const event = await jsonApiRequest(appendSendUpdates(calendarEventUrl(calendarId), args), {
    method: "POST",
    body: calendarEventBody(args, { requireTimes: true }),
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "google_calendar", action: "create", calendarId, event };
}

export async function updateGoogleCalendarEvent(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const eventId = clean(args.eventId || args.id);
  if (!eventId) throw connectorError("google_calendar_event_id_required", 400);
  const accessToken = await accessTokenWithCapability("calendar_actions", env, fetchImpl, options);
  const calendarId = clean(args.calendarId) || "primary";
  const event = await jsonApiRequest(appendSendUpdates(calendarEventUrl(calendarId, eventId), args), {
    method: "PATCH",
    body: calendarEventBody(args),
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "google_calendar", action: "update", calendarId, eventId, event };
}

export async function deleteGoogleCalendarEvent(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const eventId = clean(args.eventId || args.id);
  if (!eventId) throw connectorError("google_calendar_event_id_required", 400);
  const accessToken = await accessTokenWithCapability("calendar_actions", env, fetchImpl, options);
  const calendarId = clean(args.calendarId) || "primary";
  await jsonApiRequest(appendSendUpdates(calendarEventUrl(calendarId, eventId), args), {
    method: "DELETE",
    accessToken,
    fetchImpl,
  });
  return { ok: true, provider: "google_calendar", action: "delete", calendarId, eventId };
}

async function driveTextResponse(response) {
  if (typeof response.text === "function") return response.text();
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("utf8");
}

export async function getGoogleDriveFile(args = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const fileId = clean(args.fileId || args.id);
  if (!fileId) throw connectorError("google_drive_file_id_required", 400);
  const accessToken = await accessTokenWithCapability("drive_file", env, fetchImpl, options);
  const fields = clean(args.fields) || "id,name,mimeType,size,modifiedTime,webViewLink";
  const metadataUrl = new URL(`${driveApiBase}/files/${encodeURIComponent(fileId)}`);
  metadataUrl.searchParams.set("fields", fields);
  const metadata = await jsonApiRequest(metadataUrl, { accessToken, fetchImpl });
  if (!truthy(args.includeContent)) {
    return { ok: true, provider: "google_drive", file: metadata };
  }
  const isGoogleDoc = clean(metadata.mimeType).startsWith("application/vnd.google-apps.");
  const contentUrl = new URL(`${driveApiBase}/files/${encodeURIComponent(fileId)}${isGoogleDoc ? "/export" : ""}`);
  if (isGoogleDoc) contentUrl.searchParams.set("mimeType", clean(args.exportMimeType) || "text/plain");
  else contentUrl.searchParams.set("alt", "media");
  const response = await fetchImpl(contentUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: clean(args.exportMimeType) || "text/plain",
    },
  });
  if (!response.ok) throw connectorError(`google_drive_content_http_${response.status}`, 502);
  const content = (await driveTextResponse(response)).slice(0, Math.max(1000, Math.min(60_000, Number(args.maxChars) || 20_000)));
  return { ok: true, provider: "google_drive", file: metadata, content };
}
