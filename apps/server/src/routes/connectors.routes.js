import { getSetupStatus } from "../../../../packages/core/src/setup.js";
import { finishGmailOAuth, getGmailMessage, listGmailMessages, startGmailOAuth } from "../../../../packages/connectors/src/gmail.js";
import { deliverWhatsAppReplies, getWhatsAppStatus, routeWhatsAppInbound } from "../../../../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../../../../packages/storage/src/config.js";
import {
  connectorConfigSchema,
  connectorTestSchema,
  gmailMessageSchema,
  gmailMessagesSchema,
  whatsappInboundSchema,
} from "../../../../packages/shared/src/api-schemas.js";
import { json } from "../http.js";

export async function registerConnectorRoutes(app) {
  app.get("/api/connectors/gmail/oauth/start", async (_request, reply) => {
    return json(reply, 200, await startGmailOAuth());
  });

  app.get("/api/connectors/gmail/messages", { schema: gmailMessagesSchema }, async (request, reply) => {
    return json(reply, 200, await listGmailMessages({
      maxResults: request.query.maxResults || 10,
      query: request.query.q || "",
    }));
  });

  app.get("/api/connectors/gmail/messages/:id", { schema: gmailMessageSchema }, async (request, reply) => {
    return json(reply, 200, { message: await getGmailMessage(request.params.id) });
  });

  app.get("/api/connectors/whatsapp/status", async (_request, reply) => {
    return json(reply, 200, await getWhatsAppStatus());
  });

  app.post("/api/connectors/whatsapp/inbound", { schema: whatsappInboundSchema }, async (request, reply) => {
    const routed = await routeWhatsAppInbound(request.body || {});
    return json(reply, routed.duplicate ? 200 : 202, routed);
  });

  app.post("/api/connectors/whatsapp/deliver", async (_request, reply) => {
    return json(reply, 200, await deliverWhatsAppReplies());
  });

  app.post("/api/connectors/:id/config", { schema: connectorConfigSchema }, async (request, reply) => {
    return json(reply, 200, { config: await writeConnectorConfig(request.params.id, request.body || {}) });
  });

  app.post("/api/connectors/:id/test", { schema: connectorTestSchema }, async (request, reply) => {
    const status = await getSetupStatus();
    const connector = status.connectors.find((item) => item.id === request.params.id);
    if (!connector) return json(reply, 404, { error: "unknown_connector" });
    return json(reply, 200, connector);
  });
}

export async function registerConnectorCallbackRoutes(app) {
  app.get("/oauth/gmail/callback", async (request, reply) => {
    const result = await finishGmailOAuth(new URLSearchParams(request.query));
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><title>Gmail connected</title><h1>Gmail callback received</h1><p>State: ${escapeHtml(result.state)}</p>`);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
