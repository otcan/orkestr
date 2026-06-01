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
  whatsappDisplayName,
  whatsappInboundThreadMatchesBinding,
} from "./whatsapp-inbound-routing.js";
import {
  acquireOutboundDeliveryClaim,
  deliveryTextKey,
  finishOutboundDeliveryClaim,
  outboundDeliveryKey,
  pruneOutboundDeliveryClaims,
} from "./whatsapp-delivery-ledger.js";
import {
  codexAssistantSource,
  shouldMirrorWhatsAppProgress,
  shouldMirrorWhatsAppReply,
} from "./whatsapp-mirror-policy.js";
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

async function externalBridgeAccounts(bridgeUrl, healthPayload, fetchImpl, headers = {}) {
  if (Array.isArray(healthPayload?.accounts)) return healthPayload.accounts;
  try {
    const dashboard = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/api/dashboard"), fetchImpl, { headers });
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
  const headers = bridgeAuthHeaders(config, env);
  try {
    const health = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/health"), fetchImpl, { headers });
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
      const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl, headers);
      return {
        state: "paired",
        summary: "WhatsApp bridge is reachable and paired.",
        bridgeUrl,
        health: health.payload,
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
    if (binding.enabled === false) return false;
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
  void processApiAgentThreadInput(thread.id, env)
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
  const explicit = pickString(
    input.threadId,
    input.targetThreadId,
    chatId ? routes[chatId] : "",
    config.defaultThreadId,
  );
  if (explicit) return { threadId: explicit, binding: null };
  if (!chatId) return { threadId: "", binding: null };
  const threads = await listThreads(env);
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

function mergeWhatsAppState(existing = {}, next = {}, env = process.env) {
  return {
    ...existing,
    ...next,
    inboundEvents: mergeByKey(existing.inboundEvents, next.inboundEvents, (event) => pickString(event.eventId)).slice(-500),
    outboundDeliveries: mergeByKey(existing.outboundDeliveries, next.outboundDeliveries, outboundDeliveryKey)
      .slice(-whatsappOutboundDeliveryRetentionLimit(env)),
    outboundDeliveryClaims: pruneOutboundDeliveryClaims(
      mergeByKey(existing.outboundDeliveryClaims, next.outboundDeliveryClaims, (claim) => pickString(claim.claimKey)),
      { env, retentionLimit: whatsappOutboundDeliveryRetentionLimit(env) },
    ),
    updatedAt: new Date().toISOString(),
  };
}

async function writeWhatsAppState(state, env) {
  const paths = dataPaths(env);
  const existing = await readJson(paths.whatsapp, { inboundEvents: [], outboundDeliveries: [], outboundDeliveryClaims: [] }).catch(() => ({}));
  await writeJson(paths.whatsapp, mergeWhatsAppState(existing, state, env));
}

async function sendClaimedWhatsAppText({
  state,
  outboundDeliveries,
  deliveredIds,
  deliveredTextKeys,
  batchTextKeys,
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
  config,
  env,
  fetchImpl,
} = {}) {
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
  if (!claimResult.acquired) return { skipped: { reason: claimResult.reason || "delivery_claim_active" } };

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
      chatId,
      accountId,
      textKey,
      deliveredAt: new Date().toISOString(),
      bridgeResponse: payload,
      ...(attachments ? { attachments } : {}),
    };
    outboundDeliveries.push(delivery);
    state.outboundDeliveries = outboundDeliveries;
    deliveredIds.add(messageId);
    deliveredTextKeys.add(textKey);
    batchTextKeys.add(textKey);
    await finishOutboundDeliveryClaim({ state, claim: claimResult.claim, filePath: claimResult.filePath, status: "delivered", delivery }, env, { persistState: writeWhatsAppState });
    return { delivery };
  } catch (error) {
    await finishOutboundDeliveryClaim({ state, claim: claimResult.claim, filePath: claimResult.filePath, status: "failed", error: error.message || String(error) }, env, { persistState: writeWhatsAppState }).catch(() => {});
    return { failure: { error } };
  }
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

  let threadRoute = await routeThread(input, config, env);
  if (!threadRoute.threadId) threadRoute = await routeAutoProvisionedThread(input, config, env);
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
    originSurface: "whatsapp",
    originTransport: "whatsapp-local-bridge",
    connector: "whatsapp",
    externalId: eventId,
    chatId,
    from,
    accountId,
    text,
    promptFile,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
  };
  let thread = threadId ? (await listThreads(env)).find((item) => item.id === threadId || item.name === threadId || item.bindingName === threadId) : null;
  thread = await ensureApiAgentWhatsAppThread(thread, env);
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
      chatId,
      accountId,
    }, env);
    const event = {
      eventId,
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
  await appendEvent({
    type: contentDuplicate ? "whatsapp_inbound_duplicate" : "whatsapp_inbound_routed",
    eventId,
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

async function sendWhatsAppText({ chatId, text, accountId, attachments = [], config, env, fetchImpl }) {
  const bridgeUrl = configuredBridgeUrl(config, env);
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map((attachment) => ({
        ...attachment,
        path: String(attachment?.path || "").trim(),
      })).filter((attachment) => attachment.path)
    : [];
  if (!bridgeUrl && bridgeMode(config, env) === "local") {
    return sendLocalWhatsAppMessage({ chatId, text, accountId, attachments: normalizedAttachments, env });
  }
  if (!bridgeUrl) throw badRequest("whatsapp_bridge_not_configured");
  const headers = { "content-type": "application/json", ...bridgeAuthHeaders(config, env) };
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
        const result = await sendClaimedWhatsAppText({
          state,
          outboundDeliveries,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
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
        const result = await sendClaimedWhatsAppText({
          state,
          outboundDeliveries,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
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
        const result = await sendClaimedWhatsAppText({
          state,
          outboundDeliveries,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
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
        const result = await sendClaimedWhatsAppText({
          state,
          outboundDeliveries,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
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
      if (shouldMirrorWhatsAppProgress(message)) {
        const parent = messages.find((entry) => entry.id === message.parentMessageId);
        const whatsappOrigin =
          parent?.connector === "whatsapp" ||
          parent?.source === "whatsapp_inbound" ||
          message.connector === "whatsapp" ||
          boundThreadWhatsAppAssistantOrigin({ message, thread, kind });
        if (!whatsappOrigin) continue;
        if (staleUntrackedWhatsAppProgress(message, outboundDeliveries, env)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
          continue;
        }
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
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

        const textKey = deliveryTextKey(chatId, `progress:${message.id}\n${text}`);
        if (deliveredTextKeys.has(textKey) || batchTextKeys.has(textKey)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "duplicate_text" });
          continue;
        }

        const result = await sendClaimedWhatsAppText({
          state,
          outboundDeliveries,
          deliveredIds,
          deliveredTextKeys,
          batchTextKeys,
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
      if (staleUntrackedWhatsAppReply(message, outboundDeliveries, env)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
        continue;
      }
      if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "mirroring_disabled" });
        continue;
      }

      const chatId = pickString(message.chatId, parent?.chatId);
      const preparedOutbound = await prepareWhatsAppTableAttachments(pickString(message.text), {
        env,
        messageId: message.id,
      });
      const attachments = preparedOutbound.attachments;
      const deliveryType = message.source === "orkestr_runtime" ? "router_update" : "final";
      const text = appendWhatsAppDebugFooter(formatWhatsAppOutboundText(preparedOutbound.text), {
        message,
        thread,
        messages,
        deliveryType,
        env,
      });
      const accountId = kind === "thread"
        ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
        : pickString(message.accountId, parent?.accountId);
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

      const result = await sendClaimedWhatsAppText({
        state,
        outboundDeliveries,
        deliveredIds,
        deliveredTextKeys,
        batchTextKeys,
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

  if (delivered.length) {
    state.outboundDeliveries = outboundDeliveries;
    await writeWhatsAppState(state, env);
  }
  return { delivered, skipped, failed };
}

export async function deliverWhatsAppReplies(env = process.env, fetchImpl = fetch) {
  return whatsappOutboundMirrorWorker.run(() => deliverWhatsAppRepliesOnce(env, fetchImpl));
}
