import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { getSetupStatus } from "../../../../../packages/core/src/setup.js";
import { readRuntimeSettings } from "../../../../../packages/core/src/runtime-settings.js";
import { runOverlayConnectorAction } from "../../../../../packages/connectors/src/connectors.js";
import { openUrlInVirtualBrowser } from "../../../../../packages/browsers/src/browsers.js";
import {
  finishGmailOAuth,
  getGmailMessage,
  listGmailMessages,
  startGmailOAuth as beginGmailOAuth,
} from "../../../../../packages/connectors/src/gmail.js";
import {
  getGoogleWorkspaceConnectRequest,
  googleWorkspaceBrokeredConnectorSetupHref,
  googleWorkspaceConnectHtml,
  startGoogleWorkspaceOAuth,
} from "../../../../../packages/connectors/src/google-workspace.js";
import {
  googleWorkspaceCapabilityLabels,
} from "../../../../../packages/connectors/src/google-workspace-scopes.js";
import { disconnectConnectorAuth } from "../../../../../packages/connectors/src/connector-auth.js";
import {
  pollOutlookDeviceOAuth,
  startOutlookDeviceOAuth,
} from "../../../../../packages/connectors/src/outlook.js";
import {
  clearWhatsAppDeliveryIdleCache,
  deliverWhatsAppReplies,
  getWhatsAppChatMessages,
  getWhatsAppChatParticipants,
  getWhatsAppStatus,
  routeWhatsAppInbound,
  sendWhatsAppText,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { createAndBindWhatsAppThreadGroup } from "../../../../../packages/connectors/src/whatsapp-thread-groups.js";
import { assertWhatsAppBridgeBindingAcl } from "../../../../../packages/connectors/src/whatsapp-account-bindings.js";
import { assertWhatsAppBridgeTokenContext } from "../../../../../packages/connectors/src/whatsapp-binding-acl.js";
import { loginCodexWithApiKey, startCodexDeviceAuth } from "../../../../../packages/connectors/src/codex.js";
import { requestThreadInputDelivery } from "../../../../../packages/core/src/runtime-leases.js";
import { appendThreadMessage, getThread, getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../../../../../packages/core/src/tenant-api-agent.js";
import { getTenantVm } from "../../../../../packages/core/src/tenant-vm-registry.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { createPairingChallenge, securityStatus } from "../../../../../packages/core/src/security.js";
import { resolveBrokerConnectInstance } from "../../../../../packages/core/src/broker-instance-registry.js";
import { normalizeUserId } from "../../../../../packages/core/src/users.js";
import { publicRoutingFailurePayload } from "../../../../../packages/core/src/routing-failures.js";
import {
  addLocalWhatsAppGroupParticipants,
  createLocalWhatsAppChat,
  demoteLocalWhatsAppGroupParticipants,
  generateLocalWhatsAppChatPicture,
  getLocalWhatsAppBridgeStatus,
  getLocalWhatsAppQrSvg,
  handleInboundMessage,
  listLocalWhatsAppChats,
  logoutLocalWhatsAppAccount,
  promoteLocalWhatsAppGroupParticipants,
  recoverLocalWhatsAppChatMessages,
  sendLocalWhatsAppRepairQrEmail,
  startLocalWhatsAppAccount,
  stopLocalWhatsAppTyping,
} from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { routedWhatsAppTypingTarget, runWithRoutedWhatsAppTyping } from "../../../../../packages/connectors/src/whatsapp-router-typing.js";
import { startWhatsAppTyping, stopWhatsAppTyping } from "../../../../../packages/connectors/src/whatsapp-typing.js";
import { findWhatsAppAccountByAnyId } from "../../../../../packages/connectors/src/whatsapp-account-identity.js";
import { whatsappWorkerConversation } from "../../../../../packages/connectors/src/whatsapp-worker-client.js";
import { writeConnectorConfig } from "../../../../../packages/storage/src/config.js";
import { dataPaths } from "../../../../../packages/storage/src/paths.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";
import { reportServerError } from "../../watcher-reporting.js";
import { whatsappRepairPageHtml } from "./whatsapp-repair-page.js";

function bodyStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/g);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const text = String(item || "").trim();
    const comparable = text.toLowerCase();
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(text);
  }
  return result;
}

function requestPathWithQuery(request: any, fallback = "/connect/google"): string {
  const raw = String(request?.originalUrl || request?.url || fallback).trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function googleWorkspacePairingRedirect(challengeId: string, returnPath: string): string {
  const target = new URL("/setup/pairing", "http://localhost");
  if (challengeId) target.searchParams.set("challengeId", challengeId);
  target.searchParams.set("return", returnPath);
  return `${target.pathname}${target.search}`;
}

function googleWorkspaceConnectRequestExists(payload: any): boolean {
  return Boolean(payload?.request && Object.keys(payload.request).length);
}

function googleWorkspaceBrokerInstanceId(connectRequest: any): string {
  return String(connectRequest?.brokerInstanceId || connectRequest?.brokerTenantVmId || "").trim();
}

function googleWorkspaceBrokeredConnectRequest(connectRequest: any): boolean {
  return Boolean(googleWorkspaceBrokerInstanceId(connectRequest));
}

async function googleWorkspaceBrokerInstanceReachable(connectRequest: any): Promise<boolean> {
  const instanceId = googleWorkspaceBrokerInstanceId(connectRequest);
  if (!instanceId) return false;
  return Boolean(await resolveBrokerConnectInstance(instanceId, process.env).catch(() => null));
}

function googleWorkspaceAuthIntentAction(connectRequest: any): string {
  const connectId = String(connectRequest?.connectId || "").trim();
  return connectId ? `orkestr_auth.google.connect:${connectId}` : "orkestr_auth.google.connect";
}

function googleWorkspaceAuthIntent(connectRequest: any): Record<string, string> {
  const instanceId = googleWorkspaceBrokerInstanceId(connectRequest);
  const userId = normalizeUserId(connectRequest?.userId || "");
  const tenantVmId = String(connectRequest?.tenantVmId || connectRequest?.brokerTenantVmId || "").trim();
  const account = String(connectRequest?.account || "").trim().toLowerCase();
  const thread = String(
    connectRequest?.threadName ||
      connectRequest?.threadTitle ||
      connectRequest?.brokerTenantThreadName ||
      connectRequest?.threadId ||
      connectRequest?.brokerTenantThreadId ||
      "",
  ).trim();
  return {
    mcp: "tools/call",
    tool: "orkestr_auth",
    service: "gmail",
    provider: "google_workspace",
    action: "connect",
    actionLabel: "Connect Gmail",
    title: "Approve Gmail connection",
    description: instanceId
      ? `Approve Google Workspace access for instance ${instanceId}.`
      : "Approve Google Workspace access for this Orkestr user.",
    connectId: String(connectRequest?.connectId || "").trim(),
    instanceId,
    tenantVmId,
    userId,
    thread,
    threadId: String(connectRequest?.threadId || connectRequest?.brokerTenantThreadId || "").trim(),
    chatId: String(connectRequest?.chatId || connectRequest?.brokerTenantChatId || "").trim(),
    accountId: String(connectRequest?.accountId || connectRequest?.brokerTenantAccountId || "").trim(),
    account,
    restartCommand: "/connect google",
    restartSurface: "whatsapp",
    source: String(connectRequest?.source || "connect_link").trim(),
  };
}

function maskEmail(value: unknown): string {
  const text = String(value || "").trim();
  const [local, domain] = text.split("@");
  if (!local || !domain) return "";
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}${local.length > 2 ? "***" : "*"}@${domain}`;
}

function googleWorkspaceAuthSessionHasAction(session: any, connectRequest: any): boolean {
  const allowed = Array.isArray(session?.allowedActions) ? session.allowedActions : [];
  return allowed.includes(googleWorkspaceAuthIntentAction(connectRequest));
}

function googleWorkspaceSessionUserMatches(session: any, ownerUserId: string): boolean {
  if (!ownerUserId) return true;
  return normalizeUserId(session?.userId || "") === ownerUserId;
}

function googleWorkspaceSessionInstanceMatches(session: any, connectRequest: any): boolean {
  const instanceId = googleWorkspaceBrokerInstanceId(connectRequest);
  if (!instanceId) return true;
  return String(session?.instanceId || "").trim() === instanceId;
}

function googleWorkspacePairingError(response: any, connectRequest: any, error: string): void {
  response
    .status(403)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(googleWorkspaceConnectHtml({
      connectId: String(connectRequest.connectId || ""),
      request: connectRequest,
      error,
    }));
}

function requestHeader(request: any, name: string): string {
  const headers = request?.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function googleWorkspaceLinkPreviewRequest(request: any): boolean {
  const method = String(request?.method || "GET").toUpperCase();
  if (method === "HEAD") return true;
  const purpose = `${requestHeader(request, "purpose")} ${requestHeader(request, "sec-purpose")} ${requestHeader(request, "x-purpose")}`.toLowerCase();
  if (/\b(prefetch|preview|prerender)\b/.test(purpose)) return true;
  const userAgent = requestHeader(request, "user-agent").toLowerCase();
  return /facebookexternalhit|facebot|slackbot|twitterbot|telegrambot|discordbot|linkedinbot|skypeuripreview|teamsbot|google-read-aloud|bingpreview/.test(userAgent);
}

function googleWorkspacePreviewResponse(response: any, connectRequest: any): void {
  response
    .status(200)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(googleWorkspaceConnectHtml({
      connectId: String(connectRequest.connectId || ""),
      request: connectRequest,
      previewOnly: true,
    } as any));
}

async function googleWorkspaceConnectAccess(request: any, payload: any, response: any): Promise<boolean> {
  const connectRequest = payload?.request || {};
  const ownerUserId = normalizeUserId(connectRequest.userId || "");
  const status = await securityStatus();
  const currentPath = requestPathWithQuery(request);
  const session = request?.orkestrSecuritySession || null;
  if (status.authEnabled) {
    if (session && googleWorkspaceAuthSessionHasAction(session, connectRequest)) {
      if (!googleWorkspaceSessionInstanceMatches(session, connectRequest)) {
        googleWorkspacePairingError(response, connectRequest, "google_workspace_connect_pairing_instance_mismatch");
        return false;
      }
      if (!googleWorkspaceSessionUserMatches(session, ownerUserId)) {
        googleWorkspacePairingError(response, connectRequest, "google_workspace_connect_pairing_user_mismatch");
        return false;
      }
      return true;
    }
    if (googleWorkspaceLinkPreviewRequest(request)) {
      googleWorkspacePreviewResponse(response, connectRequest);
      return false;
    }
    const challenge = await createPairingChallenge({
      request,
      instanceId: googleWorkspaceBrokerInstanceId(connectRequest),
      userId: ownerUserId,
      role: ownerUserId ? "user" : "admin",
      requestedPath: currentPath,
      allowedActions: [googleWorkspaceAuthIntentAction(connectRequest)],
      authIntent: googleWorkspaceAuthIntent(connectRequest),
    } as any);
    response
      .status(302)
      .header("location", googleWorkspacePairingRedirect(String(challenge.challengeId || ""), currentPath))
      .type("text/plain; charset=utf-8")
      .send("Redirecting to Orkestr pairing.");
    return false;
  }
  const trustedContext = !status.authEnabled || Boolean(session || request?.orkestrMachineAuth);
  if (!trustedContext) {
    const challenge = await createPairingChallenge({
      request,
      userId: ownerUserId,
      role: ownerUserId ? "user" : "admin",
      requestedPath: currentPath,
    } as any);
    response
      .status(302)
      .header("location", googleWorkspacePairingRedirect(String(challenge.challengeId || ""), currentPath))
      .type("text/plain; charset=utf-8")
      .send("Redirecting to Orkestr pairing.");
    return false;
  }
  if (googleWorkspaceBrokeredConnectRequest(connectRequest)) {
    if (!googleWorkspaceSessionInstanceMatches(session, connectRequest)) {
      googleWorkspacePairingError(response, connectRequest, "google_workspace_connect_pairing_instance_mismatch");
      return false;
    }
    if (!googleWorkspaceSessionUserMatches(session, ownerUserId)) {
      googleWorkspacePairingError(response, connectRequest, "google_workspace_connect_pairing_user_mismatch");
      return false;
    }
    return true;
  }
  const principal = requestPrincipal(request);
  const principalUserId = normalizeUserId(principal?.userId || "");
  if (ownerUserId && !isAdminPrincipal(principal) && principalUserId !== ownerUserId) {
    googleWorkspacePairingError(response, connectRequest, "google_workspace_connect_pairing_user_mismatch");
    return false;
  }
  return true;
}

function safeInboundUploadName(name: unknown): string {
  const base = path.basename(String(name || "attachment.bin")).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return base || "attachment.bin";
}

function parseInboundUploadMetadata(body: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  const value = body.metadata || body.attachments || body.filesMetadata;
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
  } catch {
    return [];
  }
}

function envStringArray(...keys: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    const values = String(process.env[key] || "").split(/[\s,]+/g);
    for (const item of values) {
      const text = String(item || "").trim();
      const comparable = text.toLowerCase();
      if (!text || seen.has(comparable)) continue;
      seen.add(comparable);
      result.push(text);
    }
  }
  return result;
}

function optionalBodyBoolean(body: Record<string, unknown>, key: string, fallback = false): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return fallback;
  const value = body[key];
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return value === true;
}

function errorStatusCode(error: any, fallback = 500): number {
  const status = Number(error?.statusCode || error?.status || (typeof error?.getStatus === "function" ? error.getStatus() : 0));
  return Number.isFinite(status) && status > 0 ? status : fallback;
}

function errorSafeCode(error: any, fallback = "request_failed"): string {
  const response = typeof error?.getResponse === "function" ? error.getResponse() : null;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const value = String((response as Record<string, unknown>).error || (response as Record<string, unknown>).message || "").trim();
    if (value) return value;
  }
  return String(error?.message || fallback).trim() || fallback;
}

function bridgeInlineAttachmentMaxBytes(): number {
  const value = Number(
    process.env.ORKESTR_WHATSAPP_BRIDGE_INLINE_ATTACHMENT_MAX_BYTES ||
      process.env.ORKESTR_WHATSAPP_INLINE_ATTACHMENT_MAX_BYTES ||
      process.env.ORKESTR_REMOTE_ARTIFACT_MAX_BYTES ||
      25 * 1024 * 1024,
  );
  return Number.isFinite(value) && value > 0 ? value : 25 * 1024 * 1024;
}

function safeBridgeInlineFilename(value: unknown, fallback = "attachment"): string {
  return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 240) || fallback;
}

async function materializeBridgeInlineAttachments(body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const source = Array.isArray(body.attachments) ? body.attachments : [];
  if (!source.length) return [];
  const maxBytes = bridgeInlineAttachmentMaxBytes();
  const paths = dataPaths(process.env);
  const dir = path.join(paths.home, "whatsapp-bridge", "outbound-media", "bridge-inline", new Date().toISOString().slice(0, 10));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const materialized: Array<Record<string, unknown>> = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const attachment = item as Record<string, unknown>;
    const encoding = String(attachment.encoding || "base64").trim().toLowerCase();
    const data = String(attachment.data || attachment.base64 || attachment.dataBase64 || "").trim();
    if (!data) continue;
    if (encoding !== "base64") throw httpError("attachment_encoding_not_supported", 400);
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length) throw httpError("attachment_empty", 400);
    if (buffer.length > maxBytes) throw httpError("attachment_too_large", 413);
    const declaredSize = Number(attachment.size || 0) || 0;
    if (declaredSize > 0 && declaredSize !== buffer.length) throw httpError("attachment_size_mismatch", 400);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const declaredSha256 = String(attachment.sha256 || "").trim().toLowerCase();
    if (declaredSha256 && declaredSha256 !== sha256) throw httpError("attachment_checksum_mismatch", 400);
    const filename = safeBridgeInlineFilename(attachment.filename || attachment.name, "attachment");
    const filePath = path.join(dir, `${sha256.slice(0, 16)}-${filename}`);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    materialized.push({
      path: filePath,
      filename,
      name: String(attachment.name || filename).trim() || filename,
      mimetype: String(attachment.mimetype || attachment.type || "application/octet-stream").trim() || "application/octet-stream",
      kind: String(attachment.kind || "file").trim() || "file",
      size: buffer.length,
      sha256,
      source: "bridge_inline_attachment",
    });
  }
  return materialized;
}

function scopedBridgeAccounts(accounts: any[] = [], context: any = null): any[] {
  if (!context || Object.keys(context).length === 0 || context.legacy === true) return accounts;
  const accountId = String(context.accountId || "").trim();
  if (accountId) return accounts.filter((account) => String(account?.accountId || account?.id || "").trim() === accountId);
  if (String(context.chatId || context.bindingId || "").trim()) return [];
  return accounts;
}

function assertBridgeAccountScope(action: string, selector: Record<string, unknown>, context: any = null) {
  assertWhatsAppBridgeTokenContext(action, selector, context, null, { requireScopedSelector: true });
}

async function resolveLocalWhatsAppRuntimeAccountId(accountId = ""): Promise<string> {
  const requested = String(accountId || "").trim();
  if (!requested) return "";
  const status = await getWhatsAppStatus().catch(() => null);
  const accounts = [
    ...(Array.isArray(status?.accounts) ? status.accounts : []),
    ...(Array.isArray(status?.health?.accounts) ? status.health.accounts : []),
  ];
  const account = findWhatsAppAccountByAnyId(accounts, requested, process.env);
  return String(account?.runtimeAccountId || requested).trim();
}

@Controller("api/connectors")
export class ConnectorsController {
  @Post("codex/device-auth")
  @HttpCode(200)
  async codexDeviceAuth() {
    try {
      return await startCodexDeviceAuth();
    } catch (error) {
      const statusCode = Number((error as any)?.statusCode || 400) || 400;
      throw httpError(String((error as Error)?.message || "codex_device_auth_failed"), statusCode);
    }
  }

  @Post("codex/api-key")
  @HttpCode(200)
  async codexApiKey(@Body() body: Record<string, unknown> = {}) {
    const apiKey = String(body.apiKey || body.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw httpError("openai_api_key_required", 400);
    try {
      return await loginCodexWithApiKey(apiKey);
    } catch (error) {
      const statusCode = Number((error as any)?.statusCode || 400) || 400;
      throw httpError(String((error as Error)?.message || "codex_api_key_login_failed"), statusCode);
    }
  }

  @Get("gmail/oauth/start")
  async startGmailOAuth(@Req() request: any, @Query("account") account = "") {
    return beginGmailOAuth(process.env, { account, principal: requestPrincipal(request) });
  }

  @Delete("gmail/auth")
  @HttpCode(200)
  async disconnectGmailAuth(@Req() request: any) {
    return disconnectConnectorAuth({ provider: "gmail" }, requestPrincipal(request), process.env);
  }

  @Get("gmail/messages")
  async gmailMessages(@Req() request: any, @Query("maxResults") maxResults = "10", @Query("q") query = "") {
    return listGmailMessages({ maxResults: Number(maxResults || 10), query }, process.env, fetch, {
      principal: requestPrincipal(request),
    });
  }

  @Get("gmail/messages/:id")
  async gmailMessage(@Req() request: any, @Param("id") id: string) {
    return { message: await getGmailMessage(id, process.env, fetch, { principal: requestPrincipal(request) }) };
  }

  @Post("outlook/oauth/start")
  @HttpCode(200)
  async startOutlookOAuth(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return startOutlookDeviceOAuth(process.env, {
      account: String(body.account || ""),
      principal: requestPrincipal(request),
    });
  }

  @Post("outlook/oauth/poll")
  @HttpCode(200)
  async pollOutlookOAuth(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return pollOutlookDeviceOAuth(String(body.pendingId || ""), process.env, fetch, {
      principal: requestPrincipal(request),
    });
  }

  @Get("whatsapp/status")
  async whatsappStatus() {
    return getWhatsAppStatus();
  }

  @Get("whatsapp/bridge/health")
  async whatsappBridgeHealth() {
    return getLocalWhatsAppBridgeStatus();
  }

  @Get("whatsapp/bridge/accounts")
  async whatsappBridgeAccounts(@Req() request: any) {
    const status = await getLocalWhatsAppBridgeStatus();
    return { accounts: scopedBridgeAccounts(status.accounts, request.orkestrMachineAuthContext), state: status.state };
  }

  @Post("whatsapp/bridge/accounts/:accountId/start")
  @HttpCode(202)
  async whatsappBridgeAccountStart(@Req() request: any, @Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    assertBridgeAccountScope("manage", { accountId }, request.orkestrMachineAuthContext);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    return {
      account: await startLocalWhatsAppAccount(runtimeAccountId, process.env, {
        phoneNumber: String(body.phoneNumber || body.phone || ""),
        resetRuntime: body.reset === true || body.resetRuntime === true || body.force === true,
        showNotification: body.showNotification !== false,
        intervalMs: Number(body.intervalMs || 0) || undefined,
        authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
      }),
    };
  }

  @Post("whatsapp/bridge/accounts/:accountId/start-phone")
  @HttpCode(202)
  async whatsappBridgeAccountStartPhone(@Req() request: any, @Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    assertBridgeAccountScope("manage", { accountId }, request.orkestrMachineAuthContext);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    return {
      account: await startLocalWhatsAppAccount(runtimeAccountId, process.env, {
        phoneNumber: String(body.phoneNumber || body.phone || ""),
        showNotification: body.showNotification !== false,
        intervalMs: Number(body.intervalMs || 0) || undefined,
        authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
      }),
    };
  }

  @Post("whatsapp/bridge/accounts/:accountId/logout")
  @HttpCode(200)
  async whatsappBridgeAccountLogout(@Req() request: any, @Param("accountId") accountId: string) {
    assertBridgeAccountScope("manage", { accountId }, request.orkestrMachineAuthContext);
    return { account: await logoutLocalWhatsAppAccount(await resolveLocalWhatsAppRuntimeAccountId(accountId)) };
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats")
  async whatsappBridgeAccountChats(@Req() request: any, @Param("accountId") accountId: string) {
    assertBridgeAccountScope("read", { accountId }, request.orkestrMachineAuthContext);
    return listLocalWhatsAppChats(await resolveLocalWhatsAppRuntimeAccountId(accountId));
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats/:chatId/history")
  async whatsappBridgeChatHistory(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Query("limit") limit = "30") {
    await assertWhatsAppBridgeBindingAcl("read", { accountId, chatId }, request.orkestrMachineAuthContext);
    return getWhatsAppChatMessages({ accountId, chatId, limit: Number(limit || 30) || 30 });
  }

  @Post("whatsapp/bridge/chats")
  @HttpCode(200)
  async whatsappBridgeCreateChat(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const receivingAccountId = String(body.receivingAccountId || body.inboundAccountId || body.senderAccountId || "").trim();
    const replyAccountId = String(body.replyAccountId || body.bridgeAccountId || body.responderAccountId || body.outboundAccountId || "").trim();
    assertBridgeAccountScope("manage", {
      accountId: replyAccountId || receivingAccountId,
    }, request.orkestrMachineAuthContext);
    const requestedParticipants = bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants"));
    const participantIds = requestedParticipants.length
      ? requestedParticipants
      : envStringArray(
        "ORKESTR_WHATSAPP_DEFAULT_GROUP_PARTICIPANTS",
        "ORKESTR_WHATSAPP_DEFAULT_PARTICIPANT_IDS",
        "ORKESTR_WHATSAPP_OWNER_CONTACT_IDS",
      );
    const promoteParticipantsAsAdmins = optionalBodyBoolean(body, "promoteParticipantsAsAdmins", participantIds.length > 0);
    const runtimeReceivingAccountId = await resolveLocalWhatsAppRuntimeAccountId(receivingAccountId);
    const runtimeReplyAccountId = await resolveLocalWhatsAppRuntimeAccountId(replyAccountId);
    const result = await createLocalWhatsAppChat({
      name: String(body.name || body.displayName || ""),
      senderAccountId: runtimeReceivingAccountId,
      responderAccountId: runtimeReplyAccountId,
      participantIds,
      adminParticipantIds: bodyStringArray(body, "adminParticipantIds"),
      promoteParticipantsAsAdmins,
      generatePicture: optionalBodyBoolean(body, "generatePicture", true),
    }) as Record<string, any>;
    return {
      ...result,
      senderAccountId: receivingAccountId || result.senderAccountId,
      responderAccountId: replyAccountId || result.responderAccountId,
      replyAccountId: replyAccountId || result.responderAccountId,
      bridgeAccountId: replyAccountId || result.responderAccountId,
      receivingAccountId: receivingAccountId || result.senderAccountId,
    };
  }

  @Post("whatsapp/thread-groups")
  @HttpCode(200)
  async whatsappThreadGroup(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const threadId = String(body.threadId || body.thread || body.target || "").trim();
    if (!threadId) throw httpError("thread_id_required", 400);
    const thread = await getThreadForPrincipal(threadId, requestPrincipal(request));
    if (!thread) throw httpError("thread_not_found", 404);
    const requestedParticipants = bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants"));
    const participantIds = requestedParticipants.length
      ? requestedParticipants
      : envStringArray(
        "ORKESTR_WHATSAPP_DEFAULT_GROUP_PARTICIPANTS",
        "ORKESTR_WHATSAPP_DEFAULT_PARTICIPANT_IDS",
        "ORKESTR_WHATSAPP_OWNER_CONTACT_IDS",
      );
    const receivingAccountId = String(body.receivingAccountId || body.inboundAccountId || body.senderAccountId || "").trim();
    const replyAccountId = String(body.replyAccountId || body.bridgeAccountId || body.responderAccountId || body.outboundAccountId || "").trim();
    const options = {
      name: String(body.name || body.displayName || ""),
      senderAccountId: receivingAccountId,
      responderAccountId: replyAccountId,
      outboundAccountId: replyAccountId,
      participantIds,
      adminParticipantIds: bodyStringArray(body, "adminParticipantIds"),
      promoteParticipantsAsAdmins: optionalBodyBoolean(body, "promoteParticipantsAsAdmins", participantIds.length > 0),
      generatePicture: optionalBodyBoolean(body, "generatePicture", true),
      mirrorToWhatsApp: optionalBodyBoolean(body, "mirrorToWhatsApp", true),
      replyPrefix: String(body.replyPrefix || ""),
      forceNew: optionalBodyBoolean(body, "forceNew", false),
    };
    const status = await getWhatsAppStatus();
    const dependencies = String(status.mode || "").trim() === "local"
      ? {
          createChat: async (input: Record<string, unknown> = {}) => {
            const runtimeReceivingAccountId = await resolveLocalWhatsAppRuntimeAccountId(String(input.senderAccountId || ""));
            const runtimeReplyAccountId = await resolveLocalWhatsAppRuntimeAccountId(String(input.responderAccountId || input.outboundAccountId || ""));
            return createLocalWhatsAppChat({
              ...input,
              senderAccountId: runtimeReceivingAccountId,
              responderAccountId: runtimeReplyAccountId,
            });
          },
        }
      : {};
    return createAndBindWhatsAppThreadGroup(thread, options, process.env, dependencies);
  }

  @Post("whatsapp/bridge/chats/:chatId/picture")
  @HttpCode(200)
  async whatsappBridgeGenerateChatPicture(@Req() request: any, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    const accountId = String(body.accountId || body.replyAccountId || body.bridgeAccountId || body.responderAccountId || body.outboundAccountId || "").trim();
    await assertWhatsAppBridgeBindingAcl("manage", {
      accountId,
      chatId,
    }, request.orkestrMachineAuthContext);
    return generateLocalWhatsAppChatPicture({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(accountId),
      chatId,
      title: String(body.title || body.name || ""),
    });
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats/:chatId/participants")
  async whatsappBridgeChatParticipants(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string) {
    await assertWhatsAppBridgeBindingAcl("read", { accountId, chatId }, request.orkestrMachineAuthContext);
    return getWhatsAppChatParticipants({ accountId, chatId });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/participants")
  @HttpCode(200)
  async whatsappBridgeAddGroupParticipants(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    return addLocalWhatsAppGroupParticipants({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(accountId),
      chatId,
      participantIds: bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants")),
      autoSendInviteV4: optionalBodyBoolean(body, "autoSendInviteV4", true),
      comment: String(body.comment || ""),
    });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/recover")
  @HttpCode(200)
  async whatsappBridgeRecoverChat(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    const options = {
      limit: Number(body.limit || 20) || 20,
      unreadOnly: body.unreadOnly !== false,
      markSeen: body.markSeen !== false,
    };
    try {
      return await whatsappWorkerConversation(runtimeAccountId, chatId, "recover", options, process.env);
    } catch (error: any) {
      if (!["whatsapp_worker_unavailable", "whatsapp_worker_unconfigured"].includes(String(error?.message || ""))) throw error;
      return recoverLocalWhatsAppChatMessages({ accountId: runtimeAccountId, chatId, ...options });
    }
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/admins")
  @HttpCode(200)
  async whatsappBridgePromoteGroupAdmins(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    const participantIds = bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants"));
    try {
      return await whatsappWorkerConversation(runtimeAccountId, chatId, "promote-admins", { participantIds }, process.env);
    } catch (error: any) {
      if (!["whatsapp_worker_unavailable", "whatsapp_worker_unconfigured"].includes(String(error?.message || ""))) throw error;
    }
    return promoteLocalWhatsAppGroupParticipants({
      accountId: runtimeAccountId,
      chatId,
      participantIds,
    });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/admins/demote")
  @HttpCode(200)
  async whatsappBridgeDemoteGroupAdmins(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    const participantIds = bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants"));
    try {
      return await whatsappWorkerConversation(runtimeAccountId, chatId, "demote-admins", { participantIds }, process.env);
    } catch (error: any) {
      if (!["whatsapp_worker_unavailable", "whatsapp_worker_unconfigured"].includes(String(error?.message || ""))) throw error;
    }
    return demoteLocalWhatsAppGroupParticipants({
      accountId: runtimeAccountId,
      chatId,
      participantIds,
    });
  }

  @Post("whatsapp/bridge/typing/clear")
  @HttpCode(200)
  async whatsappBridgeClearTyping(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    assertBridgeAccountScope("send", {
      accountId: String(body.accountId || ""),
      chatId: String(body.chatId || body.to || ""),
    }, request.orkestrMachineAuthContext);
    await assertWhatsAppBridgeBindingAcl("send", {
      accountId: String(body.accountId || ""),
      chatId: String(body.chatId || body.to || ""),
    }, request.orkestrMachineAuthContext);
    return stopLocalWhatsAppTyping({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(String(body.accountId || "")),
      chatId: String(body.chatId || body.to || ""),
    });
  }

  @Get("whatsapp/bridge/repair")
  async whatsappBridgeRepairPage(@Query("accountId") accountId = "", @Res() response: any) {
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(whatsappRepairPageHtml(accountId));
  }

  @Post("whatsapp/bridge/repair/send-email")
  @HttpCode(200)
  async whatsappBridgeRepairSendEmail(@Body() body: Record<string, unknown> = {}) {
    const result = await sendLocalWhatsAppRepairQrEmail({
      accountId: String(body.accountId || ""),
      reason: "manual_repair_page",
      force: body.force !== false,
    }, process.env);
    if (!result.ok && !result.skipped) {
      throw httpError(String(result.error || result.skippedReason || "whatsapp_qr_email_failed"), Number(result.statusCode || 500) || 500);
    }
    return {
      ok: result.ok,
      skipped: Boolean(result.skipped),
      skippedReason: result.skippedReason || "",
      accountId: result.accountId || String(body.accountId || ""),
      recipients: Array.isArray(result.recipients) ? result.recipients.map(maskEmail).filter(Boolean) : [],
    };
  }

  @Get("whatsapp/bridge/qr.svg")
  async whatsappBridgeQr(@Req() request: any, @Query("accountId") accountId = "", @Res() response: any) {
    assertBridgeAccountScope("read", { accountId }, request.orkestrMachineAuthContext);
    const svg = await getLocalWhatsAppQrSvg(await resolveLocalWhatsAppRuntimeAccountId(accountId));
    if (!svg) {
      return response
        .status(404)
        .header("cache-control", "no-store")
        .type("application/json; charset=utf-8")
        .send({ error: "whatsapp_qr_not_available" });
    }
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("image/svg+xml; charset=utf-8")
      .send(svg);
  }

  @Post("whatsapp/bridge/send-text")
  @HttpCode(200)
  async whatsappBridgeSendText(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("send", {
      chatId: String(body.to || body.chatId || ""),
      accountId: String(body.accountId || ""),
    }, request.orkestrMachineAuthContext);
    return sendWhatsAppText({
      chatId: String(body.to || body.chatId || ""),
      text: String(body.text || ""),
      accountId: String(body.accountId || ""),
      crossAccountEchoSuppression: body.crossAccountEchoSuppression !== false,
      routeSentMessage: body.routeSentMessage === true,
    });
  }

  @Post("whatsapp/bridge/send-media")
  @HttpCode(200)
  async whatsappBridgeSendMedia(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("send", {
      chatId: String(body.to || body.chatId || ""),
      accountId: String(body.accountId || ""),
    }, request.orkestrMachineAuthContext);
    const paths = Array.isArray(body.paths)
      ? body.paths.map((value) => String(value || "").trim()).filter(Boolean)
      : [String(body.path || "").trim()].filter(Boolean);
    const inlineAttachments = await materializeBridgeInlineAttachments(body);
    return sendWhatsAppText({
      chatId: String(body.to || body.chatId || ""),
      text: String(body.text || ""),
      accountId: String(body.accountId || ""),
      attachments: [
        ...paths.map((filePath) => ({ path: filePath })),
        ...inlineAttachments,
      ],
      crossAccountEchoSuppression: body.crossAccountEchoSuppression !== false,
      routeSentMessage: body.routeSentMessage === true,
    });
  }

  @Post("whatsapp/bridge/inject-message")
  @HttpCode(202)
  async whatsappBridgeInjectMessage(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const accountId = String(body.accountId || "").trim();
    const chatId = String(body.chatId || body.to || body.fromChatId || "").trim();
    const text = String(body.text || body.body || "").trim();
    const fromMe = optionalBodyBoolean(body, "fromMe", false);
    const from = String(body.from || body.author || "").trim();
    const eventId = String(body.eventId || body.id || `inject_${Date.now()}`).trim();
    const routeAccountId = String(body.routeAccountId || body.senderAccountId || body.inboundAccountId || "").trim();
    if (!accountId) throw httpError("whatsapp_account_id_required", 400);
    if (!chatId) throw httpError("whatsapp_chat_id_required", 400);
    if (!text) throw httpError("whatsapp_text_required", 400);
    await assertWhatsAppBridgeBindingAcl("receive", { chatId, accountId }, request.orkestrMachineAuthContext);
    const timestamp = Number(body.timestamp || 0) || Math.floor(Date.now() / 1000);
    const runtimeAccountId = await resolveLocalWhatsAppRuntimeAccountId(accountId);
    return handleInboundMessage(runtimeAccountId, {
      id: { _serialized: eventId, remote: chatId },
      from: fromMe ? (from || String(body.from || runtimeAccountId).trim()) : chatId,
      to: fromMe ? chatId : String(body.to || runtimeAccountId).trim(),
      author: fromMe ? "" : from,
      fromMe,
      body: text,
      timestamp,
    }, process.env, { routeAccountId });
  }

  @Post("whatsapp/inbound")
  async whatsappInbound(@Req() request: any, @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    ensureAttachmentsArray(body);
    try {
      const routed = await routeWhatsAppInbound({ ...body, deferApiAgentAutoRun: true, machineAuthContext: request.orkestrMachineAuthContext || null });
      if (routed.threadId && !routed.duplicate) {
        if ((routed as any).handledCommand) {
          await deliverWhatsAppReplies().catch(() => {});
          return response
            .status(202)
            .header("cache-control", "no-store")
            .type("application/json; charset=utf-8")
            .send(routed);
        }
        const thread = await getThread(String(routed.threadId || ""));
        if (threadUsesApiAgent(thread || {})) {
          const payload = await runWithRoutedWhatsAppTyping({ thread, input: body }, async () => {
            await deliverWhatsAppReplies().catch(() => null);
            await processApiAgentThreadInput(thread.id).catch(() => null);
            await deliverWhatsAppReplies().catch(() => {});
            return { ...routed, runtimeKind: "api-agent" };
          }, {
            startTyping: startWhatsAppTyping,
            stopTyping: stopWhatsAppTyping,
          });
          return response
            .status(202)
            .header("cache-control", "no-store")
            .type("application/json; charset=utf-8")
            .send(payload);
        }
        const typingTarget = routedWhatsAppTypingTarget({ thread, input: body });
        if (typingTarget) {
          await startWhatsAppTyping({ ...typingTarget, env: process.env }).catch(() => null);
        }
        await deliverWhatsAppReplies().catch(() => {});
        if (!(routed as any).remoteRuntime) requestThreadInputDelivery(routed.threadId);
      }
      return response
        .status(routed.duplicate ? 200 : 202)
        .header("cache-control", "no-store")
        .type("application/json; charset=utf-8")
        .send(routed);
    } catch (error: any) {
      const statusCode = errorStatusCode(error, 500);
      const code = statusCode >= 500 ? "whatsapp_inbound_route_failed" : errorSafeCode(error, "whatsapp_inbound_route_failed");
      const payload = publicRoutingFailurePayload(error, {
        code,
        retryable: statusCode >= 500,
      });
      const failure = (payload as any).routingFailure || {};
      reportServerError(process.env, {
        source: "server.whatsappInbound",
        code: String(failure.code || code),
        message: String(failure.reason || failure.safeMessage || code),
        method: "POST",
        route: "/api/connectors/whatsapp/inbound",
        statusCode,
        threadId: String(failure.threadId || ""),
        routerTraceId: String((body as any).routerTraceId || (body as any).traceId || ""),
        details: {
          connector: "whatsapp",
          capability: failure.capability || "whatsapp",
          provider: failure.provider || "whatsapp",
          instanceId: failure.instanceId || "",
          target: failure.target || "",
          retryable: String(Boolean(failure.retryable)),
          userFacingCategory: failure.userFacingCategory || "",
          chatIdPresent: String(Boolean(body.chatId || (body.chat && typeof body.chat === "object" && (body.chat as any).id) || body.fromChatId)),
          accountId: String(body.accountId || ""),
          eventIdPresent: String(Boolean(body.eventId || body.id || body.messageId)),
        },
      });
      return response
        .status(statusCode)
        .header("cache-control", "no-store")
        .type("application/json; charset=utf-8")
        .send(payload);
    }
  }

  @Post("whatsapp/inbound-media")
  @HttpCode(201)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 20 } }))
  async whatsappInboundMedia(
    @Req() request: any,
    @Body() body: Record<string, unknown> = {},
    @UploadedFiles() uploadedFiles: any[] = [],
  ) {
    if (!uploadedFiles.length) throw httpError("whatsapp_inbound_media_files_required", 400);
    const metadata = parseInboundUploadMetadata(body);
    const paths = dataPaths(process.env);
    const date = new Date().toISOString().slice(0, 10);
    const uploadDir = path.join(paths.home, "whatsapp-bridge", "inbound-media", "broker", date);
    await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
    const attachments: Array<Record<string, unknown>> = [];
    for (let index = 0; index < uploadedFiles.length; index += 1) {
      const file = uploadedFiles[index] || {};
      const meta = metadata[index] || {};
      const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);
      if (!buffer.length) throw httpError("whatsapp_inbound_media_empty", 400);
      if (buffer.length > 25 * 1024 * 1024) throw httpError("whatsapp_inbound_media_too_large", 413);
      const name = safeInboundUploadName(file.originalname || meta.filename || meta.name);
      const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}-${name}`;
      const savedPath = path.join(uploadDir, storedName);
      await fs.writeFile(savedPath, buffer, { mode: 0o600 });
      attachments.push({
        name,
        filename: name,
        mimetype: String(file.mimetype || meta.mimetype || meta.type || "application/octet-stream"),
        kind: String(meta.kind || "file"),
        size: buffer.length,
        path: savedPath,
        saved_path: savedPath,
        source: "broker_whatsapp_inbound_media_upload",
        sourceEventId: String(body.eventId || meta.sourceEventId || ""),
        chatId: String(body.chatId || meta.chatId || ""),
        accountId: String(body.accountId || meta.accountId || ""),
        uploadedAt: new Date().toISOString(),
      });
    }
    return {
      ok: true,
      machineAuth: request.orkestrMachineAuth || null,
      attachments,
    };
  }

  @Post("whatsapp/deliver")
  @HttpCode(200)
  async whatsappDeliver() {
    clearWhatsAppDeliveryIdleCache();
    return deliverWhatsAppReplies();
  }

  @Post(":id/config")
  @HttpCode(200)
  async updateConfig(@Param("id") id: string, @Body() body: Record<string, unknown> = {}) {
    return { config: await writeConnectorConfig(id, body) };
  }

  @Post(":id/test")
  @HttpCode(200)
  async testConnector(@Req() request: any, @Param("id") id: string) {
    const status = await getSetupStatus({ principal: requestPrincipal(request) });
    const connector = status.connectors.find((item) => item.id === id);
    if (!connector) throw httpError("unknown_connector", 404);
    return connector;
  }

  @Post(":id/actions/:action")
  @HttpCode(200)
  async connectorAction(@Param("id") id: string, @Param("action") action: string, @Body() body: Record<string, unknown> = {}) {
    try {
      return await runOverlayConnectorAction(id, action, { env: process.env, input: body });
    } catch (error) {
      throw httpError(String((error as Error)?.message || "connector_action_failed"), Number((error as any)?.statusCode || 400));
    }
  }
}

@Controller("oauth")
export class ConnectorCallbacksController {
  @Get("gmail/start")
  async gmailStart(@Query("account") account = "", @Res() response: any) {
    let payload: any = null;
    try {
      payload = await beginGmailOAuth(process.env, { account });
    } catch (error) {
      payload = {
        ok: false,
        state: "error",
        message: String((error as Error)?.message || "Gmail OAuth start failed."),
      };
    }
    const authorizeUrl = String(payload?.authorizeUrl || "").trim();
    if (payload?.ok !== false && authorizeUrl) {
      const desktopSlug = await gmailAuthDesktopSlug(payload);
      if (desktopSlug) {
        try {
          const browser = await openUrlInVirtualBrowser(desktopSlug, authorizeUrl);
          return response
            .status(200)
            .header("cache-control", "no-store")
            .type("text/html; charset=utf-8")
            .send(googleOAuthHtml({
              ok: true,
              state: "opened",
              title: "Gmail auth opened",
              message: `Gmail authorization opened in ${browser.label || desktopSlug}. Finish the Google login in that virtual browser.`,
              deskUrl: browser.desk_url || browser.url || "",
              desktopSlug,
              setupHref: "/setup/gmail",
              setupLabel: "Open Mail Setup",
            }));
        } catch (error) {
          return response
            .status(Number((error as any)?.statusCode || 502) || 502)
            .header("cache-control", "no-store")
            .type("text/html; charset=utf-8")
            .send(googleOAuthHtml({
              ok: false,
              state: "desktop_error",
              title: "Gmail auth failed",
              message: String((error as Error)?.message || "Gmail authorization could not be opened in the virtual browser."),
              authorizeUrl,
              desktopSlug,
              setupHref: "/setup/gmail",
              setupLabel: "Open Mail Setup",
            }));
        }
      }
      return response.redirect(302, authorizeUrl);
    }
    return response
      .status(500)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(googleOAuthHtml({
        ...payload,
        title: "Gmail auth failed",
        setupHref: "/setup/gmail",
        setupLabel: "Open Mail Setup",
      }));
  }

  @Get("gmail/callback")
  async gmailCallback(@Query() query: Record<string, string>, @Req() request: any, @Res() response: any) {
    const callbackState = String(query?.state || request?.query?.state || "").trim();
    const tenantForward = await forwardTenantOAuthCallbackIfNeeded(callbackState, request).catch((error) => ({
      status: Number((error as any)?.statusCode || 502) || 502,
      contentType: "text/html; charset=utf-8",
      body: googleOAuthHtml({
        ok: false,
        state: "error",
        title: "Gmail auth failed",
        message: String((error as Error)?.message || "tenant_oauth_forward_failed"),
        setupHref: "/setup/gmail",
        setupLabel: "Open Mail Setup",
      }),
    }));
    if (tenantForward) {
      return response
        .status(tenantForward.status)
        .header("cache-control", "no-store")
        .type(tenantForward.contentType)
        .send(tenantForward.body);
    }
    const result = await finishGmailOAuth(queryParamsFromRequest(request, query));
    await notifyGmailOAuthCallback(result).catch(() => null);
    const payload = googleOAuthCallbackPayload(result);
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(googleOAuthHtml(payload));
  }
}

@Controller("connect")
export class GoogleWorkspaceConnectController {
  @Get("google")
  async googleConnect(@Req() request: any, @Query("connect") connect = "", @Res() response: any) {
    let payload: any = null;
    try {
      payload = await getGoogleWorkspaceConnectRequest(connect, process.env);
    } catch (error) {
      payload = { ok: false, state: "error", error: String((error as Error)?.message || "google_workspace_connect_failed") };
    }
    const ok = payload?.ok === true;
    if (
      ok &&
      googleWorkspaceConnectRequestExists(payload) &&
      googleWorkspaceBrokeredConnectRequest(payload.request) &&
      await googleWorkspaceBrokerInstanceReachable(payload.request) &&
      !googleWorkspaceLinkPreviewRequest(request)
    ) {
      const connectorHref = googleWorkspaceBrokeredConnectorSetupHref(payload.request, process.env, "gmail");
      if (connectorHref) {
        return response
          .status(302)
          .header("cache-control", "no-store")
          .header("location", connectorHref)
          .type("text/plain; charset=utf-8")
          .send("Redirecting to Orkestr instance connector page.");
      }
    }
    if (googleWorkspaceConnectRequestExists(payload) && !(await googleWorkspaceConnectAccess(request, payload, response))) return;
    return response
      .status(ok ? 200 : Number((payload as any)?.statusCode || 400) || 400)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(googleWorkspaceConnectHtml({
        connectId: connect,
        request: payload?.request || {},
        error: ok ? "" : String(payload?.error || payload?.state || "Google Workspace connection link is not available."),
      }));
  }

  @Get("google/start")
  async googleStart(@Req() request: any, @Query() query: Record<string, string | string[]>, @Res() response: any) {
    const capabilities = Array.isArray(query.capability)
      ? query.capability
      : String(query.capability || "").split(/[\s,]+/g).filter(Boolean);
    try {
      if (String(query.capabilities_selected || "") === "1" && capabilities.length === 0) {
        const error: any = new Error("Select at least one Google Workspace capability.");
        error.statusCode = 400;
        throw error;
      }
      const connectId = String(query.connect || "");
      const payload = await getGoogleWorkspaceConnectRequest(connectId, process.env);
      if (googleWorkspaceConnectRequestExists(payload) && !(await googleWorkspaceConnectAccess(request, payload, response))) return;
      const started = await startGoogleWorkspaceOAuth(process.env, {
        connectId,
        capabilities,
        account: String(query.account || ""),
      });
      return response.redirect(302, started.authorizeUrl);
    } catch (error) {
      return response
        .status(Number((error as any)?.statusCode || 400) || 400)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(googleWorkspaceConnectHtml({
          connectId: String(query.connect || ""),
          error: String((error as Error)?.message || "Google Workspace OAuth could not start."),
        }));
    }
  }
}

@Controller("google-marketing/oauth")
export class GoogleMarketingCallbacksController {
  @Get("start")
  async googleMarketingStart(@Res() response: any) {
    let payload: any = null;
    try {
      payload = await runOverlayConnectorAction("google-marketing", "start-oauth", {
        env: process.env,
        input: {},
      });
    } catch (error) {
      payload = {
        ok: false,
        state: "error",
        message: String((error as Error)?.message || "Google Marketing OAuth start failed."),
      };
    }
    const authorizeUrl = String(payload?.authorizeUrl || payload?.auth_url || payload?.url || "").trim();
    if (payload?.ok !== false && authorizeUrl) {
      const desktopSlug = await googleMarketingAuthDesktopSlug(payload);
      if (desktopSlug) {
        try {
          const browser = await openUrlInVirtualBrowser(desktopSlug, authorizeUrl);
          return response
            .status(200)
            .header("cache-control", "no-store")
            .type("text/html; charset=utf-8")
            .send(googleMarketingOAuthHtml({
              ok: true,
              state: "opened",
              message: `Google Marketing authorization opened in ${browser.label || desktopSlug}. Finish the Google login in that virtual browser.`,
              deskUrl: browser.desk_url || browser.url || "",
              desktopSlug,
            }));
        } catch (error) {
          return response
            .status(Number((error as any)?.statusCode || 502) || 502)
            .header("cache-control", "no-store")
            .type("text/html; charset=utf-8")
            .send(googleMarketingOAuthHtml({
              ok: false,
              state: "desktop_error",
              message: String((error as Error)?.message || "Google Marketing authorization could not be opened in the virtual browser."),
              authorizeUrl,
              desktopSlug,
            }));
        }
      }
      return response.redirect(302, authorizeUrl);
    }
    return response
      .status(500)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(googleMarketingOAuthHtml(payload));
  }

  @Get("callback")
  async googleMarketingCallback(@Query() query: Record<string, string>, @Req() request: any, @Res() response: any) {
    const callbackState = String(query?.state || request?.query?.state || "").trim();
    const tenantForward = await forwardTenantOAuthCallbackIfNeeded(callbackState, request).catch((error) => ({
      status: Number((error as any)?.statusCode || 502) || 502,
      contentType: "text/html; charset=utf-8",
      body: googleOAuthHtml({
        ok: false,
        state: "error",
        title: "Gmail auth failed",
        message: String((error as Error)?.message || "tenant_oauth_forward_failed"),
        setupHref: "/setup/gmail",
        setupLabel: "Open Mail Setup",
      }),
    }));
    if (tenantForward) {
      return response
        .status(tenantForward.status)
        .header("cache-control", "no-store")
        .type(tenantForward.contentType)
        .send(tenantForward.body);
    }
    const isGmailCallback = callbackState.startsWith("gmail:");
    try {
      const result = await finishGmailOAuth(queryParamsFromRequest(request, query));
      await notifyGmailOAuthCallback(result).catch(() => null);
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(googleOAuthHtml(googleOAuthCallbackPayload(result)));
    } catch (error) {
      const message = String((error as Error)?.message || "");
      if (message && (isGmailCallback || !["gmail_oauth_state_mismatch", "gmail_oauth_code_required"].includes(message))) {
        return response
          .status(Number((error as any)?.statusCode || 500) || 500)
          .header("cache-control", "no-store")
          .type("text/html; charset=utf-8")
          .send(googleOAuthHtml({
            ok: false,
            state: "error",
            title: "Gmail auth failed",
            message,
            setupHref: "/setup/gmail",
            setupLabel: "Open Mail Setup",
          }));
      }
    }

    const callbackUrl = externalUrlFromRequest(request);
    let payload: any = null;
    try {
      payload = await runOverlayConnectorAction("google-marketing", "finish-oauth", {
        env: process.env,
        input: { callbackUrl },
      });
    } catch (error) {
      payload = {
        ok: false,
        state: "error",
        message: String((error as Error)?.message || "Google Marketing OAuth callback failed."),
      };
    }
    const ok = payload?.ok !== false;
    return response
      .status(ok ? 200 : 500)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(googleMarketingOAuthHtml(payload));
  }
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[\s,]+/g).map(clean).filter(Boolean);
}

function googleOAuthCallbackPayload(result: Record<string, unknown> = {}) {
  const provider = clean(result.provider);
  if (provider === "google_workspace") {
    const capabilities = stringArray(result.capabilities);
    const labels = googleWorkspaceCapabilityLabels(capabilities);
    const brokeredSetupHref = googleWorkspaceBrokeredConnectorSetupHref(result, process.env, "gmail");
    return {
      ok: true,
      state: clean(result.state) || "ok",
      title: "Google Workspace connected",
      message: labels.length
        ? `Google Workspace authorization is complete. Enabled capabilities: ${labels.join(", ")}.`
        : "Google Workspace authorization is complete, but no optional Workspace capabilities were granted.",
      setupHref: brokeredSetupHref || "/setup/gmail",
      setupLabel: brokeredSetupHref ? "Open Instance Connector" : "Open Connectors",
      setupReturnText: brokeredSetupHref
        ? "Return to this instance connector page to refresh the connection status."
        : "Return to setup to refresh the connector status.",
    };
  }
  return {
    ok: true,
    state: clean(result.state) || "ok",
    title: "Gmail connected",
    message: "Gmail authorization is complete. You can return to Orkestr.",
    setupHref: "/setup/gmail",
    setupLabel: "Open Mail Setup",
  };
}

async function notifyGmailOAuthCallback(result: Record<string, unknown> = {}) {
  const threadId = clean(result.threadId);
  if (!threadId) return null;
  const thread = await getThread(threadId).catch(() => null);
  if (!thread) return null;
  const binding = (thread as any).binding && typeof (thread as any).binding === "object" ? (thread as any).binding : {};
  const chatId = clean(result.chatId) || clean(binding.chatId);
  const accountId = clean(result.accountId) || clean(binding.responderAccountId) || clean(binding.outboundAccountId);
  const account = clean(result.account);
  const provider = clean(result.provider);
  const labels = provider === "google_workspace" ? googleWorkspaceCapabilityLabels(stringArray(result.capabilities)) : [];
  const text = provider === "google_workspace"
    ? [
        `Google Workspace authorization is complete${account ? ` for ${account}` : ""}.`,
        labels.length ? `Enabled: ${labels.join(", ")}.` : "No optional Workspace capabilities were granted.",
        "You can now ask me to use only the enabled Google capabilities from this chat.",
      ].join(" ")
    : [
        `Gmail authorization is complete${account ? ` for ${account}` : ""}.`,
        "You can now ask me to read, search, or summarize Gmail from this chat.",
      ].join(" ");
  const message = await appendThreadMessage(threadId, {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text,
    state: "completed",
    connector: chatId ? "whatsapp" : "gmail",
    chatId,
    accountId,
  });
  await deliverWhatsAppReplies().catch(() => null);
  return message;
}

function externalUrlFromRequest(request: any): string {
  const headers = request?.headers || {};
  const proto = String(headers["x-forwarded-proto"] || request?.protocol || "http").split(",")[0].trim();
  const host = String(headers["x-forwarded-host"] || headers.host || "127.0.0.1").split(",")[0].trim();
  const url = String(request?.originalUrl || request?.url || "");
  return `${proto}://${host}${url}`;
}

function queryParamsFromRequest(request: any, fallback: Record<string, string> = {}): URLSearchParams {
  const url = String(request?.originalUrl || request?.url || "");
  if (url.includes("?")) return new URL(url, "http://localhost").searchParams;
  return new URLSearchParams(fallback);
}

function tenantVmIdFromOAuthState(state = ""): string {
  const match = clean(state).match(/^tenant:([^:]+):/);
  return clean(match?.[1]);
}

function tenantCallbackTargetUrl(request: any, baseUrl = ""): string {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) {
    const error: any = new Error("tenant_oauth_endpoint_missing");
    error.statusCode = 502;
    throw error;
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    const error: any = new Error("tenant_oauth_endpoint_invalid");
    error.statusCode = 502;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    const error: any = new Error("tenant_oauth_endpoint_unsupported");
    error.statusCode = 502;
    throw error;
  }
  const originalUrl = clean(request?.originalUrl || request?.url || "/");
  return String(new URL(originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`, `${base}/`));
}

async function forwardTenantOAuthCallbackIfNeeded(state = "", request: any = {}) {
  const tenantVmId = tenantVmIdFromOAuthState(state);
  if (!tenantVmId) return null;
  if (clean(request?.headers?.["x-orkestr-oauth-forwarded"])) return null;
  if (tenantVmId === clean(process.env.ORKESTR_TENANT_VM_ID)) return null;
  const tenantVm = await getTenantVm(tenantVmId, process.env);
  const baseUrl = clean(tenantVm?.endpoint?.baseUrl || (tenantVm?.endpoint as any)?.url);
  const target = tenantCallbackTargetUrl(request, baseUrl);
  const upstream = await fetch(target, {
    method: "GET",
    headers: {
      accept: clean(request?.headers?.accept) || "text/html",
      "x-orkestr-oauth-forwarded": "1",
      "x-orkestr-tenant-vm-id": tenantVmId,
    },
  });
  return {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "text/html; charset=utf-8",
    body: await upstream.text(),
  };
}

function googleMarketingOAuthHtml(payload: Record<string, unknown> = {}): string {
  const ok = payload.ok !== false;
  return googleOAuthHtml({
    ...payload,
    title: ok ? "Google Marketing auth complete" : "Google Marketing auth failed",
    setupHref: "/setup/google-marketing",
    setupLabel: "Open Google Marketing Setup",
    setupReturnText: "Return to Google Marketing setup to refresh the connector status.",
  });
}

function googleOAuthHtml(payload: Record<string, unknown> = {}): string {
  const ok = payload.ok !== false;
  const title = String(payload.title || (ok ? "Google auth complete" : "Google auth failed"));
  const state = String(payload.state || (ok ? "ok" : "error"));
  const message = String(payload.message || payload.raw || "");
  const deskUrl = String(payload.deskUrl || "").trim();
  const authorizeUrl = String(payload.authorizeUrl || "").trim();
  const desktopSlug = String(payload.desktopSlug || "").trim();
  const setupHref = String(payload.setupHref || "/setup/gmail").trim();
  const setupLabel = String(payload.setupLabel || "Open Setup").trim();
  const setupReturnText = String(payload.setupReturnText || "Return to setup to refresh the connector status.").trim();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #061007; color: #eaffdf; font-family: Inter, system-ui, sans-serif; }
      main { width: min(720px, calc(100% - 32px)); padding: 28px; border: 1px solid rgba(128, 210, 138, .24); border-radius: 24px; background: #0d180f; box-shadow: 0 20px 50px rgba(0,0,0,.28); }
      .badge { display: inline-flex; padding: 5px 10px; border-radius: 999px; background: ${ok ? "rgba(101,198,222,.18)" : "rgba(255,116,96,.18)"}; color: ${ok ? "#aeeeff" : "#ffc8bd"}; font-weight: 900; text-transform: uppercase; font-size: 12px; }
      a { display: inline-flex; margin-top: 14px; padding: 10px 14px; border-radius: 999px; color: #061007; background: #a8ffb2; text-decoration: none; font-weight: 800; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <span class="badge">${escapeHtml(state)}</span>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${desktopSlug ? `<p>Desktop: ${escapeHtml(desktopSlug)}</p>` : ""}
      ${deskUrl ? `<a href="${escapeHtml(deskUrl)}" target="_blank" rel="noreferrer">Open Virtual Browser</a>` : ""}
      ${authorizeUrl ? `<a href="${escapeHtml(authorizeUrl)}" target="_blank" rel="noreferrer">Open Google Auth Directly</a>` : ""}
      <p>${escapeHtml(setupReturnText)}</p>
      <a href="${escapeHtml(setupHref)}">${escapeHtml(setupLabel)}</a>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function googleMarketingAuthDesktopSlug(payload: Record<string, unknown> = {}): Promise<string> {
  return googleAuthDesktopSlug(payload, "ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG");
}

async function gmailAuthDesktopSlug(payload: Record<string, unknown> = {}): Promise<string> {
  const settings = await readRuntimeSettings().catch(() => ({} as any));
  return googleAuthDesktopSlug(payload, "ORKESTR_GMAIL_AUTH_DESKTOP_SLUG", String(settings?.connectors?.gmail?.authDesktop || ""));
}

async function googleAuthDesktopSlug(payload: Record<string, unknown> = {}, specificEnvName = "", settingValue = ""): Promise<string> {
  const settings = settingValue ? null : await readRuntimeSettings().catch(() => ({} as any));
  return String(
    payload.authDesktopSlug ||
    payload.desktopSlug ||
    (specificEnvName ? process.env[specificEnvName] : "") ||
    settingValue ||
    settings?.desktops?.gmailAuth ||
    process.env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG ||
    "",
  ).trim();
}
