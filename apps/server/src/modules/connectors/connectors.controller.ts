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
  getWhatsAppStatus,
  routeWhatsAppInbound,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../../../../../packages/storage/src/config.js";
import { ensureAttachmentsArray, httpError } from "../../common/http.js";

@Controller("api/connectors")
export class ConnectorsController {
  @Get("gmail/oauth/start")
  async startGmailOAuth() {
    return beginGmailOAuth();
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
