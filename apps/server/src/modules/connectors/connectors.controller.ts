import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
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
  googleWorkspaceConnectHtml,
  startGoogleWorkspaceOAuth,
} from "../../../../../packages/connectors/src/google-workspace.js";
import {
  googleWorkspaceCapabilityLabels,
} from "../../../../../packages/connectors/src/google-workspace-scopes.js";
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
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
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
  startLocalWhatsAppTyping,
  startLocalWhatsAppAccount,
  stopLocalWhatsAppTyping,
} from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { runWithRoutedWhatsAppTyping } from "../../../../../packages/connectors/src/whatsapp-router-typing.js";
import { findWhatsAppAccountByAnyId } from "../../../../../packages/connectors/src/whatsapp-account-identity.js";
import { writeConnectorConfig } from "../../../../../packages/storage/src/config.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";
import { reportServerError } from "../../watcher-reporting.js";

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
    return recoverLocalWhatsAppChatMessages({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(accountId),
      chatId,
      limit: Number(body.limit || 20) || 20,
      unreadOnly: body.unreadOnly !== false,
      markSeen: body.markSeen !== false,
    });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/admins")
  @HttpCode(200)
  async whatsappBridgePromoteGroupAdmins(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    return promoteLocalWhatsAppGroupParticipants({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(accountId),
      chatId,
      participantIds: bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants")),
    });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/admins/demote")
  @HttpCode(200)
  async whatsappBridgeDemoteGroupAdmins(@Req() request: any, @Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    await assertWhatsAppBridgeBindingAcl("manage", { accountId, chatId }, request.orkestrMachineAuthContext);
    return demoteLocalWhatsAppGroupParticipants({
      accountId: await resolveLocalWhatsAppRuntimeAccountId(accountId),
      chatId,
      participantIds: bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants")),
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
    return sendWhatsAppText({
      chatId: String(body.to || body.chatId || ""),
      text: String(body.text || ""),
      accountId: String(body.accountId || ""),
      attachments: paths.map((filePath) => ({ path: filePath })),
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
            startTyping: startLocalWhatsAppTyping,
            stopTyping: stopLocalWhatsAppTyping,
          });
          return response
            .status(202)
            .header("cache-control", "no-store")
            .type("application/json; charset=utf-8")
            .send(payload);
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
  async gmailCallback(@Query() query: Record<string, string>, @Res() response: any) {
    const result = await finishGmailOAuth(new URLSearchParams(query));
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
  async googleConnect(@Query("connect") connect = "", @Res() response: any) {
    let payload: any = null;
    try {
      payload = await getGoogleWorkspaceConnectRequest(connect, process.env);
    } catch (error) {
      payload = { ok: false, state: "error", error: String((error as Error)?.message || "google_workspace_connect_failed") };
    }
    const ok = payload?.ok === true;
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
  async googleStart(@Query() query: Record<string, string | string[]>, @Res() response: any) {
    const capabilities = Array.isArray(query.capability)
      ? query.capability
      : String(query.capability || "").split(/[\s,]+/g).filter(Boolean);
    try {
      const started = await startGoogleWorkspaceOAuth(process.env, {
        connectId: String(query.connect || ""),
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
      if (message && !["gmail_oauth_state_mismatch", "gmail_oauth_code_required"].includes(message)) {
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
    return {
      ok: true,
      state: clean(result.state) || "ok",
      title: "Google Workspace connected",
      message: labels.length
        ? `Google Workspace authorization is complete. Enabled capabilities: ${labels.join(", ")}.`
        : "Google Workspace authorization is complete, but no optional Workspace capabilities were granted.",
      setupHref: "/setup/gmail",
      setupLabel: "Open Connectors",
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
