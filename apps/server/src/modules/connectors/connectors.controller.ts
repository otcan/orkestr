import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { getSetupStatus } from "../../../../../packages/core/src/setup.js";
import { runOverlayConnectorAction } from "../../../../../packages/connectors/src/connectors.js";
import { openUrlInVirtualBrowser } from "../../../../../packages/browsers/src/browsers.js";
import {
  finishGmailOAuth,
  getGmailMessage,
  listGmailMessages,
  startGmailOAuth as beginGmailOAuth,
} from "../../../../../packages/connectors/src/gmail.js";
import {
  pollOutlookDeviceOAuth,
  startOutlookDeviceOAuth,
} from "../../../../../packages/connectors/src/outlook.js";
import {
  deliverWhatsAppReplies,
  getWhatsAppChatParticipants,
  getWhatsAppStatus,
  routeWhatsAppInbound,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { loginCodexWithApiKey, startCodexDeviceAuth } from "../../../../../packages/connectors/src/codex.js";
import { requestThreadInputDelivery } from "../../../../../packages/core/src/runtime-leases.js";
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

@Controller("api/connectors")
export class ConnectorsController {
  @Post("codex/device-auth")
  @HttpCode(200)
  async codexDeviceAuth() {
    return startCodexDeviceAuth();
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

  @Post("outlook/oauth/start")
  @HttpCode(200)
  async startOutlookOAuth(@Body() body: Record<string, unknown> = {}) {
    return startOutlookDeviceOAuth(process.env, { account: String(body.account || "") });
  }

  @Post("outlook/oauth/poll")
  @HttpCode(200)
  async pollOutlookOAuth(@Body() body: Record<string, unknown> = {}) {
    return pollOutlookDeviceOAuth(String(body.pendingId || ""));
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
  async whatsappBridgeAccountStart(@Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    return {
      account: await startLocalWhatsAppAccount(accountId, process.env, {
        phoneNumber: String(body.phoneNumber || body.phone || ""),
        showNotification: body.showNotification !== false,
        intervalMs: Number(body.intervalMs || 0) || undefined,
        authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
      }),
    };
  }

  @Post("whatsapp/bridge/accounts/:accountId/start-phone")
  @HttpCode(202)
  async whatsappBridgeAccountStartPhone(@Param("accountId") accountId: string, @Body() body: Record<string, unknown> = {}) {
    return {
      account: await startLocalWhatsAppAccount(accountId, process.env, {
        phoneNumber: String(body.phoneNumber || body.phone || ""),
        showNotification: body.showNotification !== false,
        intervalMs: Number(body.intervalMs || 0) || undefined,
        authReadyTimeoutMs: Number(body.authReadyTimeoutMs || body.authTimeoutMs || 0) || undefined,
      }),
    };
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
      participantIds: bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants")),
    });
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats/:chatId/participants")
  async whatsappBridgeChatParticipants(@Param("accountId") accountId: string, @Param("chatId") chatId: string) {
    return getWhatsAppChatParticipants({ accountId, chatId });
  }

  @Get("whatsapp/bridge/qr.svg")
  async whatsappBridgeQr(@Query("accountId") accountId = "", @Res() response: any) {
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
    if (routed.threadId && !routed.duplicate) {
      await deliverWhatsAppReplies().catch(() => {});
      requestThreadInputDelivery(routed.threadId);
    }
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
      const desktopSlug = gmailAuthDesktopSlug(payload);
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
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><title>Gmail connected</title><h1>Gmail callback received</h1><p>State: ${escapeHtml(result.state)}</p>`);
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
      const desktopSlug = googleMarketingAuthDesktopSlug(payload);
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
  async googleMarketingCallback(@Query() _query: Record<string, string>, @Req() request: any, @Res() response: any) {
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

function externalUrlFromRequest(request: any): string {
  const headers = request?.headers || {};
  const proto = String(headers["x-forwarded-proto"] || request?.protocol || "http").split(",")[0].trim();
  const host = String(headers["x-forwarded-host"] || headers.host || "127.0.0.1").split(",")[0].trim();
  const url = String(request?.originalUrl || request?.url || "");
  return `${proto}://${host}${url}`;
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

function googleMarketingAuthDesktopSlug(payload: Record<string, unknown> = {}): string {
  return googleAuthDesktopSlug(payload, "ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG");
}

function gmailAuthDesktopSlug(payload: Record<string, unknown> = {}): string {
  return googleAuthDesktopSlug(payload, "ORKESTR_GMAIL_AUTH_DESKTOP_SLUG");
}

function googleAuthDesktopSlug(payload: Record<string, unknown> = {}, specificEnvName = ""): string {
  return String(
    payload.authDesktopSlug ||
    payload.desktopSlug ||
    (specificEnvName ? process.env[specificEnvName] : "") ||
    process.env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG ||
    "",
  ).trim();
}
