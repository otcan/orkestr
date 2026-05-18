import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import { getSetupStatus } from "../../../../../packages/core/src/setup.js";
import {
  finishGmailOAuth,
  getGmailMessage,
  listGmailMessages,
  startGmailOAuth as beginGmailOAuth,
} from "../../../../../packages/connectors/src/gmail.js";
import {
  deliverWhatsAppReplies,
  getWhatsAppChatParticipants,
  getWhatsAppStatus,
  routeWhatsAppInbound,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { startCodexDeviceAuth } from "../../../../../packages/connectors/src/codex.js";
import {
  createLocalWhatsAppChat,
  getLocalWhatsAppBridgeStatus,
  getLocalWhatsAppQrSvg,
  listLocalWhatsAppChats,
  logoutLocalWhatsAppAccount,
  sendLocalWhatsAppText,
  startLocalWhatsAppAccount,
} from "../../../../../packages/connectors/src/whatsapp-local-bridge.js";
import { writeConnectorConfig } from "../../../../../packages/storage/src/config.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";

@Controller("api/connectors")
export class ConnectorsController {
  @Post("codex/device-auth")
  @HttpCode(200)
  async codexDeviceAuth() {
    return startCodexDeviceAuth();
  }

  @Get("gmail/oauth/start")
  async startGmailOAuth(@Query("account") account = "") {
    return beginGmailOAuth(process.env, { account });
  }

  @Get("gmail/messages")
  async gmailMessages(@Query("maxResults") maxResults = "10", @Query("q") query = "") {
    return listGmailMessages({ maxResults: Number(maxResults || 10), query });
  }

  @Get("gmail/messages/:id")
  async gmailMessage(@Param("id") id: string) {
    return { message: await getGmailMessage(id) };
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
  async whatsappBridgeAccounts() {
    const status = await getLocalWhatsAppBridgeStatus();
    return { accounts: status.accounts, state: status.state };
  }

  @Post("whatsapp/bridge/accounts/:accountId/start")
  @HttpCode(202)
  async whatsappBridgeAccountStart(@Param("accountId") accountId: string) {
    return { account: await startLocalWhatsAppAccount(accountId) };
  }

  @Post("whatsapp/bridge/accounts/:accountId/logout")
  @HttpCode(200)
  async whatsappBridgeAccountLogout(@Param("accountId") accountId: string) {
    return { account: await logoutLocalWhatsAppAccount(accountId) };
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats")
  async whatsappBridgeAccountChats(@Param("accountId") accountId: string) {
    return listLocalWhatsAppChats(accountId);
  }

  @Post("whatsapp/bridge/chats")
  @HttpCode(200)
  async whatsappBridgeCreateChat(@Body() body: Record<string, unknown> = {}) {
    return createLocalWhatsAppChat({
      name: String(body.name || body.displayName || ""),
      senderAccountId: String(body.senderAccountId || ""),
      responderAccountId: String(body.responderAccountId || body.outboundAccountId || ""),
    });
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats/:chatId/participants")
  async whatsappBridgeChatParticipants(@Param("accountId") accountId: string, @Param("chatId") chatId: string) {
    return getWhatsAppChatParticipants({ accountId, chatId });
  }

  @Get("whatsapp/bridge/qr.svg")
  async whatsappBridgeQr(@Query("accountId") accountId = "account-1", @Res() response: any) {
    const svg = await getLocalWhatsAppQrSvg(accountId);
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
  async whatsappBridgeSendText(@Body() body: Record<string, unknown> = {}) {
    return sendLocalWhatsAppText({
      chatId: String(body.to || body.chatId || ""),
      text: String(body.text || ""),
      accountId: String(body.accountId || ""),
    });
  }

  @Post("whatsapp/inbound")
  async whatsappInbound(@Body() body: Record<string, unknown> = {}, @Res() response: any) {
    ensureAttachmentsArray(body);
    const routed = await routeWhatsAppInbound(body);
    return response
      .status(routed.duplicate ? 200 : 202)
      .header("cache-control", "no-store")
      .type("application/json; charset=utf-8")
      .send(routed);
  }

  @Post("whatsapp/deliver")
  @HttpCode(200)
  async whatsappDeliver() {
    return deliverWhatsAppReplies();
  }

  @Post(":id/config")
  @HttpCode(200)
  async updateConfig(@Param("id") id: string, @Body() body: Record<string, unknown> = {}) {
    return { config: await writeConnectorConfig(id, body) };
  }

  @Post(":id/test")
  @HttpCode(200)
  async testConnector(@Param("id") id: string) {
    const status = await getSetupStatus();
    const connector = status.connectors.find((item) => item.id === id);
    if (!connector) throw httpError("unknown_connector", 404);
    return connector;
  }
}

@Controller("oauth")
export class ConnectorCallbacksController {
  @Get("gmail/callback")
  async gmailCallback(@Query() query: Record<string, string>, @Res() response: any) {
    const result = await finishGmailOAuth(new URLSearchParams(query));
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><title>Gmail connected</title><h1>Gmail callback received</h1><p>State: ${escapeHtml(result.state)}</p>`);
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
