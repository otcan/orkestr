import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import crypto from "node:crypto";
import {
  decryptBrokerClientPayload,
  decryptBrokerInstanceRequest,
  brokerWhatsAppRelayAccountId,
  heartbeatBrokerInstance,
  listBrokerInstances,
  registerBrokerInstance,
} from "../../../../../packages/core/src/broker-instance-registry.js";
import {
  createGoogleWorkspaceConnectLink,
} from "../../../../../packages/connectors/src/google-workspace.js";
import {
  refreshGmailBrokerToken,
  saveBrokeredGmailGrant,
} from "../../../../../packages/connectors/src/gmail.js";
import {
  getWhatsAppChatMessages,
  sendWhatsAppText,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { userPrincipal } from "../../../../../packages/core/src/principal.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function whatsAppChatIdFromNumber(value: unknown): string {
  const digits = clean(value).replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : "";
}

function assertRegisteredWhatsAppNumber(record: any, payload: any): string {
  const chatId = whatsAppChatIdFromNumber(
    payload.whatsappNumber ||
      payload.targetWhatsAppNumber ||
      payload.whatsappPhoneNumber ||
      payload.targetPhoneNumber ||
      payload.toPhoneNumber,
  );
  if (!chatId) throw httpError("broker_whatsapp_number_required", 400);
  const expectedHash = clean(record.whatsappChatHash);
  if (!expectedHash) throw httpError("broker_whatsapp_target_not_registered", 403);
  if (expectedHash && sha256(chatId) !== expectedHash) throw httpError("broker_whatsapp_chat_denied", 403);
  return chatId;
}

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

async function brokerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    throw httpError(String(error?.message || "broker_request_failed"), Number(error?.statusCode || 500));
  }
}

@Controller("api/broker")
export class BrokerController {
  @Post("instances/register")
  @HttpCode(200)
  async registerInstance(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return brokerCall(() => registerBrokerInstance({
      body,
      request,
      env: process.env,
      trustedAdmin: isAdminPrincipal(requestPrincipal(request)),
    }));
  }

  @Post("instances/:instanceId/heartbeat")
  @HttpCode(200)
  async heartbeatInstance(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return brokerCall(() => heartbeatBrokerInstance(instanceId, { body, request, env: process.env }));
  }

  @Get("instances")
  async instances(@Req() request: any) {
    assertAdminRequest(request);
    return listBrokerInstances(process.env);
  }

  @Post("instances/:instanceId/whatsapp/onboarding")
  @HttpCode(200)
  async sendOnboardingWhatsApp(
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { record, payload } = await brokerCall(() => decryptBrokerInstanceRequest(instanceId, body, process.env));
    const chatId = assertRegisteredWhatsAppNumber(record, payload);
    const text = clean(payload.text);
    if (!text) throw httpError("broker_whatsapp_text_required", 400);
    const accountId = brokerWhatsAppRelayAccountId(record, process.env);
    const sent = await brokerCall(() => sendWhatsAppText({
      accountId,
      chatId,
      text,
      crossAccountEchoSuppression: payload.crossAccountEchoSuppression !== false,
      env: process.env,
    }));
    return { ok: true, instanceId: record.instanceId, accountId, chatId, sent };
  }

  @Post("instances/:instanceId/whatsapp/history")
  @HttpCode(200)
  async whatsappHistory(
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { record, payload } = await brokerCall(() => decryptBrokerInstanceRequest(instanceId, body, process.env));
    const chatId = assertRegisteredWhatsAppNumber(record, payload);
    const accountId = brokerWhatsAppRelayAccountId(record, process.env);
    const history = await brokerCall(() => getWhatsAppChatMessages({
      accountId,
      chatId,
      limit: Number(payload.limit || 80) || 80,
    }, process.env));
    return { ok: true, instanceId: record.instanceId, accountId, chatId, messages: history.messages || [] };
  }

  @Post("instances/:instanceId/google-workspace/connect-link")
  @HttpCode(200)
  async googleWorkspaceConnectLink(
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { record, payload } = await brokerCall(() => decryptBrokerInstanceRequest(instanceId, body, process.env));
    const userId = clean(payload.userId || record.instanceId);
    const threadId = clean(payload.threadId);
    const chatId = clean(payload.chatId);
    const accountId = clean(payload.accountId);
    const principal = userPrincipal({
      id: userId,
      role: "user",
      source: "broker-instance",
      displayName: clean(payload.displayName || record.displayName || userId),
    });
    const link = await brokerCall(() => createGoogleWorkspaceConnectLink({
      principal,
      thread: {
        id: threadId,
        name: clean(payload.threadName || payload.threadTitle || threadId),
        ownerUserId: userId,
        binding: {
          connector: "whatsapp",
          chatId,
          responderAccountId: accountId,
          outboundAccountId: accountId,
        },
      },
      chatId,
      accountId,
      account: clean(payload.account),
      googleConnectionId: clean(payload.googleConnectionId),
      oauthAppId: clean(payload.oauthAppId || payload.oauth_app),
      alias: clean(payload.connectionAlias || payload.alias),
      useMode: clean(payload.connectionUseMode || payload.useMode),
      setAsMain: payload.setAsMain === true,
      setAsThreadDefault: payload.setAsThreadDefault === true,
      brokerInstanceId: record.instanceId,
      brokerTenantVmId: clean(payload.tenantVmId),
      brokerTenantUserId: userId,
      brokerTenantThreadId: threadId,
      brokerTenantThreadName: clean(payload.threadName || payload.threadTitle || threadId),
      brokerTenantChatId: chatId,
      brokerTenantAccountId: accountId,
      brokerServerRequest: true,
    }, process.env));
    return { ...link, ok: true, instanceId: record.instanceId };
  }

  @Post("instances/:instanceId/google-workspace/refresh-token")
  @HttpCode(200)
  async googleWorkspaceRefreshToken(
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    const { record, payload } = await brokerCall(() => decryptBrokerInstanceRequest(instanceId, body, process.env));
    const refreshToken = clean(payload.refreshToken);
    if (!refreshToken) throw httpError("broker_google_workspace_refresh_token_required", 400);
    const token = await brokerCall(() => refreshGmailBrokerToken(refreshToken, process.env, fetch, {
      oauthAppId: clean(payload.oauthAppId || payload.oauth_app),
    }));
    return { ok: true, instanceId: record.instanceId, token };
  }

  @Post("google-workspace/grants")
  @HttpCode(200)
  async receiveGoogleWorkspaceGrant(@Body() body: Record<string, unknown> = {}) {
    const { registration, payload } = await brokerCall(() => decryptBrokerClientPayload(body, process.env));
    const saved = await brokerCall(() => saveBrokeredGmailGrant({
      ...payload,
      brokerInstanceId: clean(payload.brokerInstanceId || registration.instanceId),
    }, process.env));
    return { ok: true, instanceId: registration.instanceId, grant: saved };
  }
}
