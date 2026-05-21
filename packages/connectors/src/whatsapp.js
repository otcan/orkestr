import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { enqueueAgentMessage, updateAgentMessage } from "../../core/src/messages.js";
import { enqueueThreadInput, listThreadMessages, listThreads, updateThreadMessage } from "../../core/src/threads.js";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  getLocalWhatsAppBridgeStatus,
  localWhatsAppBridgeBasePath,
  listLocalWhatsAppChatParticipants,
  sendLocalWhatsAppText,
} from "./whatsapp-local-bridge.js";

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

function bridgeMode(config = {}, env = process.env) {
  const mode = String(env.WHATSAPP_BRIDGE_MODE || config.bridgeMode || "local").trim().toLowerCase();
  return mode === "external" ? "external" : "local";
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

export async function getWhatsAppChatParticipants({ accountId = "account-1", chatId = "" } = {}, env = process.env, fetchImpl = fetch) {
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
      if (accountId && accountId !== senderAccountId) return false;
      if (!fromMe) {
        const additionalParticipantsEnabled = binding.additionalParticipantsEnabled === true || binding.allowOtherPeopleConfirmed === true;
        if (!additionalParticipantsEnabled) return false;
        if (senderContactId && comparableParticipantId(from) === comparableParticipantId(senderContactId)) return false;
        if (responderContactId && comparableParticipantId(from) === comparableParticipantId(responderContactId)) return false;
        if (!participantIdSet(binding.additionalParticipantIds).has(comparableParticipantId(from))) return false;
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
  const message = threadId
    ? await enqueueThreadInput(threadId, messageInput, env)
    : await enqueueAgentMessage(agentId, messageInput, env);
  const contentDuplicate = Boolean(message.duplicate);
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

function threadAllowsWhatsAppMirroring(thread) {
  if (!thread?.binding) return true;
  return thread.binding.mirrorToWhatsApp !== false && thread.binding.mirrorReplies !== false;
}

function whatsappMessageOrigin(message, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
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
  if (role !== "user" || (messageState !== "failed" && deliveryState !== "failed")) return null;
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
      const queuedModeTarget = queuedModeWhatsAppDeliveryTarget(message, thread, state);
      if (queuedModeTarget) {
        const deliveryId = `${message.id}:mode_queued`;
        if (deliveredIds.has(deliveryId)) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        const chatId = queuedModeTarget.chatId;
        const text = formatWhatsAppModeQueued(queuedModeTarget.mode);
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
        const text = formatWhatsAppDeliveryFailure(message);
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
      if (!shouldMirrorWhatsAppReply(message)) continue;
      const parent = messages.find((entry) => entry.id === message.parentMessageId);
      const whatsappOrigin = parent?.connector === "whatsapp" || parent?.source === "whatsapp_inbound" || message.connector === "whatsapp";
      if (!whatsappOrigin) continue;
      if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
        continue;
      }

      const chatId = pickString(message.chatId, parent?.chatId);
      const text = formatWhatsAppOutboundText(pickString(message.text));
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
