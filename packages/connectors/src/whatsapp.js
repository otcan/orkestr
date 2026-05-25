import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { enqueueAgentMessage, updateAgentMessage } from "../../core/src/messages.js";
import { runtimeStatus } from "../../core/src/runtime-leases.js";
import { parseThreadInputCommand } from "../../core/src/thread-commands.js";
import { enqueueThreadInput, listThreadMessages, listThreads, updateThreadMessage } from "../../core/src/threads.js";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  getLocalWhatsAppBridgeStatus,
  localWhatsAppBridgeBasePath,
  listLocalWhatsAppChatParticipants,
  sendLocalWhatsAppText,
  syncLocalWhatsAppTypingTargets,
} from "./whatsapp-local-bridge.js";
import { routerUpdateWhatsAppDeliveryTarget } from "./whatsapp-router-updates.js";

let whatsappDeliveryInFlight = null;

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
  if (bridgeMode(config, env) !== "external") return "";
  return String(env.WHATSAPP_BRIDGE_URL || config.bridgeUrl || "").trim().replace(/\/+$/, "");
}

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function externalBridgeEnabled(env = process.env) {
  return String(env.WHATSAPP_BRIDGE_MODE || "").trim().toLowerCase() === "external" ||
    truthyEnv(env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED) ||
    truthyEnv(env.WHATSAPP_EXTERNAL_BRIDGE_ENABLED);
}

function bridgeMode(config = {}, env = process.env) {
  const mode = String(env.WHATSAPP_BRIDGE_MODE || config.bridgeMode || "local").trim().toLowerCase();
  return mode === "external" && externalBridgeEnabled(env) ? "external" : "local";
}

function firstAccountError(accounts = []) {
  return accounts.map((account) => account.error).find(Boolean) || "";
}

async function externalBridgeAccounts(bridgeUrl, healthPayload, fetchImpl) {
  if (Array.isArray(healthPayload?.accounts)) return healthPayload.accounts;
  try {
    const dashboard = await fetchJson(new URL("/api/dashboard", bridgeUrl), fetchImpl);
    if (dashboard.ok && Array.isArray(dashboard.accounts)) return dashboard.accounts;
    if (dashboard.ok && Array.isArray(dashboard.payload?.accounts)) return dashboard.payload.accounts;
  } catch {
    // Older bridges only expose /health; account discovery stays best-effort.
  }
  return [];
}

function normalizeParticipant(participant = {}) {
  const id = pickString(participant.id?._serialized, participant.id, participant.user, participant.phoneNumber);
  return {
    id,
    name: pickString(
      participant.name,
      participant.pushname,
      participant.shortName,
      participant.label,
      participant.savedName,
      participant.contactName,
      participant.displayName,
      participant.notifyName,
      participant.verifiedName,
    ),
    isAdmin: Boolean(participant.isAdmin),
    isSuperAdmin: Boolean(participant.isSuperAdmin),
  };
}

function normalizeParticipants(payload = {}) {
  const participants = Array.isArray(payload.participants)
    ? payload.participants
    : Array.isArray(payload.groupMetadata?.participants)
      ? payload.groupMetadata.participants
      : Array.isArray(payload.chat?.participants)
        ? payload.chat.participants
        : [];
  return participants.map(normalizeParticipant).filter((participant) => participant.id);
}

export function mapLocalWhatsAppStatusFromHealth(health) {
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
  if (health.state === "pairing_code") {
    const codeAccount = health.accounts.find((account) => account.pairingCode);
    return {
      state: "pairing_code",
      summary: "Built-in WhatsApp bridge generated a phone pairing code.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: false,
      pairingCode: codeAccount?.pairingCode || "",
      pairingCodeUpdatedAt: codeAccount?.pairingCodeUpdatedAt || null,
    };
  }
  if (health.state === "authenticated") {
    return {
      state: "authenticating",
      summary: "Built-in WhatsApp bridge is authenticated and waiting for WhatsApp Web to become ready.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health,
      accounts: health.accounts,
      qrAvailable: false,
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

async function getLocalStatus(env) {
  const health = await getLocalWhatsAppBridgeStatus(env);
  return mapLocalWhatsAppStatusFromHealth(health);
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
      const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl);
      return {
        state: "paired",
        summary: "WhatsApp bridge is reachable and paired.",
        bridgeUrl,
        health: health.payload,
        accounts,
        qrAvailable: false,
      };
    }
    const qrAvailable = await fetchOk(new URL("/qr.svg", bridgeUrl), fetchImpl);
    const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl);
    return {
      state: qrAvailable ? "qr_needed" : "unpaired",
      summary: qrAvailable ? "WhatsApp bridge is reachable; scan the QR code to pair." : "WhatsApp bridge is reachable but not paired.",
      bridgeUrl,
      health: health.payload,
      accounts,
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

export async function getWhatsAppChatParticipants({ accountId = "", chatId = "" } = {}, env = process.env, fetchImpl = fetch) {
  const id = pickString(chatId);
  if (!id) throw badRequest("whatsapp_chat_id_required");
  const config = await readConnectorConfig("whatsapp", env);
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl && bridgeMode(config, env) === "local") {
    return listLocalWhatsAppChatParticipants({ accountId, chatId: id, env });
  }
  if (!bridgeUrl) {
    return { accountId, chatId: id, ready: false, participants: [] };
  }
  const response = await fetchImpl(new URL(`/api/chats/${encodeURIComponent(id)}/meta`, bridgeUrl), {
    signal: AbortSignal.timeout(Number(env.WHATSAPP_PARTICIPANTS_TIMEOUT_MS || 5000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `whatsapp_chat_participants_failed_${response.status}`);
    error.statusCode = response.status || 502;
    throw error;
  }
  return {
    accountId,
    chatId: id,
    ready: true,
    isGroup: Boolean(payload?.isGroup),
    participants: normalizeParticipants(payload),
  };
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

const proposedPlanOpenTagPattern = /^\s*<\s*proposed[\s_-]*plan\s*>\s*/i;
const proposedPlanCloseTagPattern = /\s*<\s*\/\s*proposed[\s_-]*plan\s*>\s*$/i;

function proposedPlanEnvelopeBody(value) {
  const text = String(value || "");
  if (!proposedPlanOpenTagPattern.test(text)) return null;
  return text.replace(proposedPlanOpenTagPattern, "").replace(proposedPlanCloseTagPattern, "").trim();
}

function hasProposedPlanEnvelope(value) {
  return proposedPlanEnvelopeBody(value) !== null;
}

function stripProposedPlanEnvelope(value) {
  return proposedPlanEnvelopeBody(value) ?? String(value || "");
}

function comparableParticipantId(value) {
  return pickString(value).toLowerCase();
}

function participantIdSet(values = []) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(comparableParticipantId).filter(Boolean));
}

function isWhatsAppGroupChatId(value) {
  return /@g\.us$/i.test(pickString(value));
}

function generatedSingleAccountGroupBindingCanTrustGroupBoundary(binding = {}, chatId = "", from = "") {
  const senderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
  const responderAccountId = pickString(binding.responderAccountId, binding.outboundAccountId);
  if (!binding.generated || !isWhatsAppGroupChatId(chatId) || !senderAccountId || senderAccountId !== responderAccountId) return false;
  const senderContactId = pickString(binding.senderContactId);
  const responderContactId = pickString(binding.responderContactId);
  if (!senderContactId || !responderContactId || !from) return false;
  return comparableParticipantId(from) !== comparableParticipantId(responderContactId);
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

function bindingAccountIds(binding = {}) {
  return new Set([
    pickString(binding.senderAccountId, binding.inboundAccountId),
    pickString(binding.responderAccountId, binding.outboundAccountId),
  ].filter(Boolean));
}

async function routeThread(input, config, env) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId);
  const from = pickString(input.from, input.sender, input.author);
  const fromMe = input.fromMe === true || input.from_me === true || String(input.fromMe || input.from_me || "").toLowerCase() === "true";
  const routes = config.threadRoutes || config.threads || {};
  const explicit = pickString(
    input.threadId,
    input.targetThreadId,
    chatId ? routes[chatId] : "",
    config.defaultThreadId,
  );
  if (explicit) return { threadId: explicit, binding: null };
  if (!chatId) return { threadId: "", binding: null };
  const threads = await listThreads(env);
  const thread = threads.find((item) => {
    const binding = item?.binding || {};
    const senderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
    const senderContactId = pickString(binding.senderContactId);
    const responderContactId = pickString(binding.responderContactId);
    if (senderAccountId) {
      if (accountId && !bindingAccountIds(binding).has(accountId)) return false;
      if (!fromMe) {
        if (responderContactId && comparableParticipantId(from) === comparableParticipantId(responderContactId)) return false;
        const senderContactMatches = senderContactId && comparableParticipantId(from) === comparableParticipantId(senderContactId);
        const trustGroupBoundary = generatedSingleAccountGroupBindingCanTrustGroupBoundary(binding, chatId, from);
        if (!senderContactMatches && !trustGroupBoundary) {
          const additionalParticipantsEnabled = binding.additionalParticipantsEnabled === true || binding.allowOtherPeopleConfirmed === true;
          if (!additionalParticipantsEnabled) return false;
          if (!participantIdSet(binding.additionalParticipantIds).has(comparableParticipantId(from))) return false;
        }
      }
    }
    return binding.enabled !== false &&
      String(binding.connector || "whatsapp") === "whatsapp" &&
      String(binding.chatId || "").trim() === chatId;
  });
  return thread ? { threadId: thread.id, binding: thread.binding || null } : { threadId: "", binding: null };
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

  const threadRoute = await routeThread(input, config, env);
  const threadId = threadRoute.threadId;
  const agentId = threadId ? "" : routeAgentId(input, config);
  if (!threadId && !agentId) throw badRequest("whatsapp_target_required");

  const text = pickString(input.text, input.body, input.message);
  const promptFile = pickString(input.promptFile);
  if (!text && !promptFile) throw badRequest("message_text_required");

  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const from = pickString(input.from, input.sender, input.author);
  const accountId = pickString(input.accountId, threadRoute.binding?.outboundAccountId);
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
  let message = threadId
    ? await enqueueThreadInput(threadId, messageInput, env)
    : await enqueueAgentMessage(agentId, messageInput, env);
  const contentDuplicate = Boolean(message.duplicate);
  if (threadId && !contentDuplicate) {
    message = await annotateInitialThreadQueueNotice(threadId, message, env);
  }
  const event = {
    eventId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    from,
    accountId,
    receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
  if (contentDuplicate) event.duplicateReason = message.duplicateReason || "active_input";
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeWhatsAppState(state, env);
  await appendEvent({
    type: contentDuplicate ? "whatsapp_inbound_duplicate" : "whatsapp_inbound_routed",
    eventId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    duplicateReason: contentDuplicate ? event.duplicateReason : "",
  }, env);
  return {
    duplicate: contentDuplicate,
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
    if (Array.isArray(messages)) sets.push({ threadId: thread.id, thread, messages });
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

function normalizedDeliveryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatMarkdownLinksForWhatsApp(value) {
  return String(value || "").replace(/\[([^\]\n]{1,180})\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const cleanLabel = String(label || "").trim();
    const cleanUrl = String(url || "").trim();
    return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel}: ${cleanUrl}` : cleanUrl;
  });
}

function formatMarkdownBoldForWhatsApp(value) {
  const text = String(value || "");
  let formatted = "";
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf("**", index);
    if (start === -1) {
      formatted += text.slice(index);
      break;
    }

    const end = text.indexOf("**", start + 2);
    if (end === -1) {
      formatted += text.slice(index);
      break;
    }

    const body = text.slice(start + 2, end);
    formatted += text.slice(index, start);
    formatted += body.trim() ? `*${body}*` : `**${body}**`;
    index = end + 2;
  }

  return formatted;
}

function formatWhatsAppLine(value) {
  const heading = String(value || "").match(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/);
  const line = heading ? `${heading[1]}${heading[2]}` : String(value || "");
  const chunks = line.split(/(`[^`]*`)/g);
  return chunks
    .map((chunk) => {
      if (chunk.startsWith("`") && chunk.endsWith("`")) return chunk;
      return formatMarkdownBoldForWhatsApp(formatMarkdownLinksForWhatsApp(chunk));
    })
    .join("");
}

export function formatWhatsAppOutboundText(value) {
  const lines = stripProposedPlanEnvelope(value).replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  const formatted = lines.map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : formatWhatsAppLine(line);
  });
  return formatted.join("\n").trim();
}

function footerEnabled(env = process.env) {
  const value = String(env.ORKESTR_WHATSAPP_DEBUG_FOOTER ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function shortReasoningEffort(value) {
  const effort = pickString(value).toLowerCase();
  if (!effort) return "";
  if (effort === "xhigh" || effort === "extra-high" || effort === "extra_high") return "xh";
  if (effort === "high") return "h";
  if (effort === "medium") return "m";
  if (effort === "low") return "l";
  return effort.replace(/\s+/g, "-").slice(0, 8);
}

function codexModelDebugLabel(message = {}, thread = {}, env = process.env) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const model = pickString(
    message.codexModel,
    message.model,
    thread.codexModel,
    metadata.codexModel,
    env.ORKESTR_DEFAULT_CODEX_MODEL,
    env.OPENAI_MODEL,
    "unknown",
  );
  const effort = shortReasoningEffort(
    pickString(
      message.codexReasoningEffort,
      message.reasoningEffort,
      thread.codexReasoningEffort,
      metadata.codexReasoningEffort,
      env.ORKESTR_DEFAULT_CODEX_REASONING,
      env.OPENAI_REASONING_EFFORT,
    ),
  );
  return effort ? `${model}/${effort}` : model;
}

function codexModeDebugValue(message = {}, thread = {}) {
  const mode = pickString(
    message.codexModeLive,
    thread.codexModeLive,
    thread.runtime?.progress?.codexMode,
    thread.runtime?.codexMode,
    thread.codexModeSource === "runtime-pane" ? thread.codexMode : "",
  ).toLowerCase();
  return mode === "plan" ? "plan" : "";
}

function queueDebugCount(messages = [], currentMessage = null) {
  const activeMessageId = pickString(currentMessage?.id);
  const activeParentId = pickString(currentMessage?.parentMessageId);
  return messages.filter((message) => {
    if (activeMessageId && message?.id === activeMessageId) return false;
    if (activeParentId && message?.id === activeParentId) return false;
    if (String(message?.role || "").toLowerCase() !== "user") return false;
    const state = String(message?.state || "").toLowerCase();
    const deliveryState = String(message?.deliveryState || "").toLowerCase();
    return ["queued", "pending_delivery"].includes(state) ||
      ["blocked_frozen_runtime", "waiting_runtime_ready", "waiting_runtime_start", "retrying_delivery"].includes(deliveryState);
  }).length;
}

function cpuDebugPercent() {
  const cpuCount = os.cpus().length || 1;
  const percent = Math.round(((os.loadavg()[0] || 0) / cpuCount) * 100);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(999, percent));
}

function shouldAppendWhatsAppDebugFooter(message = {}, env = process.env, deliveryType = "") {
  if (!footerEnabled(env)) return false;
  if (message.source === "codex-rollout" || message.source === "orkestr_runtime") return true;
  return ["delivery_error", "mode_queued", "queue_notice", "router_update"].includes(String(deliveryType || "").trim());
}

function footerMessageType(deliveryType = "") {
  return ["progress", "queue_notice", "mode_queued", "delivery_error", "router_update"].includes(String(deliveryType || "").trim())
    ? "update"
    : "final";
}

function whatsappDebugFooter({ message = {}, thread = {}, messages = [], deliveryType = "final", env = process.env } = {}) {
  const mode = codexModeDebugValue(message, thread);
  const parts = [
    `m:${codexModelDebugLabel(message, thread, env)}`,
    ...(mode ? [`mode:${mode}`] : []),
    `msg:${footerMessageType(deliveryType)}`,
    `q:${queueDebugCount(messages, message)}`,
    `cpu:${cpuDebugPercent()}%`,
    "help:/help",
    ...(mode === "plan" ? ["switch:/code"] : []),
  ];
  return `dbg: ${parts.join(" · ")}`;
}

function appendWhatsAppDebugFooter(text, options = {}) {
  const cleanText = String(text || "").trim();
  if (!cleanText || !shouldAppendWhatsAppDebugFooter(options.message, options.env, options.deliveryType)) return cleanText;
  return `${cleanText}\n\n${whatsappDebugFooter(options)}`;
}

function deliveryTextKey(chatId, text) {
  return crypto
    .createHash("sha256")
    .update(`${String(chatId || "").trim()}\n${normalizedDeliveryText(text)}`)
    .digest("hex");
}

function shouldMirrorWhatsAppReply(message) {
  if (message.source === "codex-rollout") {
    const phase = String(message.phase || "final_answer").trim();
    if (phase === "plan" || hasProposedPlanEnvelope(message.text)) return false;
    return !phase || ["final_answer", "need_input", "awaiting_input", "question", "request_user_input"].includes(phase);
  }
  return true;
}

function shouldMirrorWhatsAppProgress(message) {
  if (message.source !== "codex-rollout") return false;
  const phase = String(message.phase || "").trim().toLowerCase();
  return phase === "commentary" && !hasProposedPlanEnvelope(message.text) && Boolean(pickString(message.text));
}

function progressMirrorIntervalMs(env = process.env) {
  const value = Number(env.ORKESTR_WHATSAPP_PROGRESS_MIN_INTERVAL_MS || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function latestProgressReplyForParent(messages, parentId) {
  return [...messages]
    .reverse()
    .find((candidate) =>
      candidate.role === "assistant" &&
      candidate.state === "completed" &&
      candidate.parentMessageId === parentId &&
      shouldMirrorWhatsAppProgress(candidate)
    ) || null;
}

function completedFinalReplyForParent(messages, parentId) {
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    candidate.parentMessageId === parentId &&
    shouldMirrorWhatsAppReply(candidate)
  ) || null;
}

function messageTimeMs(message = {}) {
  const ms = Date.parse(String(message.timestamp || message.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function completedFinalReplyForTypingParent(messages = [], parent = null, chatId = "") {
  if (!parent) return null;
  const direct = completedFinalReplyForParent(messages, parent.id);
  if (direct) return direct;
  const parentMs = messageTimeMs(parent);
  if (!parentMs) return null;
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    shouldMirrorWhatsAppReply(candidate) &&
    messageTimeMs(candidate) >= parentMs &&
    (!chatId || !candidate.chatId || candidate.chatId === chatId)
  ) || null;
}

function whatsappTypingCooldownMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS || env.WHATSAPP_TYPING_COOLDOWN_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 10_000;
}

function latestOutboundDeliveryForTypingParent(state = null, parent = null, chatId = "") {
  if (!parent || !chatId) return null;
  const parentMs = messageTimeMs(parent);
  return [...(state?.outboundDeliveries || [])]
    .reverse()
    .find((delivery) => {
      if (delivery.chatId !== chatId) return false;
      if (parent.id && delivery.parentMessageId === parent.id) return true;
      const deliveredMs = Date.parse(String(delivery.deliveredAt || ""));
      return Number.isFinite(deliveredMs) && (!parentMs || deliveredMs >= parentMs);
    }) || null;
}

function typingCooldownActive(state = null, parent = null, chatId = "", env = process.env) {
  const cooldownMs = whatsappTypingCooldownMs(env);
  if (!cooldownMs) return false;
  const delivery = latestOutboundDeliveryForTypingParent(state, parent, chatId);
  const deliveredMs = Date.parse(String(delivery?.deliveredAt || ""));
  return Number.isFinite(deliveredMs) && Date.now() - deliveredMs < cooldownMs;
}

function latestProgressDelivery(outboundDeliveries, parentMessageId, chatId) {
  return [...(outboundDeliveries || [])]
    .reverse()
    .find((delivery) =>
      delivery.deliveryType === "progress" &&
      delivery.parentMessageId === parentMessageId &&
      (!chatId || delivery.chatId === chatId)
    ) || null;
}

function threadAllowsWhatsAppMirroring(thread) {
  if (!thread?.binding) return true;
  return thread.binding.mirrorToWhatsApp !== false && thread.binding.mirrorReplies !== false;
}

function whatsappMessageOrigin(message, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
}

function initialQueueDeliveryState(status = null, message = null) {
  const parsed = parseThreadInputCommand({ text: message?.text || "" });
  if (parsed.command === "interrupt") return "interrupting";
  if (!status) return "";
  const state = String(status.state || "").trim().toLowerCase();
  if (state === "working") return "awaiting_runtime_completion";
  if (state === "waking" || state === "sleeping" || !status.sessionName) return "waiting_runtime_start";
  if (status.promptReady === false) return "waiting_runtime_ready";
  return "";
}

async function annotateInitialThreadQueueNotice(threadId, message, env = process.env) {
  if (!threadId || !message?.id || message.duplicate) return message;
  const deliveryState = initialQueueDeliveryState(await runtimeStatus(threadId, env).catch(() => null), message);
  if (!deliveryState) return message;
  return updateThreadMessage(threadId, message.id, { deliveryState }, env).catch(() => message);
}

function runtimeTypingActive(status = null) {
  if (!status) return false;
  const state = String(status.state || status.status || "").trim().toLowerCase();
  return status.typingActive === true ||
    status.foregroundWorking === true ||
    status.working === true ||
    status.backgroundWork === true ||
    state === "working" ||
    state === "running";
}

function latestWhatsAppTypingParent(messages = [], thread = null, state = null) {
  return [...messages].reverse().find((message) => {
    if (String(message?.role || "").trim().toLowerCase() !== "user") return false;
    if (!whatsappMessageOrigin(message, state)) return false;
    const chatId = pickString(message.chatId, thread?.binding?.chatId);
    if (!chatId) return false;
    const messageState = String(message.state || "").trim().toLowerCase();
    if (messageState === "failed") return false;
    if (completedFinalReplyForTypingParent(messages, message, chatId)) return false;
    return true;
  }) || null;
}

function whatsappTypingTargetForThread({ thread, messages = [], status = null, state = null, env = process.env } = {}) {
  if (!threadAllowsWhatsAppMirroring(thread)) return null;
  if (!runtimeTypingActive(status)) return null;
  const parent = latestWhatsAppTypingParent(messages, thread, state);
  if (!parent) return null;
  const chatId = pickString(parent.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  if (typingCooldownActive(state, parent, chatId, env)) return null;
  return {
    threadId: thread?.id || null,
    messageId: parent.id || null,
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      parent.accountId,
    ),
  };
}

function passiveMirrorCanCompleteParent(parent, reply, chatId, state = null) {
  if (!parent || parent.role !== "user" || !whatsappMessageOrigin(parent, state)) return false;
  const parentState = String(parent.state || "").trim().toLowerCase();
  const parentDeliveryState = String(parent.deliveryState || "").trim().toLowerCase();
  const recoverableStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running", "failed"]);
  const recoverableDeliveryStates = new Set([
    "awaiting_ack",
    "awaiting_ack_unobserved",
    "awaiting_runtime_completion",
    "blocked_frozen_runtime",
    "delivering",
    "failed",
    "recovering_stale_ack",
    "retrying_delivery",
    "waiting_runtime_ready",
    "waiting_runtime_start",
    "waking",
  ]);
  if (!recoverableStates.has(parentState) && !recoverableDeliveryStates.has(parentDeliveryState)) return false;
  const parentChatId = pickString(parent.chatId, reply?.chatId);
  const replyChatId = pickString(chatId, reply?.chatId, parent.chatId);
  return !parentChatId || !replyChatId || parentChatId === replyChatId;
}

function completedAssistantReplyForParent(messages, parent, chatId, state = null) {
  if (!parent?.id) return null;
  return messages.find((candidate) =>
    candidate.role === "assistant" &&
    candidate.state === "completed" &&
    candidate.parentMessageId === parent.id &&
    shouldMirrorWhatsAppReply(candidate) &&
    passiveMirrorCanCompleteParent(parent, candidate, chatId, state)
  ) || null;
}

async function completePassiveMirrorParent({ kind, agentId, threadId, parent, reply, chatId, delivery = null, state, env }) {
  if (!passiveMirrorCanCompleteParent(parent, reply, chatId, state)) return null;
  const previousState = parent.state || null;
  const previousDeliveryState = parent.deliveryState || null;
  const patch = {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: delivery?.deliveredAt || new Date().toISOString(),
    observedVia: "whatsapp_passive_mirror_delivery",
    passiveMirrorMessageId: reply?.id || null,
    error: null,
  };
  const updated = kind === "thread"
    ? await updateThreadMessage(threadId, parent.id, patch, env)
    : await updateAgentMessage(agentId, parent.id, patch, env);
  Object.assign(parent, updated);
  await appendEvent({
    type: "whatsapp_passive_mirror_parent_completed",
    kind,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: parent.id,
    replyMessageId: reply?.id || null,
    chatId: pickString(chatId, reply?.chatId, parent.chatId),
    previousState,
    previousDeliveryState,
  }, env).catch(() => {});
  return updated;
}

async function recoverParentsForAlreadyMirroredReplies(messageSets, deliveredIds, outboundDeliveries, state, env) {
  const deliveriesByMessageId = new Map((outboundDeliveries || [])
    .filter((delivery) => delivery?.messageId)
    .map((delivery) => [delivery.messageId, delivery]));
  for (const { agentId, threadId, messages, kind } of messageSets) {
    for (const reply of messages) {
      if (reply.role !== "assistant" || reply.state !== "completed" || !deliveredIds.has(reply.id)) continue;
      if (!shouldMirrorWhatsAppReply(reply)) continue;
      const parent = messages.find((entry) => entry.id === reply.parentMessageId);
      if (!parent) continue;
      const delivery = deliveriesByMessageId.get(reply.id) || null;
      await completePassiveMirrorParent({
        kind,
        agentId,
        threadId,
        parent,
        reply,
        chatId: pickString(reply.chatId, parent.chatId, delivery?.chatId),
        delivery,
        state,
        env,
      }).catch(() => null);
    }
  }
}

function failedWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const observedVia = String(message?.observedVia || "").trim().toLowerCase();
  if (role !== "user" || (messageState !== "failed" && deliveryState !== "failed")) return null;
  if (observedVia === "stale_ack_recovery_exhausted") return null;
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

function formatWhatsAppDeliveryFailure(message) {
  const reason = pickString(message.error, message.deliveryError, "Orkestr could not confirm this message reached Codex.")
    .replace(/\s+/g, " ")
    .slice(0, 600)
    .trim();
  return [
    "Delivery failed",
    "",
    "Your message could not be delivered to Codex.",
    `Reason: ${reason || "Unknown error."}`,
  ].join("\n");
}

function whatsappQueueNoticeOrigin(message, thread, state) {
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

function queuedInputWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  if (role !== "user") return null;
  if (!["queued", "pending_delivery"].includes(messageState)) return null;
  if (![
    "awaiting_runtime_completion",
    "interrupting",
    "recovering_stale_ack",
    "retrying_delivery",
    "waiting_runtime_ready",
    "waiting_runtime_start",
    "waking",
  ].includes(deliveryState)) return null;
  const target = whatsappQueueNoticeOrigin(message, thread, state);
  return target ? { ...target, reason: deliveryState || messageState } : null;
}

function queueNoticePreview(message) {
  const text = pickString(message?.text, message?.promptFile ? "message from prompt file" : "message");
  const parsed = parseThreadInputCommand({ text });
  const previewText = parsed.command === "interrupt" && parsed.text ? parsed.text : text;
  const normalized = previewText.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function formatWhatsAppQueueNotice(message, reason = "") {
  const preview = queueNoticePreview(message);
  const normalizedReason = String(reason || "").trim().toLowerCase();
  if (["waiting_runtime_start", "waking"].includes(normalizedReason)) {
    return `Waking this Orkestr thread and queued your message: "${preview}". It will be delivered automatically once the Codex session is awake.`;
  }
  if (normalizedReason === "awaiting_runtime_completion") {
    return `Queued your latest message while current work is still running: "${preview}". It will be delivered automatically when Codex is ready.`;
  }
  if (normalizedReason === "interrupting") {
    return `Interrupting Codex and queued your message: "${preview}". It will be delivered automatically when the prompt is ready.`;
  }
  if (["recovering_stale_ack", "retrying_delivery"].includes(normalizedReason)) {
    return `Queued your latest message while Orkestr recovers this thread: "${preview}". It will be delivered automatically when the thread is prompt-ready.`;
  }
  return `Queued your message while Orkestr prepares this thread: "${preview}". It will be delivered automatically when the Codex session is prompt-ready.`;
}

function queuedModeWhatsAppDeliveryTarget(message, thread, state) {
  const role = String(message?.role || "").trim().toLowerCase();
  const messageState = String(message?.state || "").trim().toLowerCase();
  const deliveryState = String(message?.deliveryState || "").trim().toLowerCase();
  const mode = String(message?.text || "").trim().match(/^\/(code|coding|plan|planning)\b/i)?.[1]?.toLowerCase();
  if (role !== "user" || messageState !== "queued" || deliveryState !== "waiting_runtime_ready" || !mode) return null;
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  const whatsappOrigin =
    message.connector === "whatsapp" ||
    message.source === "whatsapp_inbound" ||
    Boolean(inboundEvent);
  if (!whatsappOrigin) return null;
  const chatId = pickString(message.chatId, inboundEvent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  return {
    mode: mode === "coding" ? "code" : mode === "planning" ? "plan" : mode,
    chatId,
    accountId: pickString(
      thread?.binding?.responderAccountId,
      thread?.binding?.outboundAccountId,
      message.accountId,
      inboundEvent?.accountId,
    ),
  };
}

function formatWhatsAppModeQueued(mode) {
  return `Mode switch queued. Orkestr will switch to ${mode} when Codex is ready.`;
}

export async function syncWhatsAppTypingIndicators(env = process.env, options = {}) {
  const config = await readConnectorConfig("whatsapp", env);
  if (bridgeMode(config, env) !== "local") return { ok: true, active: 0, skipped: "external_bridge" };
  const state = await readWhatsAppState(env);
  const statusImpl = options.statusImpl || runtimeStatus;
  const syncImpl = options.syncImpl || syncLocalWhatsAppTypingTargets;
  const targets = [];
  for (const { threadId, thread, messages } of await listThreadMessageSets(env)) {
    const status = await statusImpl(threadId, env, messages).catch(() => null);
    const target = whatsappTypingTargetForThread({ thread, messages, status, state, env });
    if (target) targets.push(target);
  }
  return syncImpl(targets, env);
}

async function deliverWhatsAppRepliesOnce(env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("whatsapp", env);
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl && bridgeMode(config, env) !== "local") {
    return { delivered: [], skipped: [], failed: [], status: "not_configured" };
  }
  const state = await readWhatsAppState(env);
  const deliveredIds = new Set((state.outboundDeliveries || []).map((delivery) => delivery.messageId));
  const deliveredTextKeys = new Set((state.outboundDeliveries || []).map((delivery) => delivery.textKey).filter(Boolean));
  const batchTextKeys = new Set();
  const outboundDeliveries = [...(state.outboundDeliveries || [])];
  const delivered = [];
  const skipped = [];
  const failed = [];

  const messageSets = [
    ...(await listMessageSets(env)).map((set) => ({ ...set, kind: "agent" })),
    ...(await listThreadMessageSets(env)).map((set) => ({ ...set, kind: "thread" })),
  ];
  await recoverParentsForAlreadyMirroredReplies(messageSets, deliveredIds, outboundDeliveries, state, env);
  for (const { agentId, threadId, thread, messages, kind } of messageSets) {
    for (const message of messages) {
      const routerUpdateTarget = routerUpdateWhatsAppDeliveryTarget({
        message,
        thread,
        state,
        kind,
        mirroringAllowed: kind !== "thread" || threadAllowsWhatsAppMirroring(thread),
      });
      if (routerUpdateTarget) {
        const deliveryId = `${message.id}:${routerUpdateTarget.routerUpdateType}`;
        if (deliveredIds.has(deliveryId)) continue;
        const chatId = routerUpdateTarget.chatId;
        if (
          routerUpdateTarget.skipIfAssistantOutput &&
          (completedAssistantReplyForParent(messages, message, chatId, state) || latestProgressReplyForParent(messages, message.id))
        ) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "assistant_output_available" });
          continue;
        }
        const text = appendWhatsAppDebugFooter(routerUpdateTarget.text, {
          message,
          thread,
          messages,
          deliveryType: "router_update",
          env,
        });
        const accountId = kind === "thread" ? routerUpdateTarget.accountId : pickString(message.accountId, routerUpdateTarget.accountId);
        const textKey = deliveryTextKey(chatId, `${deliveryId}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }
        try {
          const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
          const delivery = {
            kind,
            deliveryType: "router_update",
            routerUpdateType: routerUpdateTarget.routerUpdateType,
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            textKey,
            deliveredAt: new Date().toISOString(),
            bridgeResponse: payload,
          };
          outboundDeliveries.push(delivery);
          deliveredIds.add(deliveryId);
          deliveredTextKeys.add(textKey);
          batchTextKeys.add(textKey);
          delivered.push(delivery);
          await appendEvent({
            type: "whatsapp_outbound_router_update_delivered",
            routerUpdateType: routerUpdateTarget.routerUpdateType,
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: message.id,
            chatId,
          }, env);
        } catch (error) {
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      const queuedModeTarget = queuedModeWhatsAppDeliveryTarget(message, thread, state);
      if (queuedModeTarget) {
        const deliveryId = `${message.id}:mode_queued`;
        if (deliveredIds.has(deliveryId)) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        const chatId = queuedModeTarget.chatId;
        const text = appendWhatsAppDebugFooter(formatWhatsAppModeQueued(queuedModeTarget.mode), {
          message,
          thread,
          messages,
          deliveryType: "mode_queued",
          env,
        });
        const accountId = kind === "thread" ? queuedModeTarget.accountId : pickString(message.accountId, queuedModeTarget.accountId);
        const textKey = deliveryTextKey(chatId, `${deliveryId}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }
        try {
          const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
          const delivery = {
            kind,
            deliveryType: "mode_queued",
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            textKey,
            deliveredAt: new Date().toISOString(),
            bridgeResponse: payload,
          };
          outboundDeliveries.push(delivery);
          deliveredIds.add(deliveryId);
          deliveredTextKeys.add(textKey);
          batchTextKeys.add(textKey);
          delivered.push(delivery);
          await appendEvent({ type: "whatsapp_outbound_mode_queued_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } catch (error) {
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      const queuedInputTarget = queuedInputWhatsAppDeliveryTarget(message, thread, state);
      if (queuedInputTarget) {
        const deliveryId = `${message.id}:queue_notice`;
        if (deliveredIds.has(deliveryId)) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        const chatId = queuedInputTarget.chatId;
        if (completedAssistantReplyForParent(messages, message, chatId, state) || latestProgressReplyForParent(messages, message.id)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "assistant_output_available" });
          continue;
        }
        const text = appendWhatsAppDebugFooter(formatWhatsAppQueueNotice(message, queuedInputTarget.reason), {
          message,
          thread,
          messages,
          deliveryType: "queue_notice",
          env,
        });
        const accountId = kind === "thread" ? queuedInputTarget.accountId : pickString(message.accountId, queuedInputTarget.accountId);
        const textKey = deliveryTextKey(chatId, `${deliveryId}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }
        try {
          const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
          const delivery = {
            kind,
            deliveryType: "queue_notice",
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            textKey,
            deliveredAt: new Date().toISOString(),
            bridgeResponse: payload,
          };
          outboundDeliveries.push(delivery);
          deliveredIds.add(deliveryId);
          deliveredTextKeys.add(textKey);
          batchTextKeys.add(textKey);
          delivered.push(delivery);
          await appendEvent({ type: "whatsapp_outbound_queue_notice_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } catch (error) {
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      const failedDeliveryTarget = failedWhatsAppDeliveryTarget(message, thread, state);
      if (failedDeliveryTarget) {
        if (deliveredIds.has(message.id)) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        const chatId = failedDeliveryTarget.chatId;
        const completedReply = completedAssistantReplyForParent(messages, message, chatId, state);
        if (completedReply) {
          if (deliveredIds.has(completedReply.id)) {
            await completePassiveMirrorParent({
              kind,
              agentId,
              threadId,
              parent: message,
              reply: completedReply,
              chatId,
              delivery: outboundDeliveries.find((delivery) => delivery.messageId === completedReply.id) || null,
              state,
              env,
            }).catch(() => null);
          }
          skipped.push({ agentId, threadId, messageId: message.id, reason: "assistant_reply_available" });
          continue;
        }
        const text = appendWhatsAppDebugFooter(formatWhatsAppDeliveryFailure(message), {
          message,
          thread,
          messages,
          deliveryType: "delivery_error",
          env,
        });
        const accountId = kind === "thread" ? failedDeliveryTarget.accountId : pickString(message.accountId, failedDeliveryTarget.accountId);
        const textKey = deliveryTextKey(chatId, `${message.id}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }
        try {
          const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
          const delivery = {
            kind,
            deliveryType: "delivery_error",
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: message.id,
            chatId,
            accountId,
            textKey,
            deliveredAt: new Date().toISOString(),
            bridgeResponse: payload,
          };
          outboundDeliveries.push(delivery);
          deliveredIds.add(message.id);
          deliveredTextKeys.add(textKey);
          batchTextKeys.add(textKey);
          delivered.push(delivery);
          await appendEvent({ type: "whatsapp_outbound_delivery_error_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } catch (error) {
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      if (message.role !== "assistant" || message.state !== "completed" || deliveredIds.has(message.id)) continue;
      if (shouldMirrorWhatsAppProgress(message)) {
        const parent = messages.find((entry) => entry.id === message.parentMessageId);
        const whatsappOrigin = parent?.connector === "whatsapp" || parent?.source === "whatsapp_inbound" || message.connector === "whatsapp";
        if (!whatsappOrigin) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        if (completedFinalReplyForParent(messages, message.parentMessageId)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "final_reply_available" });
          continue;
        }
        const latestProgress = latestProgressReplyForParent(messages, message.parentMessageId);
        if (latestProgress?.id !== message.id) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "superseded_progress" });
          continue;
        }

        const chatId = pickString(message.chatId, parent?.chatId);
        const accountId = kind === "thread"
          ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
          : pickString(message.accountId, parent?.accountId);
        const text = appendWhatsAppDebugFooter(formatWhatsAppOutboundText(pickString(message.text)), {
          message,
          thread,
          messages,
          deliveryType: "progress",
          env,
        });
        if (!chatId || !text) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: !chatId ? "missing_chat_id" : "missing_text" });
          continue;
        }

        const lastProgress = latestProgressDelivery(outboundDeliveries, message.parentMessageId, chatId);
        const elapsedMs = lastProgress?.deliveredAt ? Date.now() - Date.parse(lastProgress.deliveredAt) : Infinity;
        if (elapsedMs < progressMirrorIntervalMs(env)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "progress_throttled" });
          continue;
        }
        const textKey = deliveryTextKey(chatId, `progress:${message.id}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }

        try {
          const payload = await sendWhatsAppText({ chatId, text, accountId, config, env, fetchImpl });
          const delivery = {
            kind,
            deliveryType: "progress",
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: message.id,
            parentMessageId: message.parentMessageId,
            chatId,
            accountId,
            textKey,
            deliveredAt: new Date().toISOString(),
            bridgeResponse: payload,
          };
          outboundDeliveries.push(delivery);
          deliveredIds.add(message.id);
          deliveredTextKeys.add(textKey);
          batchTextKeys.add(textKey);
          delivered.push(delivery);
          await appendEvent({ type: "whatsapp_outbound_progress_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } catch (error) {
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      if (!shouldMirrorWhatsAppReply(message)) continue;
      const parent = messages.find((entry) => entry.id === message.parentMessageId);
      const whatsappOrigin = parent?.connector === "whatsapp" || parent?.source === "whatsapp_inbound" || message.connector === "whatsapp";
      if (!whatsappOrigin) continue;
      if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
        continue;
      }

      const chatId = pickString(message.chatId, parent?.chatId);
      const text = appendWhatsAppDebugFooter(formatWhatsAppOutboundText(pickString(message.text)), {
        message,
        thread,
        messages,
        deliveryType: message.source === "orkestr_runtime" ? "router_update" : "final",
        env,
      });
      const accountId = kind === "thread"
        ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
        : pickString(message.accountId, parent?.accountId);
      if (!chatId || !text) {
        skipped.push({ agentId, messageId: message.id, reason: !chatId ? "missing_chat_id" : "missing_text" });
        continue;
      }
      const textKey = deliveryTextKey(chatId, text);
      if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
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
          textKey,
          deliveredAt: new Date().toISOString(),
          bridgeResponse: payload,
        };
        outboundDeliveries.push(delivery);
        deliveredIds.add(message.id);
        deliveredTextKeys.add(textKey);
        batchTextKeys.add(textKey);
        delivered.push(delivery);
        if (parent) {
          await completePassiveMirrorParent({
            kind,
            agentId,
            threadId,
            parent,
            reply: message,
            chatId,
            delivery,
            state,
            env,
          }).catch(() => null);
        }
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

export async function deliverWhatsAppReplies(env = process.env, fetchImpl = fetch) {
  if (whatsappDeliveryInFlight) return whatsappDeliveryInFlight;
  whatsappDeliveryInFlight = deliverWhatsAppRepliesOnce(env, fetchImpl).finally(() => {
    whatsappDeliveryInFlight = null;
  });
  return whatsappDeliveryInFlight;
}
