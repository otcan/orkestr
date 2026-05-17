import fs from "node:fs/promises";
import path from "node:path";
import { enqueueAgentMessage } from "../../core/src/messages.js";
import { enqueueThreadInput, listThreadMessages, listThreads } from "../../core/src/threads.js";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  getLocalWhatsAppBridgeStatus,
  localWhatsAppBridgeBasePath,
  sendLocalWhatsAppText,
} from "./whatsapp-local-bridge.js";

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function fetchOk(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function hasReadySignal(payload) {
  return Boolean(
    payload?.ready ||
      payload?.ok && payload?.state === "ready" ||
      payload?.status === "ready" ||
      payload?.clientReady ||
      payload?.accounts?.some?.((account) => account.ready || account.state === "ready" || account.status === "ready"),
  );
}

function configuredBridgeUrl(config = {}, env = process.env) {
  return String(env.WHATSAPP_BRIDGE_URL || config.bridgeUrl || "").trim().replace(/\/+$/, "");
}

function bridgeMode(config = {}, env = process.env) {
  return String(env.WHATSAPP_BRIDGE_MODE || config.bridgeMode || "local").trim() || "local";
}

function firstAccountError(accounts = []) {
  return accounts.map((account) => account.error).find(Boolean) || "";
}

async function getLocalStatus(env) {
  const health = await getLocalWhatsAppBridgeStatus(env);
  if (hasReadySignal(health)) {
    return {
      state: "paired",
      summary: "Built-in WhatsApp bridge is paired.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: false,
    };
  }
  if (health.qrAvailable) {
    return {
      state: "qr_needed",
      summary: "Built-in WhatsApp bridge is ready for pairing; scan a QR code.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: true,
      qrUrl: health.qrUrl,
    };
  }
  if (health.state === "failed") {
    return {
      state: "unreachable",
      summary: firstAccountError(health.accounts) || "Built-in WhatsApp bridge could not start.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: false,
    };
  }
  if (health.state === "starting") {
    return {
      state: "unpaired",
      summary: "Built-in WhatsApp bridge is starting. QR codes will appear shortly.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: false,
    };
  }
  return {
    state: "unpaired",
    summary: "Start WhatsApp 1 or WhatsApp 2 and scan the QR code.",
    mode: "local",
    bridgeUrl: localWhatsAppBridgeBasePath,
    health,
    accounts: health.accounts,
    qrAvailable: false,
  };
}

export async function getWhatsAppStatus(env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("whatsapp", env);
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl) {
    if (bridgeMode(config, env) === "local") return getLocalStatus(env);
    return {
      state: "not_configured",
      summary: "Configure a WhatsApp bridge or enable the built-in local bridge.",
      bridgeUrl: "",
      health: null,
      qrAvailable: false,
    };
  }
  try {
    const health = await fetchJson(new URL("/health", bridgeUrl), fetchImpl);
    if (!health.ok) {
      return {
        state: "failed",
        summary: `WhatsApp bridge returned HTTP ${health.status}.`,
        bridgeUrl,
        health: health.payload,
        qrAvailable: false,
      };
    }
    if (hasReadySignal(health.payload)) {
      return {
        state: "paired",
        summary: "WhatsApp bridge is reachable and paired.",
        bridgeUrl,
        health: health.payload,
        qrAvailable: false,
      };
    }
    const qrAvailable = await fetchOk(new URL("/qr.svg", bridgeUrl), fetchImpl);
    return {
      state: qrAvailable ? "qr_needed" : "unpaired",
      summary: qrAvailable ? "WhatsApp bridge is reachable; scan the QR code to pair." : "WhatsApp bridge is reachable but not paired.",
      bridgeUrl,
      health: health.payload,
      qrAvailable,
      qrUrl: qrAvailable ? `${bridgeUrl}/qr.svg` : "",
    };
  } catch (error) {
    return {
      state: "unreachable",
      summary: "WhatsApp bridge is unreachable.",
      bridgeUrl,
      health: null,
      qrAvailable: false,
      error: error.message,
    };
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function routeAgentId(input, config) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const routes = config.routes || config.chatRoutes || {};
  return pickString(
    input.agentId,
    input.targetAgentId,
    chatId ? routes[chatId] : "",
    config.defaultAgentId,
  );
}

function routeThreadId(input, config) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const routes = config.threadRoutes || config.threads || {};
  return pickString(
    input.threadId,
    input.targetThreadId,
    chatId ? routes[chatId] : "",
    config.defaultThreadId,
  );
}

async function readWhatsAppState(env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.whatsapp, { inboundEvents: [] });
}

async function writeWhatsAppState(state, env) {
  const paths = dataPaths(env);
  await writeJson(paths.whatsapp, {
    ...state,
    inboundEvents: (state.inboundEvents || []).slice(-500),
    outboundDeliveries: (state.outboundDeliveries || []).slice(-500),
    updatedAt: new Date().toISOString(),
  });
}

export async function routeWhatsAppInbound(input = {}, env = process.env) {
  const config = await readConnectorConfig("whatsapp", env);
  const eventId = pickString(input.eventId, input.id, input.messageId);
  if (!eventId) throw badRequest("whatsapp_event_id_required");

  const state = await readWhatsAppState(env);
  const existing = (state.inboundEvents || []).find((event) => event.eventId === eventId);
  if (existing) {
    await appendEvent({ type: "whatsapp_inbound_duplicate", eventId, agentId: existing.agentId || null, threadId: existing.threadId || null, messageId: existing.messageId }, env);
    return {
      duplicate: true,
      event: existing,
      agentId: existing.agentId || null,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
    };
  }

  const threadId = routeThreadId(input, config);
  const agentId = threadId ? "" : routeAgentId(input, config);
  if (!threadId && !agentId) throw badRequest("whatsapp_target_required");

  const text = pickString(input.text, input.body, input.message);
  const promptFile = pickString(input.promptFile);
  if (!text && !promptFile) throw badRequest("message_text_required");

  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const from = pickString(input.from, input.sender, input.author);
  const accountId = pickString(input.accountId);
  const messageInput = {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    externalId: eventId,
    chatId,
    from,
    accountId,
    text,
    promptFile,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
  };
  const message = threadId
    ? await enqueueThreadInput(threadId, messageInput, env)
    : await enqueueAgentMessage(agentId, messageInput, env);
  const event = {
    eventId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    from,
    receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeWhatsAppState(state, env);
  await appendEvent({ type: "whatsapp_inbound_routed", eventId, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
  return {
    duplicate: false,
    event,
    agentId: agentId || null,
    threadId: threadId || null,
    message,
  };
}

async function listMessageSets(env) {
  const paths = await ensureDataDirs(env);
  const files = await fs.readdir(paths.messages).catch(() => []);
  const sets = [];
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const agentId = path.basename(file, ".json");
    const messages = await readJson(path.join(paths.messages, file), []);
    if (Array.isArray(messages)) sets.push({ agentId, messages });
  }
  return sets;
}

async function listThreadMessageSets(env) {
  const sets = [];
  for (const thread of await listThreads(env)) {
    const messages = await listThreadMessages(thread.id, env);
    if (Array.isArray(messages)) sets.push({ threadId: thread.id, messages });
  }
  return sets;
}

async function sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl }) {
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl && bridgeMode(config, env) === "local") {
    return sendLocalWhatsAppText({ chatId, text, accountId, env });
  }
  if (!bridgeUrl) throw badRequest("whatsapp_bridge_not_configured");
  const apiToken = pickString(env.WHATSAPP_BRIDGE_TOKEN, env.WA_HTTP_TOKEN, config.apiToken);
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const response = await fetchImpl(new URL("/send-text", bridgeUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: chatId,
      text,
      ...(accountId ? { accountId } : {}),
    }),
    signal: AbortSignal.timeout(Number(env.WHATSAPP_SEND_TIMEOUT_MS || 10_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `whatsapp_send_failed_${response.status}`);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function deliverWhatsAppReplies(env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("whatsapp", env);
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl && bridgeMode(config, env) !== "local") {
    return { delivered: [], skipped: [], failed: [], status: "not_configured" };
  }
  const state = await readWhatsAppState(env);
  const deliveredIds = new Set((state.outboundDeliveries || []).map((delivery) => delivery.messageId));
  const outboundDeliveries = [...(state.outboundDeliveries || [])];
  const delivered = [];
  const skipped = [];
  const failed = [];

  const messageSets = [
    ...(await listMessageSets(env)).map((set) => ({ ...set, kind: "agent" })),
    ...(await listThreadMessageSets(env)).map((set) => ({ ...set, kind: "thread" })),
  ];
  for (const { agentId, threadId, messages, kind } of messageSets) {
    for (const message of messages) {
      if (message.role !== "assistant" || message.state !== "completed" || deliveredIds.has(message.id)) continue;
      const parent = messages.find((entry) => entry.id === message.parentMessageId);
      const whatsappOrigin = parent?.connector === "whatsapp" || parent?.source === "whatsapp_inbound" || message.connector === "whatsapp";
      if (!whatsappOrigin) continue;

      const chatId = pickString(message.chatId, parent?.chatId);
      const text = pickString(message.text);
      const accountId = pickString(message.accountId, parent?.accountId);
      if (!chatId || !text) {
        skipped.push({ agentId, messageId: message.id, reason: !chatId ? "missing_chat_id" : "missing_text" });
        continue;
      }

      try {
        const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
        const delivery = {
          kind,
          agentId: agentId || null,
          threadId: threadId || null,
          messageId: message.id,
          parentMessageId: message.parentMessageId,
          chatId,
          accountId,
          deliveredAt: new Date().toISOString(),
          bridgeResponse: payload,
        };
        outboundDeliveries.push(delivery);
        deliveredIds.add(message.id);
        delivered.push(delivery);
        await appendEvent({ type: "whatsapp_outbound_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
      } catch (error) {
        const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
        failed.push(failure);
        await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
      }
    }
  }

  if (delivered.length) {
    state.outboundDeliveries = outboundDeliveries;
    await writeWhatsAppState(state, env);
  }
  return { delivered, skipped, failed };
}
