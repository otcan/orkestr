import crypto from "node:crypto";
import {
  ensureConnectorInboxEvent,
  getConnectorInboxEvent,
  listConnectorInboxEvents,
  markConnectorInboxEvent,
} from "./connector-inbox.js";
import {
  classifyConnectorInboxDelivery,
  connectorInboxEventIsTerminal,
  connectorInboxReplayEventId,
  duplicateConnectorInboxOutcome,
} from "./connector-inbox-outcomes.js";
import { prepareConnectorInboxMediaDelivery } from "./connector-inbox-media.js";
import { isRoutableWhatsAppConversationId } from "./whatsapp-identifiers.js";
import { exactSecurityApproveChallengeId } from "../../core/src/raw-terminal-commands.js";
import { getPairingChallenge } from "../../core/src/security.js";
import { tenantWhatsAppInboundForwardRoute } from "../../core/src/tenant-whatsapp-routing.js";

function clean(value = "") {
  return String(value || "").trim();
}

function attachmentCount(payload = {}) {
  return Array.isArray(payload.attachments) ? payload.attachments.length : 0;
}

function attachmentRevisionId(id = "", payload = {}) {
  const signature = (Array.isArray(payload.attachments) ? payload.attachments : []).map((attachment, index) => ({
    index,
    filename: clean(attachment?.filename || attachment?.name),
    mimetype: clean(attachment?.mimetype || attachment?.type),
    size: Math.max(0, Number(attachment?.size || 0) || 0),
  }));
  const digest = crypto.createHash("sha256").update(JSON.stringify(signature)).digest("hex").slice(0, 16);
  return `${id}:attachments:${digest}`;
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
  const approvalCode = exactSecurityApproveChallengeId(payload.text || payload.body || payload.message || "");
  if (approvalCode) {
    const parentChallenge = await getPairingChallenge(approvalCode, { env }).catch(() => null);
    if (parentChallenge) {
      return {
        target: localInboundTarget(env),
        token: localInboundToken(env),
        route: { routeMode: "parent_security_approval", tenantVmId: "" },
      };
    }
  }
  const tenant = await tenantWhatsAppInboundForwardRoute(payload, env);
  if (tenant?.target) return { target: tenant.target, token: clean(tenant.token), route: tenant };
  return { target: localInboundTarget(env), token: localInboundToken(env), route: null };
}

function securityApprovalResponse(response = {}) {
  const reason = clean(response.skipped || response.event?.ignoredReason || response.error);
  if (response.approvedSecurityChallenge === true) {
    return { approvedSecurityChallenge: true };
  }
  if (reason.startsWith("security_approval_")) {
    return {
      skipped: reason,
      ...(response.event && typeof response.event === "object" ? { event: response.event } : {}),
    };
  }
  return {};
}

export async function deliverConnectorInboxEvent(event = {}, env = process.env, fetchImpl = fetch) {
  const attemptCount = Number(event.attemptCount || 0) + 1;
  try {
    const route = await deliveryTarget(event.payload, env);
    if (!route.target) throw Object.assign(new Error("connector_inbound_target_missing"), { statusCode: 503 });
    const payloadForTarget = await prepareConnectorInboxMediaDelivery(event.payload, route, env, fetchImpl);
    const response = await fetchImpl(route.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
      },
      body: JSON.stringify(payloadForTarget),
      signal: AbortSignal.timeout(Math.max(1000, Number(env.ORKESTR_CONNECTOR_INBOX_DELIVERY_TIMEOUT_MS || 60_000) || 60_000)),
    });
    const payload = await response.json().catch(() => ({}));
    const classified = classifyConnectorInboxDelivery({ response, payload });
    if (classified.state === "failed_retryable") {
      const error = new Error(classified.failureCode || `connector_inbound_http_${response.status}`);
      error.statusCode = response.status;
      error.deliveryClassification = classified;
      error.deliveryPayload = payload;
      throw error;
    }
    return markConnectorInboxEvent(event.id, {
      state: classified.state,
      attemptCount,
      nextAttemptAt: "",
      error: classified.state === "rejected_terminal" ? classified.failureCode : "",
      outcome: classified.outcome,
      httpStatus: classified.status,
      retryable: classified.retryable,
      failureCode: classified.failureCode,
      result: {
        target: route.target,
        routeMode: route.route?.routeMode || "local",
        tenantVmId: route.route?.tenantVmId || "",
        response: payload,
      },
    }, env);
  } catch (error) {
    const classified = error?.deliveryClassification || classifyConnectorInboxDelivery({
      error,
      payload: error?.deliveryPayload || error?.payload || {},
    });
    if (classified.state === "rejected_terminal") {
      return markConnectorInboxEvent(event.id, {
        state: "rejected_terminal",
        attemptCount,
        nextAttemptAt: "",
        error: classified.failureCode,
        outcome: classified.outcome,
        httpStatus: classified.status,
        retryable: false,
        failureCode: classified.failureCode,
        result: error?.deliveryPayload ? { response: error.deliveryPayload } : event.result,
      }, env);
    }
    const terminal = attemptCount >= maxAttempts(env);
    const nextAttemptAt = terminal ? "" : new Date(Date.now() + retryDelayMs(attemptCount, env)).toISOString();
    return markConnectorInboxEvent(event.id, {
      state: terminal ? "dead_letter" : "failed_retryable",
      attemptCount,
      nextAttemptAt,
      error: clean(error?.message) || "connector_inbound_delivery_failed",
      outcome: "retryable_failure",
      httpStatus: classified.status,
      retryable: true,
      failureCode: classified.failureCode,
    }, env);
  }
}

function duplicateInboxResponse(event = {}) {
  const outcome = duplicateConnectorInboxOutcome(event);
  const rejected = outcome === "duplicate_rejected";
  return {
    ok: !rejected,
    duplicate: true,
    rejected,
    outcome,
    state: event.state,
    eventId: event.id,
    attemptCount: event.attemptCount,
    error: rejected ? event.error || event.failureCode || "connector_inbound_rejected" : "",
    failureCode: rejected ? event.failureCode || event.error || "connector_inbound_rejected" : "",
    retryable: false,
    result: event.result,
    ...securityApprovalResponse(event.result?.response || {}),
  };
}

function deliveredInboxResponse(event = {}, { sourceEventId = "", attachmentRecovery = false } = {}) {
  const response = event?.result?.response || {};
  return {
    ok: event?.state === "delivered",
    queued: event?.state === "failed_retryable",
    rejected: event?.state === "rejected_terminal",
    outcome: event?.outcome || "",
    eventId: event?.id || "",
    sourceEventId,
    attachmentRecovery,
    state: event?.state || "unknown",
    attemptCount: event?.attemptCount || 0,
    error: event?.error || "",
    failureCode: event?.failureCode || "",
    retryable: event?.retryable,
    result: event?.result || null,
    ...securityApprovalResponse(response),
  };
}

export async function routeWhatsAppInboundFromWorker(payload = {}, env = process.env, fetchImpl = fetch) {
  const id = clean(payload.eventId || payload.id || payload.messageId);
  const conversationId = clean(payload.chatId || payload.fromChatId);
  if (!isRoutableWhatsAppConversationId(conversationId)) {
    throw Object.assign(new Error("whatsapp_conversation_id_invalid"), { statusCode: 400 });
  }
  let inboxId = id;
  let deliveryPayload = payload;
  let ensured = await ensureConnectorInboxEvent({
    id,
    connector: "whatsapp",
    accountId: payload.accountId,
    conversationId,
    payload,
    replayOfId: payload.connectorInboxReplay?.replayOfEventId,
    replayId: payload.connectorInboxReplay?.replayId,
  }, env);
  if (!ensured.created && ensured.event.state === "rejected_terminal") {
    await markConnectorInboxEvent(ensured.event.id, { outcome: "duplicate_rejected", retryable: false }, env);
    return duplicateInboxResponse({ ...ensured.event, outcome: "duplicate_rejected" });
  }
  const previousAttachmentCount = attachmentCount(ensured.event?.payload);
  const currentAttachmentCount = attachmentCount(payload);
  const stagedForConnectorGateway = payload.attachmentsStagedForConnectorGateway === true;
  if (!ensured.created && (
    currentAttachmentCount > previousAttachmentCount ||
    (currentAttachmentCount > 0 && stagedForConnectorGateway && ensured.event.state === "delivered")
  )) {
    inboxId = attachmentRevisionId(id, payload);
    deliveryPayload = {
      ...payload,
      eventId: inboxId,
      sourceEventId: clean(payload.sourceEventId) || id,
      attachmentRecovery: true,
    };
    if (ensured.event.state !== "delivered") {
      await markConnectorInboxEvent(ensured.event.id, {
        state: "dead_letter",
        nextAttemptAt: "",
        error: `superseded_by_${inboxId}`,
      }, env);
    }
    ensured = await ensureConnectorInboxEvent({
      id: inboxId,
      connector: "whatsapp",
      accountId: payload.accountId,
      conversationId,
      payload: deliveryPayload,
    }, env);
  }
  if (!ensured.created && connectorInboxEventIsTerminal(ensured.event)) {
    await markConnectorInboxEvent(ensured.event.id, { outcome: "duplicate_accepted", retryable: false }, env);
    return duplicateInboxResponse({ ...ensured.event, outcome: "duplicate_accepted" });
  }
  const delivered = await deliverConnectorInboxEvent(ensured.event, env, fetchImpl);
  return deliveredInboxResponse(delivered, { sourceEventId: inboxId === id ? "" : id, attachmentRecovery: inboxId !== id });
}

export async function replayConnectorInboxEvent(sourceEventId = "", options = {}, env = process.env, fetchImpl = fetch) {
  const source = await getConnectorInboxEvent(sourceEventId, env);
  if (!source) throw Object.assign(new Error("connector_inbox_replay_source_missing"), { statusCode: 404 });
  const uncertainDeadLetterAllowed = source.state === "dead_letter" && options.allowUncertainDeadLetter === true;
  if (source.state !== "rejected_terminal" && !uncertainDeadLetterAllowed) {
    throw Object.assign(new Error("connector_inbox_replay_source_not_rejected"), { statusCode: 409 });
  }
  const replayId = clean(options.replayId || options.idempotencyKey);
  const eventId = connectorInboxReplayEventId(source.id, replayId);
  const payload = {
    ...source.payload,
    eventId,
    sourceEventId: source.id,
    connectorInboxReplay: {
      explicit: true,
      replayId,
      replayOfEventId: source.id,
      requestedBy: clean(options.requestedBy || "operator"),
      reason: clean(options.reason || "authorization_corrected"),
    },
  };
  const result = await routeWhatsAppInboundFromWorker(payload, env, fetchImpl);
  return { ...result, explicitReplay: true, replayId, replayOfEventId: source.id };
}

export async function retryConnectorInbox(env = process.env, fetchImpl = fetch) {
  const events = await listConnectorInboxEvents({
    states: ["pending", "failed_retryable"],
    connectors: ["whatsapp"],
    limit: 100,
  }, env);
  const due = events.filter((event) => !event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= Date.now());
  const results = [];
  for (const event of due) results.push(await deliverConnectorInboxEvent(event, env, fetchImpl));
  return { inspected: events.length, attempted: due.length, results };
}
