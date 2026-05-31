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
  pollOutlookDeviceOAuth,
  startOutlookDeviceOAuth,
} from "../../../../../packages/connectors/src/outlook.js";
import {
  deliverWhatsAppReplies,
  getWhatsAppChatParticipants,
  getWhatsAppStatus,
  routeWhatsAppInbound,
} from "../../../../../packages/connectors/src/whatsapp.js";
import { createAndBindWhatsAppThreadGroup } from "../../../../../packages/connectors/src/whatsapp-thread-groups.js";
import { loginCodexWithApiKey, startCodexDeviceAuth } from "../../../../../packages/connectors/src/codex.js";
import { requestThreadInputDelivery } from "../../../../../packages/core/src/runtime-leases.js";
import { getThread, getThreadForPrincipal } from "../../../../../packages/core/src/threads.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../../../../../packages/core/src/tenant-api-agent.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import {
  createLocalWhatsAppChat,
  generateLocalWhatsAppChatPicture,
  getLocalWhatsAppBridgeStatus,
  getLocalWhatsAppQrSvg,
  listLocalWhatsAppChats,
  logoutLocalWhatsAppAccount,
  promoteLocalWhatsAppGroupParticipants,
  recoverLocalWhatsAppChatMessages,
  sendLocalWhatsAppMessage,
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
    const requestedParticipants = bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants"));
    const participantIds = requestedParticipants.length
      ? requestedParticipants
      : envStringArray(
        "ORKESTR_WHATSAPP_DEFAULT_GROUP_PARTICIPANTS",
        "ORKESTR_WHATSAPP_DEFAULT_PARTICIPANT_IDS",
        "ORKESTR_WHATSAPP_OWNER_CONTACT_IDS",
      );
    const promoteParticipantsAsAdmins = optionalBodyBoolean(body, "promoteParticipantsAsAdmins", participantIds.length > 0);
    return createLocalWhatsAppChat({
      name: String(body.name || body.displayName || ""),
      senderAccountId: String(body.senderAccountId || ""),
      responderAccountId: String(body.responderAccountId || body.outboundAccountId || ""),
      participantIds,
      adminParticipantIds: bodyStringArray(body, "adminParticipantIds"),
      promoteParticipantsAsAdmins,
      generatePicture: optionalBodyBoolean(body, "generatePicture", true),
    });
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
    return createAndBindWhatsAppThreadGroup(thread, {
      name: String(body.name || body.displayName || ""),
      senderAccountId: String(body.senderAccountId || ""),
      responderAccountId: String(body.responderAccountId || body.outboundAccountId || ""),
      outboundAccountId: String(body.outboundAccountId || ""),
      participantIds,
      adminParticipantIds: bodyStringArray(body, "adminParticipantIds"),
      promoteParticipantsAsAdmins: optionalBodyBoolean(body, "promoteParticipantsAsAdmins", participantIds.length > 0),
      generatePicture: optionalBodyBoolean(body, "generatePicture", true),
      mirrorToWhatsApp: optionalBodyBoolean(body, "mirrorToWhatsApp", true),
      replyPrefix: String(body.replyPrefix || ""),
      forceNew: optionalBodyBoolean(body, "forceNew", false),
    });
  }

  @Post("whatsapp/bridge/chats/:chatId/picture")
  @HttpCode(200)
  async whatsappBridgeGenerateChatPicture(@Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    return generateLocalWhatsAppChatPicture({
      accountId: String(body.accountId || body.responderAccountId || body.outboundAccountId || ""),
      chatId,
      title: String(body.title || body.name || ""),
    });
  }

  @Get("whatsapp/bridge/accounts/:accountId/chats/:chatId/participants")
  async whatsappBridgeChatParticipants(@Param("accountId") accountId: string, @Param("chatId") chatId: string) {
    return getWhatsAppChatParticipants({ accountId, chatId });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/recover")
  @HttpCode(200)
  async whatsappBridgeRecoverChat(@Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    return recoverLocalWhatsAppChatMessages({
      accountId,
      chatId,
      limit: Number(body.limit || 20) || 20,
      unreadOnly: body.unreadOnly !== false,
      markSeen: body.markSeen !== false,
    });
  }

  @Post("whatsapp/bridge/accounts/:accountId/chats/:chatId/admins")
  @HttpCode(200)
  async whatsappBridgePromoteGroupAdmins(@Param("accountId") accountId: string, @Param("chatId") chatId: string, @Body() body: Record<string, unknown> = {}) {
    return promoteLocalWhatsAppGroupParticipants({
      accountId,
      chatId,
      participantIds: bodyStringArray(body, "participantIds").concat(bodyStringArray(body, "participants")),
    });
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

  @Post("whatsapp/bridge/send-media")
  @HttpCode(200)
  async whatsappBridgeSendMedia(@Body() body: Record<string, unknown> = {}) {
    const paths = Array.isArray(body.paths)
      ? body.paths.map((value) => String(value || "").trim()).filter(Boolean)
      : [String(body.path || "").trim()].filter(Boolean);
    return sendLocalWhatsAppMessage({
      chatId: String(body.to || body.chatId || ""),
      text: String(body.text || ""),
      accountId: String(body.accountId || ""),
      attachments: paths.map((filePath) => ({ path: filePath })),
    });
  }

  @Post("whatsapp/inbound")
  async whatsappInbound(@Body() body: Record<string, unknown> = {}, @Res() response: any) {
    ensureAttachmentsArray(body);
    const routed = await routeWhatsAppInbound(body);
    if (routed.threadId && !routed.duplicate) {
      const thread = await getThread(String(routed.threadId || ""));
      if (threadUsesApiAgent(thread || {})) {
        await processApiAgentThreadInput(thread.id).catch(() => null);
        await deliverWhatsAppReplies().catch(() => {});
        return response
          .status(202)
          .header("cache-control", "no-store")
          .type("application/json; charset=utf-8")
          .send({ ...routed, runtimeKind: "api-agent" });
      }
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
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(googleOAuthHtml({
          ok: true,
          state: result.state,
          title: "Gmail connected",
          message: "Gmail authorization is complete. You can return to Orkestr.",
          setupHref: "/setup/gmail",
          setupLabel: "Open Mail Setup",
        }));
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
