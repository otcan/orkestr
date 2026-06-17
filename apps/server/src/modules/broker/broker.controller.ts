import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import crypto from "node:crypto";
import {
  decryptBrokerInstanceRequest,
  heartbeatBrokerInstance,
  listBrokerInstances,
  registerBrokerInstance,
} from "../../../../../packages/core/src/broker-instance-registry.js";
import {
  getWhatsAppChatMessages,
  sendWhatsAppText,
} from "../../../../../packages/connectors/src/whatsapp.js";
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

function brokerWhatsAppAccountId(record: any): string {
  return clean(record.relayAccountId || process.env.ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID || process.env.ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID || "responder");
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
    const accountId = brokerWhatsAppAccountId(record);
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
    const accountId = brokerWhatsAppAccountId(record);
    const history = await brokerCall(() => getWhatsAppChatMessages({
      accountId,
      chatId,
      limit: Number(payload.limit || 80) || 80,
    }, process.env));
    return { ok: true, instanceId: record.instanceId, accountId, chatId, messages: history.messages || [] };
  }
}
