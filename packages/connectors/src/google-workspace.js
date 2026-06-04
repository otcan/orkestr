import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../../storage/src/store.js";
import { connectorFile, connectorScopePaths, listConnectorScopePaths } from "./connector-storage.js";
import { getGmailAccessToken, readGmailToken, startGmailOAuth } from "./gmail.js";
import {
  googleWorkspaceCapabilityDefinitions,
  googleWorkspaceCapabilityDisclosure,
  googleWorkspaceCapabilityLabels,
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceScopesForCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "./google-workspace-scopes.js";

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

function publicAppBaseUrl(env = process.env) {
  return clean(
    env.ORKESTR_CONNECT_PUBLIC_URL ||
      env.ORKESTR_PUBLIC_HTTPS_URL ||
      env.ORKESTR_PUBLIC_URL ||
      env.ORKESTR_BASE_URL ||
      env.ORKESTR_APP_URL,
  ).replace(/\/+$/g, "");
}

function publicConnectUrl(pathname = "", env = process.env) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const base = publicAppBaseUrl(env);
  if (!base) return path;
  try {
    return new URL(path, `${base}/`).toString();
  } catch {
    return path;
  }
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
  if (Array.isArray(token.capabilities) && token.capabilities.length) {
    return normalizeGoogleWorkspaceCapabilities(token.capabilities, []);
  }
  return googleWorkspaceCapabilitiesForScopes(token.scope || token.grantedScopes || "", fallback);
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
} = {}, env = process.env) {
  const scope = await connectorScopePaths(env, { principal });
  const connectId = randomUUID();
  const threadBinding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const request = {
    connectId,
    userId: scope.userId || "",
    threadId: clean(thread.id),
    chatId: clean(chatId || threadBinding.chatId),
    accountId: clean(accountId || threadBinding.responderAccountId || threadBinding.outboundAccountId),
    account: clean(account).toLowerCase(),
    source: "whatsapp",
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
  const link = publicConnectUrl(path, env);
  return {
    ok: true,
    connectId,
    link,
    expiresAt: request.expiresAt,
    capabilities: googleWorkspaceCapabilityDefinitions(),
    message: googleWorkspaceConnectMessage({ link, expiresAt: request.expiresAt }),
  };
}

export function googleWorkspaceConnectMessage({ link = "", expiresAt = "" } = {}) {
  return [
    "Open this Google Workspace connection link and choose exactly what Orkestr may access:",
    clean(link),
    "",
    "Available capabilities: Gmail read, Gmail actions, Gmail send and drafts, Calendar read, Calendar actions, Drive selected files.",
    "Drive access uses drive.file only; Orkestr will not request broad Drive access.",
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
  const account = clean(options.account || request.account).toLowerCase();
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

export function googleWorkspaceConnectHtml({ connectId = "", request = {}, error = "" } = {}) {
  const capabilities = googleWorkspaceCapabilityDefinitions();
  const safeConnect = escapeHtml(connectId);
  const hidden = `<input type="hidden" name="connect" value="${safeConnect}">`;
  const rows = capabilities.map((capability, index) => {
    const checked = index === 0 ? " checked" : "";
    return `<label class="option"><input type="checkbox" name="capability" value="${escapeHtml(capability.id)}"${checked}> <strong>${escapeHtml(capability.label)}</strong><span>${escapeHtml(capability.summary)}</span></label>`;
  }).join("");
  const content = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : `<p>Choose the Google Workspace capabilities Orkestr may use for this chat before continuing to Google OAuth.</p>
      <form method="get" action="/connect/google/start">
        ${hidden}
        <div class="options">${rows}</div>
        <p class="notice">Orkestr requests only the scopes for the selected capabilities. Optional scopes that Google does not grant stay disabled. Drive uses selected-file access only.</p>
        <button type="submit">Continue to Google</button>
      </form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Google Workspace</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; color: #172026; background: #f7f8f8; }
    main { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; letter-spacing: 0; }
    p { line-height: 1.5; }
    .options { display: grid; gap: 10px; margin: 24px 0; }
    .option { display: grid; grid-template-columns: 24px 1fr; gap: 4px 10px; align-items: start; padding: 14px; border: 1px solid #d3d8dc; border-radius: 8px; background: white; }
    .option input { margin-top: 3px; }
    .option span { grid-column: 2; color: #52606d; }
    .notice { color: #3f4d59; background: #e8f1ee; border: 1px solid #c6ded3; border-radius: 8px; padding: 12px; }
    .error { color: #842029; background: #f8d7da; border: 1px solid #f1aeb5; border-radius: 8px; padding: 12px; }
    button { appearance: none; border: 0; border-radius: 6px; padding: 12px 16px; background: #14532d; color: white; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Google Workspace</h1>
    ${content}
  </main>
</body>
</html>`;
}

function escapeHtml(value = "") {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
