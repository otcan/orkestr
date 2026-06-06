import fs from "node:fs/promises";
import path from "node:path";
import { enqueueAgentMessage } from "../../core/src/messages.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { adminPrincipal, userPrincipal } from "../../core/src/principal.js";
import { appServerStateFromStatus } from "../../core/src/codex-app-server-common.js";
import { clearRuntimeLeasesForThread, runtimeStatus } from "../../core/src/runtime-leases.js";
import { classifyApprovalReply } from "../../core/src/runtime-settings.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../../core/src/tenant-api-agent.js";
import { parseThreadInputCommand } from "../../core/src/thread-commands.js";
import { isRemoteThreadAttachmentDescriptor, redactDeniedThreadAttachmentPaths, resolveThreadAttachments } from "../../core/src/thread-attachments.js";
import {
  ensureRouterTurn,
  markRouterOutboxItem,
  planRouterOutboxItem,
  recordRouterTraceEvent,
  routerTraceIdFor,
  turnIdFor,
} from "../../core/src/router-traces.js";
import { appendThreadMessage, createThreadForPrincipal, enqueueThreadInputForPrincipal, listThreadMessages, listThreads, listThreadsForPrincipal, updateThread, updateThreadMessage } from "../../core/src/threads.js";
import { adminUserId, findOrCreateExternalUser, normalizeUserId } from "../../core/src/users.js";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  getLocalWhatsAppBridgeStatus,
  localWhatsAppBridgeBasePath,
  listLocalWhatsAppChatParticipants,
  sendLocalWhatsAppMessage,
  syncLocalWhatsAppTypingTargets,
} from "./whatsapp-local-bridge.js";
import { routerUpdateWhatsAppDeliveryTarget } from "./whatsapp-router-updates.js";
import { attachmentDeliveryKey, prepareWhatsAppTableAttachments } from "./whatsapp-table-attachments.js";
import { appendWhatsAppDebugFooter, formatWhatsAppOutboundText } from "./whatsapp-formatting.js";
import {
  bindingAccountIds,
  isWhatsAppGroupChatId,
  whatsappAutoThreadBinding,
  whatsappBindingIsRouteEligible,
  whatsappDisplayName,
  whatsappInboundThreadMatchesBinding,
} from "./whatsapp-inbound-routing.js";
import {
  claimConnectorOutboxJob,
  connectorOutboxTerminalState,
  ensureConnectorOutboxJob,
  markConnectorOutboxJob,
  releaseConnectorOutboxClaim,
} from "./connector-outbox.js";
import {
  acquireOutboundDeliveryClaim,
  deliveryTextKey,
  finishOutboundDeliveryClaim,
  outboundDeliveryKey,
  pruneOutboundDeliveryClaims,
} from "./whatsapp-delivery-ledger.js";
import {
  advanceWhatsAppOutboundMirrorCursors,
  canCreateWhatsAppOutboundIntent,
  canRecoverLiveWhatsAppOutboundIntent,
  markWhatsAppOutboundIntent,
  mergeWhatsAppOutboundIntents,
  mergeWhatsAppOutboundMirrorCursors,
  outboundIntentKey,
  outboundMirrorMessageCursor,
  outboundMirrorMessageSetKey,
} from "./whatsapp-outbound-intents.js";
import {
  codexAssistantSource,
  shouldMirrorWhatsAppProgress,
  shouldMirrorWhatsAppReply,
} from "./whatsapp-mirror-policy.js";
import {
  enqueueRemoteWhatsAppThreadInput,
  remoteWhatsAppRuntimeBinding,
  syncRemoteWhatsAppThreadMessages,
} from "./whatsapp-remote-runtime.js";
import { materializeRemoteWhatsAppAttachments } from "./whatsapp-remote-artifacts.js";
import {
  boundThreadWhatsAppAssistantOrigin,
  completePassiveMirrorParent,
  completedAssistantReplyForParent,
  failedWhatsAppDeliveryTarget,
  formatWhatsAppDeliveryFailure,
  formatWhatsAppModeQueued,
  formatWhatsAppQueueNotice,
  initialQueueDeliveryState,
  latestProgressReplyForParent,
  queuedInputWhatsAppDeliveryTarget,
  queuedModeWhatsAppDeliveryTarget,
  recoverParentsForAlreadyMirroredReplies,
  staleUntrackedWhatsAppProgress,
  staleUntrackedWhatsAppReply,
  threadAllowsWhatsAppMirroring,
  whatsappOutboundDeliveryRetentionLimit,
  whatsappTypingTargetForThread,
} from "./whatsapp-outbound-mirror.js";
import { createWhatsAppOutboundMirrorWorker } from "./whatsapp-outbound-worker.js";
import {
  createGoogleWorkspaceConnectLink,
  googleWorkspaceConnectCommand,
} from "./google-workspace.js";

export { formatWhatsAppOutboundText } from "./whatsapp-formatting.js";
export { initialQueueDeliveryState } from "./whatsapp-outbound-mirror.js";

const whatsappOutboundMirrorWorker = createWhatsAppOutboundMirrorWorker();

async function fetchJson(url, fetchImpl, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(2000) });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function fetchOk(url, fetchImpl, options = {}) {
  try {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(2000) });
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

export function whatsappBridgeEndpointUrl(bridgeUrl, endpointPath) {
  const base = String(bridgeUrl || "").trim().replace(/\/+$/, "");
  const endpoint = String(endpointPath || "").trim().replace(/^\/+/, "");
  return new URL(`${base}/${endpoint}`);
}

export async function configuredWhatsAppBridgeUrl(env = process.env) {
  const config = await readConnectorConfig("whatsapp", env);
  return configuredBridgeUrl(config, env);
}

function bridgeAuthHeaders(config = {}, env = process.env) {
  const apiToken = pickString(env.WHATSAPP_BRIDGE_TOKEN, env.WA_HTTP_TOKEN, config.apiToken);
  return apiToken ? { authorization: `Bearer ${apiToken}` } : {};
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

function publicBridgeAccount(account = {}) {
  const id = pickString(account.accountId, account.id);
  return {
    id,
    accountId: id,
    label: pickString(account.label, account.name),
    state: pickString(account.state, account.status),
    ready: Boolean(account.ready),
    authenticated: Boolean(account.authenticated),
    started: Boolean(account.started),
    qrAvailable: Boolean(account.qrAvailable),
    pairingCodeUpdatedAt: pickString(account.pairingCodeUpdatedAt),
    loadingPercent: account.loadingPercent ?? null,
    loadingMessage: pickString(account.loadingMessage),
    error: pickString(account.error),
    updatedAt: pickString(account.updatedAt),
  };
}

function publicExternalBridgeHealth(payload = {}) {
  return {
    ok: payload.ok === true,
    mode: pickString(payload.mode),
    state: pickString(payload.state, payload.status),
    ready: Boolean(payload.ready),
    clientReady: Boolean(payload.clientReady),
    authenticated: Boolean(payload.authenticated),
    qrAvailable: Boolean(payload.qrAvailable),
    maxAccounts: Number.isFinite(Number(payload.maxAccounts)) ? Number(payload.maxAccounts) : undefined,
    accounts: Array.isArray(payload.accounts) ? payload.accounts.map(publicBridgeAccount) : undefined,
    updatedAt: pickString(payload.updatedAt),
  };
}

function attachmentSetKey(attachments = []) {
  return (attachments || [])
    .map((attachment) => pickString(attachment.id, attachment.path, attachment.saved_path))
    .filter(Boolean)
    .sort()
    .join("\n");
}

async function persistMessageAttachmentsIfChanged(threadId, message, attachments, env) {
  if (!threadId || !message?.id || !attachments.length) return;
  if (attachmentSetKey(message.attachments || []) === attachmentSetKey(attachments)) return;
  await updateThreadMessage(threadId, message.id, { attachments }, env).catch(() => null);
}

function remoteAttachmentFailureReason(reason = "") {
  return String(reason || "remote_attachment_unavailable").replace(/^remote_attachment_/, "").replace(/^remote_/, "").replace(/_/g, " ");
}

function appendRemoteAttachmentFailureNotes(text = "", skipped = []) {
  const failures = (Array.isArray(skipped) ? skipped : [])
    .map((item) => {
      const filename = pickString(item.filename, item.remoteAttachmentId, "attachment");
      const reason = remoteAttachmentFailureReason(item.reason);
      return `${filename}: ${reason}`;
    })
    .filter(Boolean);
  if (!failures.length) return text;
  return [
    String(text || "").trim(),
    "",
    "Attachment not sent:",
    ...failures.map((line) => `- ${line}`),
  ].filter((line, index) => index !== 0 || line).join("\n");
}

async function externalBridgeAccounts(bridgeUrl, healthPayload, fetchImpl, headers = {}) {
  if (Array.isArray(healthPayload?.accounts)) return healthPayload.accounts.map(publicBridgeAccount);
  try {
    const dashboard = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/api/dashboard"), fetchImpl, { headers });
    if (dashboard.ok && Array.isArray(dashboard.accounts)) return dashboard.accounts.map(publicBridgeAccount);
    if (dashboard.ok && Array.isArray(dashboard.payload?.accounts)) return dashboard.payload.accounts.map(publicBridgeAccount);
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
  const headers = bridgeAuthHeaders(config, env);
  try {
    const health = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/health"), fetchImpl, { headers });
    if (!health.ok) {
      return {
        state: "failed",
        summary: `WhatsApp bridge returned HTTP ${health.status}.`,
        bridgeUrl,
        health: publicExternalBridgeHealth(health.payload),
        qrAvailable: false,
      };
    }
    if (hasReadySignal(health.payload)) {
      const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl, headers);
      return {
        state: "paired",
        summary: "WhatsApp bridge is reachable and paired.",
        bridgeUrl,
        health: publicExternalBridgeHealth(health.payload),
        accounts,
        qrAvailable: false,
      };
    }
    const qrAvailable = await fetchOk(whatsappBridgeEndpointUrl(bridgeUrl, "/qr.svg"), fetchImpl, { headers });
    const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl, headers);
    return {
      state: qrAvailable ? "qr_needed" : "unpaired",
      summary: qrAvailable ? "WhatsApp bridge is reachable; scan the QR code to pair." : "WhatsApp bridge is reachable but not paired.",
      bridgeUrl,
      health: publicExternalBridgeHealth(health.payload),
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
  const metaUrl = whatsappBridgeEndpointUrl(bridgeUrl, `/api/chats/${encodeURIComponent(id)}/meta`);
  if (accountId) metaUrl.searchParams.set("accountId", accountId);
  const response = await fetchImpl(metaUrl, {
    headers: bridgeAuthHeaders(config, env),
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

function messageTimeMs(message = {}) {
  const ms = Date.parse(String(message.timestamp || message.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function whatsappStateMessageOrigin(message = {}, state = null) {
  if (!message) return false;
  if (message.connector === "whatsapp" || message.source === "whatsapp_inbound" || message.source === "whatsapp_client") return true;
  return Boolean((state?.inboundEvents || []).some((event) => event.messageId === message.id));
}

function sameWhatsAppChat(message = {}, chatId = "", state = null) {
  const targetChatId = pickString(chatId);
  if (!targetChatId || !whatsappStateMessageOrigin(message, state)) return false;
  const inboundEvent = [...(state?.inboundEvents || [])]
    .reverse()
    .find((event) => event.messageId === message.id) || null;
  return pickString(message.chatId, inboundEvent?.chatId) === targetChatId;
}

function supersededRuntimeInterruptionNotice(messages = [], message = {}, chatId = "", state = null) {
  const role = String(message?.role || "").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  const source = String(message?.source || "").trim().toLowerCase();
  if (role !== "assistant" || phase !== "runtime_interrupted" || source !== "orkestr_runtime") return false;
  const noticeMs = messageTimeMs(message);
  if (!noticeMs) return false;
  return messages.some((candidate) =>
    String(candidate?.role || "").trim().toLowerCase() === "user" &&
    messageTimeMs(candidate) > noticeMs &&
    sameWhatsAppChat(candidate, chatId, state)
  );
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

function whatsappAutoProvisionUsers(config = {}, env = process.env) {
  return truthyEnv(env.ORKESTR_WHATSAPP_AUTO_PROVISION_USERS) ||
    truthyEnv(env.WHATSAPP_AUTO_PROVISION_USERS) ||
    truthyEnv(config.autoProvisionUsers) ||
    truthyEnv(config.autoProvisionUserChats);
}

async function chatHasConfiguredThreadBinding({ chatId = "", accountId = "" } = {}, env = process.env) {
  if (!chatId) return false;
  const threads = await listThreads(env);
  return threads.some((thread) => {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return false;
    if (pickString(binding.chatId) !== chatId) return false;
    const accounts = bindingAccountIds(binding);
    return !accountId || accounts.size === 0 || accounts.has(accountId);
  });
}

function principalForThread(thread = {}, env = process.env) {
  const ownerUserId = resourceOwnerUserId(thread, env);
  const adminId = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  if (ownerUserId === adminId) return adminPrincipal({ id: adminId, displayName: "Admin" });
  return userPrincipal({ id: ownerUserId, role: "user", displayName: ownerUserId, source: "whatsapp-owner" });
}

function explicitWhatsAppApprovalReply(text = "") {
  const normalized = pickString(text).toLowerCase().replace(/\s+/g, " ");
  if (!normalized.startsWith("/approve") && !normalized.startsWith("/deny")) return null;
  const classified = classifyApprovalReply(text);
  return classified.action ? classified : null;
}

function threadHasActionableStoredPendingRequest(thread = {}) {
  const runtime = thread?.runtime || {};
  const pendingRequest = runtime.pendingRequest || thread.pendingRequest || null;
  if (!pendingRequest || typeof pendingRequest !== "object") return false;
  const statusState = appServerStateFromStatus(runtime.codexStatus || thread.codexStatus || null);
  const storedState = pickString(runtime.state, thread.state, thread.status).toLowerCase();
  return statusState === "awaiting_approval" ||
    (!statusState && storedState === "awaiting_approval") ||
    thread?.turnLifecycle?.awaitingApproval === true;
}

function isCodexAppServerThread(thread = {}) {
  return pickString(
    thread.runtimeKind,
    thread.runtime?.runtimeKind,
    thread.executor?.metadata?.runtimeKind,
    thread.executor?.transport,
  ).toLowerCase() === "codex-app-server" ||
    pickString(thread.executor?.transport).toLowerCase() === "app-server";
}

function shouldUseApiAgentForWhatsAppThread(thread = {}, env = process.env) {
  const owner = resourceOwnerUserId(thread, env);
  const adminId = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  if (!owner || owner === adminId) return false;
  const binding = thread?.binding || {};
  if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp" && !binding.chatId) return false;
  if (String(env.ORKESTR_TENANT_WHATSAPP_API_AGENT || "1").trim().toLowerCase() === "0") return false;
  return true;
}

async function ensureApiAgentWhatsAppThread(thread = null, env = process.env) {
  if (!thread || !shouldUseApiAgentForWhatsAppThread(thread, env)) return thread;
  if (threadUsesApiAgent(thread, env) && !apiAgentWhatsAppThreadNeedsNormalization(thread, env)) return thread;
  const metadata = thread.executor?.metadata || {};
  await clearRuntimeLeasesForThread(thread.id, { reason: "api_agent_thread_normalized" }, env).catch(() => null);
  return updateThread(thread.id, {
    runtimeKind: "api-agent",
    runtime: null,
    codexThreadId: null,
    codexSessionId: null,
    codexMode: null,
    desiredCodexMode: null,
    codexTokenUsage: null,
    codexRateLimits: null,
    executorId: "api-agent",
    executor: {
      id: "api-agent",
      type: "api-agent",
      transport: "api-agent",
      codexThreadId: null,
      codexSessionId: null,
      sessionName: null,
      tmuxTarget: null,
      paneId: null,
      metadata: {
        transport: "api-agent",
        runtimeKind: "api-agent",
        securityProfile: metadata.securityProfile || thread.securityProfile || "generated-whatsapp",
        codexSandbox: "workspace-write",
        codexApprovalPolicy: "on-request",
        containedUserRuntimePolicy: metadata.containedUserRuntimePolicy === true || thread.ownerUserId ? true : undefined,
        containedCodexIsolated: metadata.containedCodexIsolated === true ? true : undefined,
        codexThreadId: null,
        codexSessionId: null,
        codexTokenUsage: null,
        codexRateLimits: null,
      },
    },
  }, env).catch(() => thread);
}

function apiAgentWhatsAppThreadNeedsNormalization(thread = {}, env = process.env) {
  if (!threadUsesApiAgent(thread, env)) return true;
  const executor = thread.executor || {};
  const metadata = executor.metadata || {};
  return Boolean(
    thread.runtime ||
      thread.codexThreadId ||
      thread.codexSessionId ||
      thread.codexMode ||
      thread.desiredCodexMode ||
      thread.codexTokenUsage ||
      thread.codexRateLimits ||
      executor.type !== "api-agent" ||
      executor.transport !== "api-agent" ||
      executor.codexThreadId ||
      executor.codexSessionId ||
      executor.sessionName ||
      executor.tmuxTarget ||
      executor.paneId ||
      metadata.transport !== "api-agent" ||
      metadata.runtimeKind !== "api-agent" ||
      metadata.codexThreadId ||
      metadata.codexSessionId ||
      metadata.codexTokenUsage ||
      metadata.codexRateLimits
  );
}

function whatsappApiAgentAutoRun(env = process.env) {
  return String(env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN || "1").trim().toLowerCase() !== "0";
}

function kickWhatsAppApiAgentThread(thread, env = process.env) {
  if (!thread?.id || !threadUsesApiAgent(thread, env) || !whatsappApiAgentAutoRun(env)) return;
  void deliverWhatsAppReplies(env).catch(() => null)
    .then(() => processApiAgentThreadInput(thread.id, env))
    .then(() => deliverWhatsAppReplies(env).catch(() => null))
    .catch((error) => appendEvent({
      type: "whatsapp_api_agent_autorun_failed",
      threadId: thread.id,
      ownerUserId: resourceOwnerUserId(thread, env),
      error: error?.message || String(error),
    }, env).catch(() => null));
}

async function routeAutoProvisionedThread(input = {}, config = {}, env = process.env) {
  if (!whatsappAutoProvisionUsers(config, env)) return { threadId: "", binding: null };
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId);
  const from = pickString(input.from, input.sender, input.author);
  const fromMe = input.fromMe === true || input.from_me === true || String(input.fromMe || input.from_me || "").toLowerCase() === "true";
  const externalId = pickString(input.externalUserId, input.senderId, input.participantId, from, !isWhatsAppGroupChatId(chatId) ? chatId : "");
  if (!chatId || !externalId || fromMe) return { threadId: "", binding: null };
  if (await chatHasConfiguredThreadBinding({ chatId, accountId }, env)) return { threadId: "", binding: null };

  const displayName = whatsappDisplayName(input, externalId);
  const user = await findOrCreateExternalUser({
    provider: "whatsapp",
    accountId,
    externalId,
    chatId,
    displayName,
    source: "auto",
  }, env);
  const principal = userPrincipal({ ...user, source: "whatsapp" });
  const ownedThreads = await listThreadsForPrincipal(principal, env);
  const existing = ownedThreads.find((thread) => pickString(thread?.binding?.chatId) === chatId) || ownedThreads[0] || null;
  let thread = existing;
  const bindingDisplayName = whatsappDisplayName(input, existing?.binding?.displayName || existing?.name || displayName);
  const binding = whatsappAutoThreadBinding({ chatId, accountId, from: externalId, displayName: bindingDisplayName });
  if (!thread) {
    thread = await createThreadForPrincipal({
      id: `wa-${user.id}`,
      name: bindingDisplayName,
      title: bindingDisplayName,
      wakePolicy: "wake-on-message",
      executorId: "api-agent",
      executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
      runtimeKind: "api-agent",
      binding,
      bindingName: binding.displayName,
    }, principal, env);
  } else if (!pickString(thread?.binding?.chatId)) {
    thread = await updateThread(thread.id, { binding, bindingName: binding.displayName }, env);
  }

  await appendEvent({
    type: "whatsapp_user_thread_auto_provisioned",
    threadId: thread.id,
    ownerUserId: resourceOwnerUserId(thread, env),
    chatId,
    accountId,
    externalId,
    created: !existing,
  }, env).catch(() => {});
  return {
    threadId: thread.id,
    binding: thread.binding || binding,
    user,
    autoProvisioned: true,
    createdThread: !existing,
  };
}

async function routeThread(input, config, env) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId);
  const from = pickString(input.from, input.sender, input.author);
  const fromMe = input.fromMe === true || input.from_me === true || String(input.fromMe || input.from_me || "").toLowerCase() === "true";
  const routes = config.threadRoutes || config.threads || {};
  const explicitInput = pickString(input.threadId, input.targetThreadId);
  const explicit = pickString(
    explicitInput,
    chatId ? routes[chatId] : "",
    config.defaultThreadId,
  );
  if (!chatId && !explicit) return { threadId: "", binding: null };
  const threads = await listThreads(env);
  if (explicit) {
    const thread = threads.find((item) => item.id === explicit || item.name === explicit || item.bindingName === explicit) || null;
    const binding = thread?.binding || null;
    if (binding && !whatsappBindingIsRouteEligible(binding)) return { threadId: "", binding: null };
    return { threadId: explicit, binding };
  }
  const thread = threads.find((item) => whatsappInboundThreadMatchesBinding({ thread: item, chatId, accountId, from, fromMe }));
  return thread ? { threadId: thread.id, binding: thread.binding || null } : { threadId: "", binding: null };
}

async function readWhatsAppState(env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.whatsapp, { inboundEvents: [] });
}

function mergeByKey(existing = [], next = [], keyFn = () => "") {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const key = keyFn(item);
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}

function timeMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function mergeOutboundDeliveries(existing = [], next = [], env = process.env) {
  const merged = new Map();
  for (const delivery of [...(existing || []), ...(next || [])]) {
    const key = outboundDeliveryKey(delivery);
    if (!key) continue;
    const previous = merged.get(key);
    if (!previous || timeMs(delivery?.deliveredAt) >= timeMs(previous?.deliveredAt)) {
      merged.set(key, delivery);
    }
  }
  return [...merged.values()]
    .sort((left, right) => timeMs(left?.deliveredAt) - timeMs(right?.deliveredAt))
    .slice(-whatsappOutboundDeliveryRetentionLimit(env));
}

function mergeWhatsAppState(existing = {}, next = {}, env = process.env) {
  return {
    ...existing,
    ...next,
    inboundEvents: mergeByKey(existing.inboundEvents, next.inboundEvents, (event) => pickString(event.eventId)).slice(-500),
    outboundDeliveries: mergeOutboundDeliveries(existing.outboundDeliveries, next.outboundDeliveries, env),
    outboundDeliveryClaims: pruneOutboundDeliveryClaims(
      mergeByKey(existing.outboundDeliveryClaims, next.outboundDeliveryClaims, (claim) => pickString(claim.claimKey)),
      { env, retentionLimit: whatsappOutboundDeliveryRetentionLimit(env) },
    ),
    outboundIntents: mergeWhatsAppOutboundIntents(existing.outboundIntents, next.outboundIntents, env),
    outboundMirrorCursors: mergeWhatsAppOutboundMirrorCursors(existing.outboundMirrorCursors, next.outboundMirrorCursors),
    updatedAt: new Date().toISOString(),
  };
}

async function writeWhatsAppState(state, env) {
  const paths = dataPaths(env);
  const existing = await readJson(paths.whatsapp, {
    inboundEvents: [],
    outboundDeliveries: [],
    outboundDeliveryClaims: [],
    outboundIntents: [],
    outboundMirrorCursors: [],
  }).catch(() => ({}));
  await writeJson(paths.whatsapp, mergeWhatsAppState(existing, state, env));
}

async function ensureWhatsAppOutboundIntent({
  state,
  outboundIntents,
  kind,
  deliveryType,
  routerUpdateType,
  agentId,
  threadId,
  messageId,
  sourceMessageId,
  parentMessageId,
  chatId,
  accountId,
  textKey,
  text,
  attachments,
  message,
  parent,
  thread,
  messageSetKey,
  messageCursor,
  env,
} = {}) {
  const routerTraceId = pickString(message?.routerTraceId, parent?.routerTraceId);
  const turnId = pickString(message?.turnId, parent?.turnId) || (routerTraceId ? turnIdFor({ routerTraceId }) : "");
  const intentId = outboundIntentKey({
    kind,
    deliveryType,
    routerUpdateType,
    chatId,
    accountId,
    messageId,
    sourceMessageId,
    textKey,
  });
  const existing = outboundIntents.find((intent) => pickString(intent.intentId, outboundIntentKey(intent)) === intentId);
  if (existing) {
    const status = String(existing.status || "pending").trim().toLowerCase();
    if (status === "delivered") {
      await recordRouterTraceEvent({
        routerTraceId: pickString(existing.routerTraceId, routerTraceId),
        turnId: pickString(existing.turnId, turnId),
        connector: "whatsapp",
        phase: "skipped",
        reason: "intent_already_delivered",
        threadId,
        messageId,
        chatId,
        accountId,
        terminal: true,
      }, env).catch(() => {});
      return { skipped: { reason: "intent_already_delivered" } };
    }
    if (status === "skipped" || status === "cancelled") {
      await recordRouterTraceEvent({
        routerTraceId: pickString(existing.routerTraceId, routerTraceId),
        turnId: pickString(existing.turnId, turnId),
        connector: "whatsapp",
        phase: "skipped",
        reason: pickString(existing.error, "intent_skipped"),
        threadId,
        messageId,
        chatId,
        accountId,
        terminal: true,
      }, env).catch(() => {});
      return { skipped: { reason: pickString(existing.error, "intent_skipped") } };
    }
    return { intent: existing };
  }
  const gate = canCreateWhatsAppOutboundIntent({
    state,
    messageSetKey,
    messageCursor,
    message,
    parent,
    thread,
    kind,
    env,
  });
  if (!gate.ok) {
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "skipped",
      reason: gate.reason || "missing_outbound_intent",
      threadId,
      messageId,
      chatId,
      accountId,
      terminal: true,
    }, env).catch(() => {});
    return { skipped: { reason: gate.reason || "missing_outbound_intent" } };
  }
  const now = new Date().toISOString();
  const outboxItem = await planRouterOutboxItem({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    destination: chatId,
    eventId: messageId,
    payloadHash: textKey,
    status: "pending",
  }, env).catch(() => null);
  const intent = {
    intentId,
    ...(routerTraceId ? { routerTraceId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(outboxItem?.outboxId ? { outboxId: outboxItem.outboxId } : {}),
    status: "pending",
    kind,
    deliveryType,
    ...(routerUpdateType ? { routerUpdateType } : {}),
    agentId: agentId || null,
    threadId: threadId || null,
    messageSetKey,
    messageCursor: Number(messageCursor || 0) || 0,
    messageId,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    chatId,
    accountId,
    textKey,
    text,
    ...(attachments ? { attachments } : {}),
    createdAt: now,
    updatedAt: now,
    createdReason: gate.reason || "new_after_cursor",
  };
  outboundIntents.push(intent);
  state.outboundIntents = outboundIntents;
  await writeWhatsAppState(state, env);
  return { intent, outboxItem, created: true };
}

function outboundIntentFieldMatches(intent = {}, input = {}) {
  return pickString(intent.kind) === pickString(input.kind) &&
    pickString(intent.deliveryType) === pickString(input.deliveryType) &&
    pickString(intent.routerUpdateType) === pickString(input.routerUpdateType) &&
    pickString(intent.messageId) === pickString(input.messageId) &&
    pickString(intent.sourceMessageId) === pickString(input.sourceMessageId) &&
    pickString(intent.chatId) === pickString(input.chatId) &&
    pickString(intent.accountId) === pickString(input.accountId);
}

function findWhatsAppOutboundIntent(outboundIntents = [], input = {}) {
  const exactIntentId = input.textKey ? outboundIntentKey(input) : "";
  if (exactIntentId) {
    const exact = outboundIntents.find((intent) => pickString(intent.intentId, outboundIntentKey(intent)) === exactIntentId);
    if (exact) return exact;
  }
  return outboundIntents.find((intent) => outboundIntentFieldMatches(intent, input)) || null;
}

async function skipWhatsAppOutboundCandidate({
  state,
  outboundIntents,
  kind,
  deliveryType,
  routerUpdateType,
  agentId,
  threadId,
  messageId,
  sourceMessageId,
  chatId,
  accountId,
  textKey,
  message,
  parent,
  reason,
  env,
} = {}) {
  const routerTraceId = pickString(message?.routerTraceId, parent?.routerTraceId);
  const turnId = pickString(message?.turnId, parent?.turnId) || (routerTraceId ? turnIdFor({ routerTraceId }) : "");
  const matchInput = {
    kind,
    deliveryType,
    routerUpdateType,
    agentId,
    threadId,
    messageId,
    sourceMessageId,
    chatId,
    accountId,
    textKey,
  };
  const existing = findWhatsAppOutboundIntent(outboundIntents, matchInput);
  if (existing?.intentId) {
    const marked = markWhatsAppOutboundIntent(outboundIntents, existing.intentId, {
      status: "skipped",
      skippedAt: new Date().toISOString(),
      error: reason || "obsolete_outbound_notice",
    });
    outboundIntents.splice(0, outboundIntents.length, ...marked);
    state.outboundIntents = outboundIntents;
    await writeWhatsAppState(state, env);
    await markRouterOutboxItem(existing.outboxId, {
      status: "skipped",
      error: reason || "obsolete_outbound_notice",
    }, env).catch(() => null);
  }
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    phase: "skipped",
    reason: reason || "obsolete_outbound_notice",
    threadId,
    messageId,
    chatId,
    accountId,
    deliveryType,
    routerUpdateType,
    terminal: true,
  }, env).catch(() => {});
  return { skipped: { reason: reason || "obsolete_outbound_notice" } };
}

async function sendWhatsAppOutboundCandidate(input = {}) {
  if (String(input.message?.role || "").trim().toLowerCase() === "assistant") {
    await recordRouterTraceEvent({
      routerTraceId: pickString(input.message?.routerTraceId, input.parent?.routerTraceId),
      turnId: pickString(input.message?.turnId, input.parent?.turnId),
      connector: "whatsapp",
      accountId: pickString(input.accountId, input.message?.accountId, input.parent?.accountId),
      chatId: pickString(input.chatId, input.message?.chatId, input.parent?.chatId),
      threadId: input.threadId || "",
      messageId: input.messageId || input.message?.id || "",
      phase: "assistant_seen",
      deliveryType: input.deliveryType,
      routerUpdateType: input.routerUpdateType,
    }, input.env).catch(() => {});
  }
  const intentResult = await ensureWhatsAppOutboundIntent(input);
  if (intentResult.skipped) return intentResult;
  return sendClaimedWhatsAppText({
    ...input,
    intent: intentResult.intent,
  });
}

async function sendClaimedWhatsAppText({
  state,
  outboundDeliveries,
  outboundIntents,
  deliveredIds,
  deliveredTextKeys,
  batchTextKeys,
  intent,
  kind,
  deliveryType,
  routerUpdateType,
  agentId,
  threadId,
  messageId,
  sourceMessageId,
  parentMessageId,
  chatId,
  accountId,
  textKey,
  text,
  attachments,
  message,
  parent,
  thread,
  config,
  env,
  fetchImpl,
} = {}) {
  const routerTraceId = pickString(intent?.routerTraceId);
  const turnId = pickString(intent?.turnId) || (routerTraceId ? turnIdFor({ routerTraceId }) : "");
  const outboxResult = await ensureConnectorOutboxJob({
    tenantId: resourceOwnerUserId(thread || {}, env),
    ownerUserId: resourceOwnerUserId(thread || {}, env),
    connector: "whatsapp",
    accountId,
    chatId,
    threadId: threadId || "",
    agentId: agentId || "",
    sourceEventId: pickString(message?.eventId, message?.sourceEventId, sourceMessageId, messageId),
    sourceMessageId: pickString(sourceMessageId, messageId),
    sourceRevision: pickString(message?.revision, message?.updatedAt, message?.createdAt, "1"),
    deliveryType,
    payload: {
      text,
      ...(routerUpdateType ? { routerUpdateType } : {}),
      ...(attachments ? { attachments } : {}),
    },
    metadata: {
      kind,
      routerUpdateType: routerUpdateType || "",
      parentMessageId: parentMessageId || "",
      textKey,
      routerTraceId,
      turnId,
      routerOutboxId: intent?.outboxId || "",
    },
  }, env);
  if (connectorOutboxTerminalState(outboxResult.job?.state)) {
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "skipped",
      reason: `connector_outbox_${outboxResult.job.state}`,
      threadId,
      messageId,
      chatId,
      accountId,
      terminal: true,
    }, env).catch(() => {});
    return { skipped: { reason: `connector_outbox_${outboxResult.job.state}` } };
  }
  const outboxClaim = await claimConnectorOutboxJob(outboxResult.job.id, {
    claimant: `whatsapp-mirror:${process.pid}`,
  }, env);
  if (!outboxClaim.acquired) {
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "skipped",
      reason: outboxClaim.reason || "connector_outbox_claim_active",
      threadId,
      messageId,
      chatId,
      accountId,
    }, env).catch(() => {});
    return { skipped: { reason: outboxClaim.reason || "connector_outbox_claim_active" } };
  }
  const claimResult = await acquireOutboundDeliveryClaim({
    state,
    kind,
    deliveryType,
    agentId,
    threadId,
    messageId,
    sourceMessageId,
    chatId,
    accountId,
    textKey,
  }, env, { persistState: writeWhatsAppState });
  if (!claimResult.acquired) {
    await releaseConnectorOutboxClaim(outboxClaim.job.id, { reason: claimResult.reason || "delivery_claim_active" }, env).catch(() => {});
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "skipped",
      reason: claimResult.reason || "delivery_claim_active",
      threadId,
      messageId,
      chatId,
      accountId,
    }, env).catch(() => {});
    return { skipped: { reason: claimResult.reason || "delivery_claim_active" } };
  }
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    phase: "mirror_claimed",
    threadId,
    messageId,
    chatId,
    accountId,
    deliveryType,
    routerUpdateType,
    claimKey: claimResult.claim?.claimKey,
    outboxId: intent?.outboxId,
    connectorOutboxJobId: outboxClaim.job.id,
  }, env).catch(() => {});
  await markRouterOutboxItem(intent?.outboxId, { status: "claimed" }, env).catch(() => null);

  try {
    const payload = await sendWhatsAppText({ chatId, text, accountId, attachments, config, env, fetchImpl });
    const delivery = {
      kind,
      deliveryType,
      ...(routerUpdateType ? { routerUpdateType } : {}),
      agentId: agentId || null,
      threadId: threadId || null,
      messageId,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(routerTraceId ? { routerTraceId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(intent?.outboxId ? { outboxId: intent.outboxId } : {}),
      connectorOutboxJobId: outboxClaim.job.id,
      chatId,
      accountId,
      textKey,
      deliveredAt: new Date().toISOString(),
      bridgeResponse: payload,
      ...(attachments ? { attachments } : {}),
    };
    outboundDeliveries.push(delivery);
    state.outboundDeliveries = outboundDeliveries;
    if (intent?.intentId) {
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, {
        status: "delivered",
        deliveredAt: delivery.deliveredAt,
        deliveryMessageId: delivery.messageId,
        error: "",
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
    }
    deliveredIds.add(messageId);
    deliveredTextKeys.add(textKey);
    batchTextKeys.add(textKey);
    await finishOutboundDeliveryClaim({ state, claim: claimResult.claim, filePath: claimResult.filePath, status: "delivered", delivery }, env, { persistState: writeWhatsAppState });
    await markConnectorOutboxJob(outboxClaim.job.id, {
      state: "delivered",
      deliveredAt: delivery.deliveredAt,
      brokerAck: payload,
      error: "",
    }, env).catch(() => null);
    await markRouterOutboxItem(intent?.outboxId, { status: "delivered", deliveredAt: delivery.deliveredAt }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "mirror_sent",
      threadId,
      messageId,
      chatId,
      accountId,
      deliveryType,
      routerUpdateType,
      outboxId: intent?.outboxId,
      connectorOutboxJobId: outboxClaim.job.id,
    }, env).catch(() => {});
    if (deliveryType === "final" || deliveryType === "router_update") {
      await recordRouterTraceEvent({
        routerTraceId,
        turnId,
        connector: "whatsapp",
        phase: "completed",
        threadId,
        messageId,
        chatId,
        accountId,
        deliveryType,
        terminal: true,
      }, env).catch(() => {});
    }
    return { delivery };
  } catch (error) {
    if (intent?.intentId) {
      const previousAttempts = Number(intent.attempts || 0) || 0;
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, {
        status: "pending",
        attempts: previousAttempts + 1,
        failedAt: new Date().toISOString(),
        error: error.message || String(error),
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
    }
    await finishOutboundDeliveryClaim({ state, claim: claimResult.claim, filePath: claimResult.filePath, status: "failed", error: error.message || String(error) }, env, { persistState: writeWhatsAppState }).catch(() => {});
    await markConnectorOutboxJob(outboxClaim.job.id, {
      state: "failed_retryable",
      failedAt: new Date().toISOString(),
      error: error.message || String(error),
    }, env).catch(() => null);
    await markRouterOutboxItem(intent?.outboxId, {
      status: "failed",
      attempts: Number(intent?.attempts || 0) + 1,
      error: error.message || String(error),
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "mirror_failed",
      threadId,
      messageId,
      chatId,
      accountId,
      deliveryType,
      routerUpdateType,
      outboxId: intent?.outboxId,
      connectorOutboxJobId: outboxClaim.job.id,
      error,
    }, env).catch(() => {});
    return { failure: { error } };
  }
}

function remoteMessagePatch(remoteResult = {}, fallback = {}) {
  const remoteMessage = remoteResult.message || {};
  const patch = {
    remoteBackend: remoteResult.backendId || fallback.remoteBackend || "",
    remoteThreadId: remoteResult.remoteThreadId || fallback.remoteThreadId || "",
    remoteRoutedAt: new Date().toISOString(),
    observedVia: "remote_runtime_forwarded",
  };
  const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
  const remoteState = pickString(remoteMessage.state);
  const remoteDeliveryState = pickString(remoteMessage.deliveryState);
  const remoteObservedVia = pickString(remoteMessage.observedVia);
  const remoteDeliveredAt = pickString(remoteMessage.deliveredAt);
  if (remoteMessageId) patch.remoteMessageId = remoteMessageId;
  if (remoteState) patch.state = remoteState;
  if (remoteDeliveryState) patch.deliveryState = remoteDeliveryState;
  if (remoteObservedVia) patch.observedVia = remoteObservedVia;
  if (remoteDeliveredAt) patch.deliveredAt = remoteDeliveredAt;
  return patch;
}

export async function routeWhatsAppInbound(input = {}, env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("whatsapp", env);
  const eventId = pickString(input.eventId, input.id, input.messageId);
  const initialChatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const initialAccountId = pickString(input.accountId);
  const initialTraceId = routerTraceIdFor({
    connector: "whatsapp",
    accountId: initialAccountId,
    chatId: initialChatId,
    eventId: eventId || "missing_event_id",
    fallbackId: `${initialAccountId}:${initialChatId}:missing_event_id`,
  });
  const initialTurnId = turnIdFor({ routerTraceId: initialTraceId });
  if (!eventId) {
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      phase: "skipped",
      reason: "missing_event_id",
      terminal: true,
    }, env).catch(() => {});
    throw badRequest("whatsapp_event_id_required");
  }
  await recordRouterTraceEvent({
    routerTraceId: initialTraceId,
    turnId: initialTurnId,
    connector: "whatsapp",
    accountId: initialAccountId,
    chatId: initialChatId,
    sourceEventId: eventId,
    phase: "received",
  }, env).catch(() => {});

  const state = await readWhatsAppState(env);
  const existing = (state.inboundEvents || []).find((event) => event.eventId === eventId);
  if (existing) {
    await recordRouterTraceEvent({
      routerTraceId: pickString(existing.routerTraceId, initialTraceId),
      turnId: pickString(existing.turnId, initialTurnId),
      connector: "whatsapp",
      accountId: pickString(existing.accountId, initialAccountId),
      chatId: pickString(existing.chatId, initialChatId),
      sourceEventId: eventId,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
      phase: "skipped",
      reason: "duplicate_event_id",
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({ type: "whatsapp_inbound_duplicate", eventId, routerTraceId: pickString(existing.routerTraceId, initialTraceId), agentId: existing.agentId || null, threadId: existing.threadId || null, messageId: existing.messageId }, env);
    return {
      duplicate: true,
      event: existing,
      agentId: existing.agentId || null,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
    };
  }

  let threadRoute = await routeThread(input, config, env);
  if (!threadRoute.threadId) threadRoute = await routeAutoProvisionedThread(input, config, env);
  const threadId = threadRoute.threadId;
  const agentId = threadId ? "" : routeAgentId(input, config);
  if (!threadId && !agentId) {
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      sourceEventId: eventId,
      phase: "skipped",
      reason: "missing_target",
      terminal: true,
    }, env).catch(() => {});
    throw badRequest("whatsapp_target_required");
  }

  const text = pickString(input.text, input.body, input.message);
  const promptFile = pickString(input.promptFile);
  if (!text && !promptFile) {
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      sourceEventId: eventId,
      threadId: threadId || "",
      phase: "skipped",
      reason: "missing_text",
      terminal: true,
    }, env).catch(() => {});
    throw badRequest("message_text_required");
  }

  const chatId = initialChatId;
  const from = pickString(input.from, input.sender, input.author);
  const accountId = pickString(input.accountId, threadRoute.binding?.outboundAccountId);
  const routerTraceId = initialTraceId;
  const turnId = initialTurnId;
  const messageInput = {
    role: "user",
    source: "whatsapp_inbound",
    originSurface: "whatsapp",
    originTransport: "whatsapp-local-bridge",
    connector: "whatsapp",
    externalId: eventId,
    sourceEventId: eventId,
    routerTraceId,
    turnId,
    chatId,
    from,
    accountId,
    text,
    promptFile,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
  };
  let thread = threadId ? (await listThreads(env)).find((item) => item.id === threadId || item.name === threadId || item.bindingName === threadId) : null;
  thread = await ensureApiAgentWhatsAppThread(thread, env);
  await ensureRouterTurn({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    eventId,
    threadId: thread?.id || threadId || "",
    state: "received",
    mirrorPolicy: "reply_to_source",
  }, env).catch(() => null);
  if (threadId && thread && googleWorkspaceConnectCommand(text)) {
    const message = await appendThreadMessage(thread.id, {
      ...messageInput,
      role: "user",
      state: "queued",
      deliveryState: "pending_delivery",
      observedVia: "google_workspace_connect_command",
    }, env);
    const connect = await createGoogleWorkspaceConnectLink({
      principal: principalForThread(thread, env),
      thread,
      chatId,
      accountId,
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "google_workspace_connect",
      phase: "final_answer",
      text: connect.message,
      state: "completed",
      parentMessageId: message.id,
      connector: "whatsapp",
      routerTraceId,
      turnId,
      chatId,
      accountId,
      googleWorkspaceConnectId: connect.connectId,
      googleWorkspaceConnectExpiresAt: connect.expiresAt,
    }, env);
    const event = {
      eventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: "completed" }, env).catch(() => null);
    await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "routed" }, env).catch(() => {});
    await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "completed", reason: "google_workspace_connect", terminal: true }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_google_workspace_connect_link_created",
      eventId,
      threadId,
      messageId: message.id,
      chatId,
      userId: resourceOwnerUserId(thread, env),
    }, env);
    return {
      duplicate: false,
      handledCommand: "google_workspace_connect",
      googleWorkspaceConnect: true,
      connectId: connect.connectId,
      link: connect.link,
      expiresAt: connect.expiresAt,
      event,
      agentId: null,
      threadId,
      ownerUserId: resourceOwnerUserId(thread, env),
      autoProvisioned: threadRoute.autoProvisioned === true,
      createdThread: threadRoute.createdThread === true,
      userId: threadRoute.user?.id || null,
      message,
    };
  }
  const remoteRuntime = threadId && thread ? remoteWhatsAppRuntimeBinding(thread, env) : null;
  if (remoteRuntime) {
    let message = threadId
      ? await appendThreadMessage(thread.id, {
          ...messageInput,
          role: "user",
          state: "queued",
          deliveryState: "remote_forwarding",
          originTransport: "whatsapp-public-router",
          remoteBackend: remoteRuntime.backendId,
          remoteThreadId: remoteRuntime.remoteThreadId,
        }, env)
      : await enqueueAgentMessage(agentId, messageInput, env);
    const contentDuplicate = Boolean(message.duplicate);
    let remoteResult = null;
    if (!contentDuplicate && threadId) {
      try {
        remoteResult = await enqueueRemoteWhatsAppThreadInput({ thread, message, input: messageInput }, env, fetchImpl);
        message = await updateThreadMessage(thread.id, message.id, remoteMessagePatch(remoteResult, {
          remoteBackend: remoteRuntime.backendId,
          remoteThreadId: remoteRuntime.remoteThreadId,
        }), env).catch(() => message);
        await recordRouterTraceEvent({
          routerTraceId,
          turnId,
          connector: "whatsapp",
          accountId,
          chatId,
          sourceEventId: eventId,
          threadId,
          messageId: message.id,
          phase: "delivered_to_runtime",
          ownerProcess: remoteRuntime.backendId,
        }, env).catch(() => {});
      } catch (error) {
        message = await updateThreadMessage(thread.id, message.id, {
          state: "failed",
          deliveryState: "failed",
          observedVia: "remote_runtime_forward_failed",
          error: error.message || String(error),
          remoteBackend: remoteRuntime.backendId,
          remoteThreadId: remoteRuntime.remoteThreadId,
        }, env).catch(() => message);
        await appendEvent({
          type: "whatsapp_remote_runtime_forward_failed",
          eventId,
          threadId,
          messageId: message.id,
          chatId,
          remoteBackend: remoteRuntime.backendId,
          remoteThreadId: remoteRuntime.remoteThreadId,
          error: error.message || String(error),
        }, env).catch(() => {});
        await recordRouterTraceEvent({
          routerTraceId,
          turnId,
          connector: "whatsapp",
          accountId,
          chatId,
          sourceEventId: eventId,
          threadId,
          messageId: message.id,
          phase: "runtime_failed",
          ownerProcess: remoteRuntime.backendId,
          error,
          retryable: false,
        }, env).catch(() => {});
      }
    }
    const event = {
      eventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId: threadId || null,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
      remoteBackend: remoteRuntime.backendId,
      remoteThreadId: remoteRuntime.remoteThreadId,
      remoteMessageId: pickString(message.remoteMessageId, remoteResult?.message?.id, remoteResult?.message?.messageId),
    };
    if (contentDuplicate) event.duplicateReason = message.duplicateReason || "active_input";
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: contentDuplicate ? "skipped" : "queued" }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      threadId,
      messageId: message.id,
      phase: contentDuplicate ? "skipped" : "routed",
      reason: contentDuplicate ? event.duplicateReason : "",
      terminal: contentDuplicate,
    }, env).catch(() => {});
    await appendEvent({
      type: contentDuplicate ? "whatsapp_inbound_duplicate" : "whatsapp_remote_runtime_inbound_routed",
      eventId,
      routerTraceId,
      agentId: null,
      threadId: threadId || null,
      messageId: message.id,
      chatId,
      duplicateReason: contentDuplicate ? event.duplicateReason : "",
      remoteBackend: remoteRuntime.backendId,
      remoteThreadId: remoteRuntime.remoteThreadId,
    }, env);
    return {
      duplicate: contentDuplicate,
      remoteRuntime: true,
      remoteBackend: remoteRuntime.backendId,
      remoteThreadId: remoteRuntime.remoteThreadId,
      remote: remoteResult?.payload || null,
      event,
      agentId: null,
      threadId: threadId || null,
      ownerUserId: thread ? resourceOwnerUserId(thread, env) : null,
      autoProvisioned: threadRoute.autoProvisioned === true,
      createdThread: threadRoute.createdThread === true,
      userId: threadRoute.user?.id || null,
      message,
    };
  }
  const approvalReply = explicitWhatsAppApprovalReply(text);
  if (threadId && thread && isCodexAppServerThread(thread) && approvalReply && !threadHasActionableStoredPendingRequest(thread)) {
    const message = await appendThreadMessage(thread.id, {
      ...messageInput,
      role: "user",
      state: "completed",
      deliveryState: "ignored",
      deliveredAt: new Date().toISOString(),
      observedVia: "whatsapp_codex_app_server_approval_not_pending",
    }, env);
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "orkestr_runtime",
      phase: "final_answer",
      text: `No Codex approval request is pending for this thread, so I did not forward "${text}" to Codex.`,
      state: "completed",
      parentMessageId: message.id,
      connector: "whatsapp",
      routerTraceId,
      turnId,
      chatId,
      accountId,
    }, env);
    const event = {
      eventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: "skipped" }, env).catch(() => null);
    await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "skipped", reason: "approval_not_pending", terminal: true }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_approval_command_without_pending_request",
      eventId,
      threadId,
      messageId: message.id,
      action: approvalReply.action,
      chatId,
    }, env);
    return {
      duplicate: false,
      event,
      agentId: null,
      threadId,
      ownerUserId: resourceOwnerUserId(thread, env),
      autoProvisioned: threadRoute.autoProvisioned === true,
      createdThread: threadRoute.createdThread === true,
      userId: threadRoute.user?.id || null,
      message,
      approvalHandled: false,
      reason: "no_pending_request",
    };
  }
  let message = threadId
    ? await enqueueThreadInputForPrincipal(threadId, messageInput, principalForThread(thread, env), env)
    : await enqueueAgentMessage(agentId, messageInput, env);
  const contentDuplicate = Boolean(message.duplicate);
  if (threadId && !contentDuplicate) {
    message = await annotateInitialThreadQueueNotice(threadId, message, env);
  }
  const event = {
    eventId,
    routerTraceId,
    turnId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    from,
    accountId,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
  if (contentDuplicate) event.duplicateReason = message.duplicateReason || "active_input";
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeWhatsAppState(state, env);
  await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId: threadId || "", messageId: message.id, state: contentDuplicate ? "skipped" : "queued" }, env).catch(() => null);
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    sourceEventId: eventId,
    threadId: threadId || "",
    messageId: message.id,
    phase: contentDuplicate ? "skipped" : "routed",
    reason: contentDuplicate ? event.duplicateReason : "",
    terminal: contentDuplicate,
  }, env).catch(() => {});
  if (!contentDuplicate) {
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      threadId: threadId || "",
      messageId: message.id,
      phase: "queued",
    }, env).catch(() => {});
  }
  await appendEvent({
    type: contentDuplicate ? "whatsapp_inbound_duplicate" : "whatsapp_inbound_routed",
    eventId,
    routerTraceId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    duplicateReason: contentDuplicate ? event.duplicateReason : "",
  }, env);
  if (thread && !contentDuplicate && input.deferApiAgentAutoRun !== true) kickWhatsAppApiAgentThread(thread, env);
  return {
    duplicate: contentDuplicate,
    event,
    agentId: agentId || null,
    threadId: threadId || null,
    ownerUserId: thread ? resourceOwnerUserId(thread, env) : null,
    autoProvisioned: threadRoute.autoProvisioned === true,
    createdThread: threadRoute.createdThread === true,
    userId: threadRoute.user?.id || null,
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

/**
 * @param {{ chatId?: string, text?: string, accountId?: string, attachments?: Array<Record<string, unknown>>, config?: Record<string, unknown> | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} [options]
 */
export async function sendWhatsAppText({ chatId = "", text = "", accountId = "", attachments = [], config = null, env = process.env, fetchImpl = fetch } = {}) {
  const resolvedConfig = config || await readConnectorConfig("whatsapp", env).catch(() => ({}));
  const bridgeUrl = configuredBridgeUrl(resolvedConfig, env);
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map((attachment) => ({
        ...attachment,
        path: String(attachment?.path || "").trim(),
      })).filter((attachment) => attachment.path)
    : [];
  if (!bridgeUrl && bridgeMode(resolvedConfig, env) === "local") {
    return sendLocalWhatsAppMessage({ chatId, text, accountId, attachments: normalizedAttachments, env });
  }
  if (!bridgeUrl) throw badRequest("whatsapp_bridge_not_configured");
  const headers = { "content-type": "application/json", ...bridgeAuthHeaders(resolvedConfig, env) };
  const response = await fetchImpl(whatsappBridgeEndpointUrl(bridgeUrl, normalizedAttachments.length ? "/send-media" : "/send-text"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: chatId,
      text,
      ...(accountId ? { accountId } : {}),
      ...(normalizedAttachments.length ? { paths: normalizedAttachments.map((attachment) => attachment.path) } : {}),
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

async function annotateInitialThreadQueueNotice(threadId, message, env = process.env) {
  if (!threadId || !message?.id || message.duplicate) return message;
  const deliveryState = initialQueueDeliveryState(await runtimeStatus(threadId, env).catch(() => null), message);
  if (!deliveryState) return message;
  return updateThreadMessage(threadId, message.id, { deliveryState }, env).catch(() => message);
}

function whatsappDeliverySkippedSampleLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_DELIVERY_SKIPPED_SAMPLE_LIMIT || 20);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 20;
}

function whatsappDeliverySkippedReason(item = {}) {
  return String(item?.reason || item?.status || item?.error || "unknown").trim() || "unknown";
}

function createWhatsAppDeliverySkippedCollector(env = process.env) {
  const sampleLimit = whatsappDeliverySkippedSampleLimit(env);
  const items = [];
  const counts = {};
  const sampledCounts = {};
  return {
    push(item = {}) {
      const reason = whatsappDeliverySkippedReason(item);
      counts[reason] = (counts[reason] || 0) + 1;
      sampledCounts[reason] = sampledCounts[reason] || 0;
      if (sampledCounts[reason] >= sampleLimit) return;
      sampledCounts[reason] += 1;
      items.push(item);
    },
    items() {
      return items;
    },
    summary() {
      const count = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return {
        count,
        sampled: items.length,
        omitted: Math.max(0, count - items.length),
        reasons: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
      };
    },
  };
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
  await syncRemoteWhatsAppThreadMessages(env, fetchImpl).catch((error) =>
    appendEvent({ type: "whatsapp_remote_runtime_sync_failed", error: error.message || String(error) }, env).catch(() => null)
  );
  const state = await readWhatsAppState(env);
  const deliveredIds = new Set((state.outboundDeliveries || []).map((delivery) => delivery.messageId));
  const deliveredTextKeys = new Set((state.outboundDeliveries || []).map((delivery) => delivery.textKey).filter(Boolean));
  const batchTextKeys = new Set();
  const outboundDeliveries = [...(state.outboundDeliveries || [])];
  const outboundIntents = [...(state.outboundIntents || [])];
  const delivered = [];
  const skipped = createWhatsAppDeliverySkippedCollector(env);
  const failed = [];

  const messageSets = [
    ...(await listMessageSets(env)).map((set) => ({ ...set, kind: "agent" })),
    ...(await listThreadMessageSets(env)).map((set) => ({ ...set, kind: "thread" })),
  ];
  await recoverParentsForAlreadyMirroredReplies(messageSets, deliveredIds, outboundDeliveries, state, env);
  for (const { agentId, threadId, thread, messages, kind } of messageSets) {
    const messageSetKey = outboundMirrorMessageSetKey({ kind, agentId, threadId });
    for (const [messageIndex, message] of messages.entries()) {
      const messageCursor = outboundMirrorMessageCursor(message, messageIndex);
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
          (completedAssistantReplyForParent(messages, message, chatId, state) || latestProgressReplyForParent(messages, message.id, env))
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
        const result = await sendWhatsAppOutboundCandidate({
          state,
          outboundDeliveries,
          outboundIntents,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
          messageSetKey,
          messageCursor,
          message,
          thread,
          kind,
          deliveryType: "router_update",
          routerUpdateType: routerUpdateTarget.routerUpdateType,
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          chatId,
          accountId,
          textKey,
          text,
          config,
          env,
          fetchImpl,
        });
        if (result.skipped) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
          continue;
        }
        if (result.delivery) {
          delivered.push(result.delivery);
          await appendEvent({
            type: "whatsapp_outbound_router_update_delivered",
            routerUpdateType: routerUpdateTarget.routerUpdateType,
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: message.id,
            chatId,
          }, env);
        } else if (result.failure) {
          const error = result.failure.error;
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
        const result = await sendWhatsAppOutboundCandidate({
          state,
          outboundDeliveries,
          outboundIntents,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
          messageSetKey,
          messageCursor,
          message,
          thread,
          kind,
          deliveryType: "mode_queued",
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          chatId,
          accountId,
          textKey,
          text,
          config,
          env,
          fetchImpl,
        });
        if (result.skipped) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
          continue;
        }
        if (result.delivery) {
          delivered.push(result.delivery);
          await appendEvent({ type: "whatsapp_outbound_mode_queued_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } else if (result.failure) {
          const error = result.failure.error;
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
        let queueMessage = message;
        let queueMessages = messages;
        let queueTarget = queuedInputTarget;
        let chatId = queueTarget.chatId;
        let accountId = kind === "thread" ? queueTarget.accountId : pickString(queueMessage.accountId, queueTarget.accountId);
        if (kind === "thread") {
          queueMessages = await listThreadMessages(threadId, env).catch(() => messages);
          queueMessage = queueMessages.find((entry) => entry.id === message.id) || message;
          queueTarget = queuedInputWhatsAppDeliveryTarget(queueMessage, thread, state);
          if (!queueTarget) {
            await skipWhatsAppOutboundCandidate({
              state,
              outboundIntents,
              kind,
              deliveryType: "queue_notice",
              agentId,
              threadId,
              messageId: deliveryId,
              sourceMessageId: message.id,
              chatId,
              accountId,
              message,
              reason: "queue_notice_obsolete",
              env,
            });
            skipped.push({ agentId, threadId, messageId: message.id, reason: "queue_notice_obsolete" });
            continue;
          }
          chatId = queueTarget.chatId;
          accountId = pickString(queueTarget.accountId, queueMessage.accountId, accountId);
        }
        if (completedAssistantReplyForParent(queueMessages, queueMessage, chatId, state) || latestProgressReplyForParent(queueMessages, queueMessage.id, env)) {
          await skipWhatsAppOutboundCandidate({
            state,
            outboundIntents,
            kind,
            deliveryType: "queue_notice",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message: queueMessage,
            reason: "assistant_output_available",
            env,
          });
          skipped.push({ agentId, threadId, messageId: message.id, reason: "assistant_output_available" });
          continue;
        }
        const text = appendWhatsAppDebugFooter(formatWhatsAppQueueNotice(queueMessage, queueTarget.reason), {
          message: queueMessage,
          thread,
          messages: queueMessages,
          deliveryType: "queue_notice",
          env,
        });
        const textKey = deliveryTextKey(chatId, `${deliveryId}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }
        const result = await sendWhatsAppOutboundCandidate({
          state,
          outboundDeliveries,
          outboundIntents,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
          messageSetKey,
          messageCursor,
          message: queueMessage,
          thread,
          kind,
          deliveryType: "queue_notice",
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          chatId,
          accountId,
          textKey,
          text,
          config,
          env,
          fetchImpl,
        });
        if (result.skipped) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
          continue;
        }
        if (result.delivery) {
          delivered.push(result.delivery);
          await appendEvent({ type: "whatsapp_outbound_queue_notice_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } else if (result.failure) {
          const error = result.failure.error;
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
        const result = await sendWhatsAppOutboundCandidate({
          state,
          outboundDeliveries,
          outboundIntents,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
          messageSetKey,
          messageCursor,
          message,
          thread,
          kind,
          deliveryType: "delivery_error",
          agentId,
          threadId,
          messageId: message.id,
          chatId,
          accountId,
          textKey,
          text,
          config,
          env,
          fetchImpl,
        });
        if (result.skipped) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
          continue;
        }
        if (result.delivery) {
          delivered.push(result.delivery);
          await appendEvent({ type: "whatsapp_outbound_delivery_error_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } else if (result.failure) {
          const error = result.failure.error;
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      if (message.role !== "assistant" || message.state !== "completed" || deliveredIds.has(message.id)) continue;
      if (shouldMirrorWhatsAppProgress(message, env)) {
        const parent = messages.find((entry) => entry.id === message.parentMessageId);
        const whatsappOrigin =
          parent?.connector === "whatsapp" ||
          parent?.source === "whatsapp_inbound" ||
          message.connector === "whatsapp" ||
          boundThreadWhatsAppAssistantOrigin({ message, thread, kind });
        if (!whatsappOrigin) continue;
        const liveRecovery = canRecoverLiveWhatsAppOutboundIntent({
          state,
          messageSetKey,
          messageCursor,
          message,
          parent,
          thread,
          kind,
          env,
        });
        if (!liveRecovery && staleUntrackedWhatsAppProgress(message, outboundDeliveries, env)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
          continue;
        }
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
          continue;
        }
        const chatId = pickString(message.chatId, parent?.chatId, thread?.binding?.chatId);
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

        const textKey = deliveryTextKey(chatId, `progress:${message.id}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }

        const result = await sendWhatsAppOutboundCandidate({
          state,
          outboundDeliveries,
          outboundIntents,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
          messageSetKey,
          messageCursor,
          message,
          parent,
          thread,
          kind,
          deliveryType: "progress",
          agentId,
          threadId,
          messageId: message.id,
          parentMessageId: message.parentMessageId,
          chatId,
          accountId,
          textKey,
          text,
          config,
          env,
          fetchImpl,
        });
        if (result.skipped) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
          continue;
        }
        if (result.delivery) {
          delivered.push(result.delivery);
          await appendEvent({ type: "whatsapp_outbound_progress_delivered", agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId }, env);
        } else if (result.failure) {
          const error = result.failure.error;
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
          failed.push(failure);
          await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
        }
        continue;
      }
      if (!shouldMirrorWhatsAppReply(message)) continue;
      const parent = messages.find((entry) => entry.id === message.parentMessageId);
      const whatsappOrigin =
        parent?.connector === "whatsapp" ||
        parent?.source === "whatsapp_inbound" ||
        message.connector === "whatsapp" ||
        boundThreadWhatsAppAssistantOrigin({ message, thread, kind });
      if (!whatsappOrigin) continue;
      const liveRecovery = canRecoverLiveWhatsAppOutboundIntent({
        state,
        messageSetKey,
        messageCursor,
        message,
        parent,
        thread,
        kind,
        env,
      });
      if (!liveRecovery && staleUntrackedWhatsAppReply(message, outboundDeliveries, env)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
        continue;
      }
      if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
        continue;
      }

      const chatId = pickString(message.chatId, parent?.chatId, thread?.binding?.chatId);
      const accountId = kind === "thread"
        ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
        : pickString(message.accountId, parent?.accountId);
      if (supersededRuntimeInterruptionNotice(messages, message, chatId, state)) {
        await skipWhatsAppOutboundCandidate({
          state,
          outboundIntents,
          kind,
          deliveryType: "router_update",
          agentId,
          threadId,
          messageId: message.id,
          parentMessageId: message.parentMessageId,
          chatId,
          accountId,
          message,
          parent,
          reason: "superseded_runtime_interruption",
          env,
        });
        skipped.push({ agentId, threadId, messageId: message.id, reason: "superseded_runtime_interruption" });
        continue;
      }
      const preparedOutbound = await prepareWhatsAppTableAttachments(pickString(message.text), {
        env,
        messageId: message.id,
      });
      const sourceMessageAttachments = Array.isArray(message.attachments) ? message.attachments : [];
      const remoteMaterialized = await materializeRemoteWhatsAppAttachments({
        thread,
        message,
        attachments: sourceMessageAttachments,
        env,
        fetchImpl,
      });
      const resolvedOutboundAttachments = await resolveThreadAttachments({
        thread,
        text: pickString(message.text),
        attachments: [
          ...sourceMessageAttachments.filter((attachment) => !isRemoteThreadAttachmentDescriptor(attachment)),
          ...remoteMaterialized.attachments,
          ...preparedOutbound.attachments,
        ],
        env,
      });
      const attachments = resolvedOutboundAttachments.attachments;
      const deliveryType = message.source === "orkestr_runtime" ? "router_update" : "final";
      const formattedText = formatWhatsAppOutboundText(redactDeniedThreadAttachmentPaths(preparedOutbound.text, { thread, env }));
      const text = appendWhatsAppDebugFooter(appendRemoteAttachmentFailureNotes(formattedText, remoteMaterialized.skipped), {
        message,
        thread,
        messages,
        deliveryType,
        env,
      });
      if (!chatId || !text) {
        skipped.push({ agentId, messageId: message.id, reason: !chatId ? "missing_chat_id" : "missing_text" });
        continue;
      }
      const attachmentKey = attachments.map(attachmentDeliveryKey).filter(Boolean).join("\n");
      const replyTurnKey = pickString(message.parentMessageId, message.id);
      const textKey = deliveryTextKey(chatId, attachmentKey ? `${replyTurnKey}\n${text}\nattachments:\n${attachmentKey}` : `${replyTurnKey}\n${text}`);
      if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
        continue;
      }
      await persistMessageAttachmentsIfChanged(threadId, message, attachments, env);

      const result = await sendWhatsAppOutboundCandidate({
        state,
        outboundDeliveries,
        outboundIntents,
        deliveredIds,
        deliveredTextKeys,
        batchTextKeys,
        messageSetKey,
        messageCursor,
        message,
        parent,
        thread,
        kind,
        deliveryType,
        agentId,
        threadId,
        messageId: message.id,
        parentMessageId: message.parentMessageId,
        chatId,
        accountId,
        textKey,
        text,
        attachments,
        config,
        env,
        fetchImpl,
      });
      if (result.skipped) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: result.skipped.reason });
        continue;
      }
      if (result.delivery) {
        const delivery = result.delivery;
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
      } else if (result.failure) {
        const error = result.failure.error;
        const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId, error: error.message || String(error) };
        failed.push(failure);
        await appendEvent({ type: "whatsapp_outbound_failed", ...failure }, env);
      }
    }
  }

  const cursorsChanged = advanceWhatsAppOutboundMirrorCursors(state, messageSets);
  if (delivered.length || cursorsChanged) {
    state.outboundDeliveries = outboundDeliveries;
    state.outboundIntents = outboundIntents;
    await writeWhatsAppState(state, env);
  }
  return { delivered, skipped: skipped.items(), skippedSummary: skipped.summary(), failed };
}

export async function deliverWhatsAppReplies(env = process.env, fetchImpl = fetch) {
  return whatsappOutboundMirrorWorker.run(() => deliverWhatsAppRepliesOnce(env, fetchImpl));
}
