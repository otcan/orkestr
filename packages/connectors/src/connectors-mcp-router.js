import {
  ensureConnectorInboxEvent,
  listConnectorInboxEvents,
  markConnectorInboxEvent,
} from "./connector-inbox.js";
import { tenantWhatsAppInboundForwardRoute } from "../../core/src/tenant-whatsapp-routing.js";

function clean(value = "") {
  return String(value || "").trim();
}

function localInboundTarget(env = process.env) {
  const explicit = clean(env.ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL);
  if (explicit) return explicit;
  const port = Number(env.ORKESTR_UI_PORT || env.ORKESTR_PORT || env.PORT || 19812) || 19812;
  return `http://127.0.0.1:${port}/api/connectors/whatsapp/inbound`;
}

function localInboundToken(env = process.env) {
  return clean(
    env.ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_TOKEN ||
    env.ORKESTR_WHATSAPP_INBOUND_TOKEN ||
    env.WHATSAPP_INBOUND_TOKEN,
  ).split(/[\s,]+/g)[0] || "";
}

function retryDelayMs(attempt = 1, env = process.env) {
  const base = Math.max(1000, Number(env.ORKESTR_CONNECTOR_INBOX_RETRY_MS || 5000) || 5000);
  return Math.min(5 * 60_000, base * (2 ** Math.max(0, attempt - 1)));
}

function maxAttempts(env = process.env) {
  return Math.max(1, Number(env.ORKESTR_CONNECTOR_INBOX_MAX_ATTEMPTS || 5) || 5);
}

async function deliveryTarget(payload = {}, env = process.env) {
  const tenant = await tenantWhatsAppInboundForwardRoute(payload, env);
  if (tenant?.target) return { target: tenant.target, token: clean(tenant.token), route: tenant };
  return { target: localInboundTarget(env), token: localInboundToken(env), route: null };
}

export async function deliverConnectorInboxEvent(event = {}, env = process.env, fetchImpl = fetch) {
  const attemptCount = Number(event.attemptCount || 0) + 1;
  try {
    const route = await deliveryTarget(event.payload, env);
    if (!route.target) throw Object.assign(new Error("connector_inbound_target_missing"), { statusCode: 503 });
    const response = await fetchImpl(route.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
      },
      body: JSON.stringify(event.payload),
      signal: AbortSignal.timeout(Math.max(1000, Number(env.ORKESTR_CONNECTOR_INBOX_DELIVERY_TIMEOUT_MS || 60_000) || 60_000)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(clean(payload?.error) || `connector_inbound_http_${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return markConnectorInboxEvent(event.id, {
      state: "delivered",
      attemptCount,
      nextAttemptAt: "",
      error: "",
      result: {
        target: route.target,
        routeMode: route.route?.routeMode || "local",
        tenantVmId: route.route?.tenantVmId || "",
        response: payload,
      },
    }, env);
  } catch (error) {
    const terminal = attemptCount >= maxAttempts(env);
    const nextAttemptAt = terminal ? "" : new Date(Date.now() + retryDelayMs(attemptCount, env)).toISOString();
    return markConnectorInboxEvent(event.id, {
      state: terminal ? "dead_letter" : "failed_retryable",
      attemptCount,
      nextAttemptAt,
      error: clean(error?.message) || "connector_inbound_delivery_failed",
    }, env);
  }
}

export async function routeWhatsAppInboundFromWorker(payload = {}, env = process.env, fetchImpl = fetch) {
  const id = clean(payload.eventId || payload.id || payload.messageId);
  const ensured = await ensureConnectorInboxEvent({
    id,
    connector: "whatsapp",
    accountId: payload.accountId,
    conversationId: payload.chatId || payload.fromChatId,
    payload,
  }, env);
  if (!ensured.created && ensured.event.state === "delivered") {
    return { ok: true, duplicate: true, state: "delivered", eventId: id, result: ensured.event.result };
  }
  const delivered = await deliverConnectorInboxEvent(ensured.event, env, fetchImpl);
  return {
    ok: delivered?.state === "delivered",
    queued: delivered?.state === "failed_retryable",
    eventId: id,
    state: delivered?.state || "unknown",
    attemptCount: delivered?.attemptCount || 0,
    error: delivered?.error || "",
    result: delivered?.result || null,
  };
}

export async function retryConnectorInbox(env = process.env, fetchImpl = fetch) {
  const events = await listConnectorInboxEvents({ states: ["pending", "failed_retryable"], limit: 100 }, env);
  const due = events.filter((event) => !event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= Date.now());
  const results = [];
  for (const event of due) results.push(await deliverConnectorInboxEvent(event, env, fetchImpl));
  return { inspected: events.length, attempted: due.length, results };
}
