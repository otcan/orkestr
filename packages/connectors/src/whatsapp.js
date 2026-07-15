import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { enqueueAgentMessage, updateAgentMessage } from "../../core/src/messages.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { adminPrincipal, userPrincipal } from "../../core/src/principal.js";
import { appServerStateFromStatus } from "../../core/src/codex-app-server-common.js";
import { clearRuntimeLeasesForThread, resolveCodexThreadMetadata, runtimeStatus } from "../../core/src/runtime-leases.js";
import { classifyApprovalReply } from "../../core/src/runtime-settings.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../../core/src/tenant-api-agent.js";
import { parseThreadInputCommand } from "../../core/src/thread-commands.js";
import { isRemoteThreadAttachmentDescriptor, redactDeniedThreadAttachmentPaths, resolveThreadAttachments } from "../../core/src/thread-attachments.js";
import { approveDesktopShareChallenge } from "../../core/src/desktop-shares.js";
import {
  ensureRouterTurn,
  markRouterOutboxItem,
  planRouterOutboxItem,
  recordRouterTraceEvent,
  routerTraceIdFor,
  turnIdFor,
} from "../../core/src/router-traces.js";
import { appendThreadMessage, createThreadForPrincipal, enqueueThreadInputForPrincipal, getThread, listThreadMessages, listThreads, listThreadsForPrincipal, updateThread, updateThreadMessage } from "../../core/src/threads.js";
import { adminUserId, findOrCreateExternalUser, getUser, normalizeUserId } from "../../core/src/users.js";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  getLocalWhatsAppBridgeStatus,
  localWhatsAppBridgeBasePath,
  listLocalWhatsAppChatMessages,
  listLocalWhatsAppChatParticipants,
  sendLocalWhatsAppMessage,
  syncLocalWhatsAppTypingTargets,
} from "./whatsapp-local-bridge.js";
import { routerUpdateWhatsAppDeliveryTarget } from "./whatsapp-router-updates.js";
import { attachmentDeliveryKey, prepareWhatsAppTableAttachments } from "./whatsapp-table-attachments.js";
import { appendWhatsAppDebugFooter, formatWhatsAppOutboundText, stripWhatsAppDebugFooter } from "./whatsapp-formatting.js";
import {
  bindingAccountIds,
  isWhatsAppGroupChatId,
  whatsappAutoThreadBinding,
  whatsappBindingIsRouteEligible,
  whatsappDisplayName,
  whatsappInboundThreadMatchesBinding,
} from "./whatsapp-inbound-routing.js";
import {
  addWhatsAppInboundSecurityBlock,
  evaluateWhatsAppInboundSecurity,
} from "./whatsapp-inbound-security.js";
import {
  claimConnectorOutboxJob,
  connectorOutboxTerminalState,
  connectorOutboxRetryBackoffMs,
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
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
  outboundMirrorCursorMap,
  outboundMirrorMessageCursor,
  outboundMirrorMessageSetKey,
  whatsappLiveOutputRecoveryWindowMs,
} from "./whatsapp-outbound-intents.js";
import {
  codexAssistantSource,
  shouldMirrorWhatsAppProgress,
  shouldMirrorWhatsAppReply,
  threadSuppressesWhatsAppUpdates,
} from "./whatsapp-mirror-policy.js";
import {
  enqueueRemoteWhatsAppThreadInput,
  remoteWhatsAppRuntimeBinding,
  syncRemoteWhatsAppThreadMessages,
} from "./whatsapp-remote-runtime.js";
import { resolveWhatsAppBinding } from "./whatsapp-account-bindings.js";
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
import {
  canonicalWhatsAppAccountId,
  findWhatsAppAccountByAnyId,
  whatsappAccountLookupKeys,
} from "./whatsapp-account-identity.js";
import { maybeApprovePairingChallengeFromWhatsApp, maybeBindApprovedBrokerChat } from "./whatsapp-security-approval.js";

export { formatWhatsAppOutboundText } from "./whatsapp-formatting.js";
export { initialQueueDeliveryState } from "./whatsapp-outbound-mirror.js";

const whatsappOutboundMirrorWorker = createWhatsAppOutboundMirrorWorker();
let whatsappDeliveryIdleCache = null;
let whatsappDeliveryRunCache = null;
const whatsappMirrorMessageFileCache = new Map();
const suppressibleWhatsAppUpdateDeliveryTypes = new Set([
  "delivery_error",
  "mode_queued",
  "mutation_notice",
  "progress",
  "queue_notice",
  "router_update",
]);

function positiveInteger(value, fallback, minimum = 1) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function whatsappBridgeStatusTimeoutMs(env = process.env) {
  return positiveInteger(
    pickString(
      env.ORKESTR_WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS,
      env.WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS,
      env.ORKESTR_WHATSAPP_BRIDGE_FETCH_TIMEOUT_MS,
      env.WHATSAPP_BRIDGE_FETCH_TIMEOUT_MS,
    ),
    45_000,
    1,
  );
}

async function fetchWithTimeout(url, fetchImpl, fetchOptions = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error(`WhatsApp bridge request timeout after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  try {
    return await fetchImpl(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, fetchImpl, options = {}) {
  const { env, timeoutMs, ...fetchOptions } = options;
  const response = await fetchWithTimeout(url, fetchImpl, fetchOptions, positiveInteger(timeoutMs, whatsappBridgeStatusTimeoutMs(env), 1));
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function fetchOk(url, fetchImpl, options = {}) {
  const { env, timeoutMs, ...fetchOptions } = options;
  try {
    const response = await fetchWithTimeout(url, fetchImpl, fetchOptions, positiveInteger(timeoutMs, whatsappBridgeStatusTimeoutMs(env), 1));
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
      payload?.accounts?.some?.((account) =>
        (account.ready || account.state === "ready" || account.status === "ready") &&
          account.chatOpsReady !== false &&
          account.runtimeUsable !== false
      ),
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

function bridgeClientId(config = {}, env = process.env) {
  return pickString(
    env.ORKESTR_WA_SERVICE_CLIENT_ID,
    env.ORKESTR_WHATSAPP_BRIDGE_CLIENT_ID,
    env.WHATSAPP_BRIDGE_CLIENT_ID,
    env.ORKESTR_WHATSAPP_BRIDGE_INSTANCE_ID,
    env.WHATSAPP_BRIDGE_INSTANCE_ID,
    env.ORKESTR_INSTANCE_ID,
    env.ORKESTR_RELEASE_INSTANCE_ID,
    env.ORKESTR_DEMO_INSTANCE_ID,
    config.bridgeClientId,
    config.clientId,
    config.instanceId,
  );
}

export function bridgeRequestHeaders(config = {}, env = process.env, base = {}) {
  const clientId = bridgeClientId(config, env);
  return {
    ...base,
    ...bridgeAuthHeaders(config, env),
    ...(clientId ? { "x-orkestr-instance-id": clientId } : {}),
  };
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
  if (["relay", "parent-forward", "control-plane-forward", "control-plane", "controlplane", "broker"].includes(mode)) {
    return String(env.WHATSAPP_BRIDGE_URL || config.bridgeUrl || "").trim() ? "external" : "local";
  }
  return mode === "external" && externalBridgeEnabled(env) ? "external" : "local";
}

function bridgeModeRaw(config = {}, env = process.env) {
  return String(env.WHATSAPP_BRIDGE_MODE || config.bridgeMode || "").trim().toLowerCase();
}

function explicitBoolean(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

function externalBridgeCanReadLocalAttachmentPaths(config = {}, env = process.env) {
  const explicit = explicitBoolean(pickString(
    env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS,
    env.WHATSAPP_BRIDGE_LOCAL_ATTACHMENTS,
    config.externalBridgeLocalAttachments,
    config.localAttachments,
  ));
  if (explicit !== null) return explicit;
  const mode = bridgeModeRaw(config, env);
  if (["relay", "parent-forward", "control-plane-forward", "control-plane", "controlplane", "broker"].includes(mode)) return false;
  if (pickString(env.ORKESTR_TENANT_VM_ID, env.ORKESTR_TENANT_SLICE_ID, env.ORKESTR_DEMO_VM_ID)) return false;
  return true;
}

function externalBridgeInlineAttachmentMaxBytes(env = process.env) {
  const value = Number(
    env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_INLINE_ATTACHMENT_MAX_BYTES ||
      env.ORKESTR_WHATSAPP_INLINE_ATTACHMENT_MAX_BYTES ||
      env.ORKESTR_REMOTE_ARTIFACT_MAX_BYTES ||
      25 * 1024 * 1024,
  );
  return Number.isFinite(value) && value > 0 ? value : 25 * 1024 * 1024;
}

function safeBridgeAttachmentFilename(value = "", fallback = "attachment") {
  return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 240) || fallback;
}

async function prepareExternalBridgeInlineAttachments(attachments = [], env = process.env) {
  const maxBytes = externalBridgeInlineAttachmentMaxBytes(env);
  const prepared = [];
  const skipped = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const filePath = pickString(attachment.path, attachment.saved_path, attachment.filePath, attachment.localPath);
    if (!filePath) continue;
    const filename = safeBridgeAttachmentFilename(pickString(attachment.filename, attachment.name, path.basename(filePath)));
    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch {
      skipped.push({ path: filePath, filename, reason: "attachment_path_missing" });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ path: filePath, filename, reason: "attachment_path_not_file" });
      continue;
    }
    if (stats.size > maxBytes) {
      skipped.push({ path: filePath, filename, reason: "attachment_too_large" });
      continue;
    }
    const buffer = await fs.readFile(filePath).catch(() => null);
    if (!buffer) {
      skipped.push({ path: filePath, filename, reason: "attachment_read_failed" });
      continue;
    }
    if (!buffer.length) {
      skipped.push({ path: filePath, filename, reason: "attachment_empty" });
      continue;
    }
    if (buffer.length > maxBytes) {
      skipped.push({ path: filePath, filename, reason: "attachment_too_large" });
      continue;
    }
    prepared.push({
      filename,
      name: pickString(attachment.name, filename),
      mimetype: pickString(attachment.mimetype, attachment.type, "application/octet-stream"),
      kind: pickString(attachment.kind, "file"),
      size: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      encoding: "base64",
      data: buffer.toString("base64"),
    });
  }
  return { attachments: prepared, skipped };
}

function firstAccountError(accounts = []) {
  return accounts.map((account) => account.error).find(Boolean) || "";
}

function publicBridgeAccount(account = {}) {
  const rawId = pickString(account.accountId, account.id);
  const id = canonicalWhatsAppAccountId({ ...account, accountId: rawId, id: rawId }) || rawId;
  return {
    id,
    accountId: id,
    label: pickString(account.label, account.name),
    state: pickString(account.state, account.status),
    ready: Boolean(account.ready),
    authenticated: Boolean(account.authenticated),
    started: Boolean(account.started),
    qrAvailable: Boolean(account.qrAvailable),
    qrUrl: pickString(account.qrUrl),
    pairingCode: pickString(account.pairingCode),
    pairingCodeUpdatedAt: pickString(account.pairingCodeUpdatedAt),
    pairingPhoneNumber: pickString(account.pairingPhoneNumber),
    phoneNumber: pickString(account.phoneNumber),
    contactId: pickString(account.contactId),
    pushName: pickString(account.pushName),
    loadingPercent: account.loadingPercent ?? null,
    loadingMessage: pickString(account.loadingMessage),
    error: pickString(account.error),
    chatOpsReady: account.chatOpsReady !== false,
    runtimeUsable: account.runtimeUsable !== false,
    lastChatOpsProbeAt: pickString(account.lastChatOpsProbeAt),
    lastChatOpsError: pickString(account.lastChatOpsError),
    updatedAt: pickString(account.updatedAt),
    runtimeAccountId: pickString(account.runtimeAccountId, rawId),
    legacyRoleAliases: id !== rawId && rawId ? [rawId] : [],
  };
}

function publicLocalBridgeHealth(health = {}) {
  return {
    ok: health.ok === true,
    mode: pickString(health.mode),
    state: pickString(health.state, health.status),
    ready: Boolean(health.ready),
    clientReady: Boolean(health.clientReady),
    authenticated: Boolean(health.authenticated),
    chatOpsReady: health.chatOpsReady !== false,
    runtimeUsable: health.runtimeUsable !== false,
    qrAvailable: Boolean(health.qrAvailable),
    qrUrl: pickString(health.qrUrl),
    maxAccounts: Number.isFinite(Number(health.maxAccounts)) ? Number(health.maxAccounts) : undefined,
    accounts: Array.isArray(health.accounts) ? health.accounts.map(publicBridgeAccount) : [],
    activeTypingCount: Number.isFinite(Number(health.activeTypingCount)) ? Number(health.activeTypingCount) : undefined,
    activeTyping: Array.isArray(health.activeTyping) ? health.activeTyping.map((session) => ({
      accountId: pickString(session.accountId),
      chatId: pickString(session.chatId),
      startedAt: pickString(session.startedAt),
      lastSyncedAt: pickString(session.lastSyncedAt),
    })) : [],
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

function localAttachmentFailureReason(reason = "") {
  return String(reason || "attachment_unavailable").replace(/_/g, " ");
}

function appendLocalAttachmentFailureNotes(text = "", skipped = []) {
  const seen = new Set();
  const failures = (Array.isArray(skipped) ? skipped : [])
    .map((item) => {
      const filePath = pickString(item.raw, item.path);
      if (!filePath) return "";
      const reason = localAttachmentFailureReason(item.reason);
      const key = `${filePath}\n${reason}`;
      if (seen.has(key)) return "";
      seen.add(key);
      return `${filePath}: ${reason}`;
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

async function externalBridgeAccounts(bridgeUrl, healthPayload, fetchImpl, headers = {}, env = process.env) {
  if (Array.isArray(healthPayload?.accounts)) return healthPayload.accounts.map(publicBridgeAccount);
  try {
    const dashboard = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/api/dashboard"), fetchImpl, { headers, env });
    if (dashboard.ok && Array.isArray(dashboard.accounts)) return dashboard.accounts.map(publicBridgeAccount);
    if (dashboard.ok && Array.isArray(dashboard.payload?.accounts)) return dashboard.payload.accounts.map(publicBridgeAccount);
  } catch {
    // Older bridges only expose /health; account discovery stays best-effort.
  }
  return [];
}

async function resolveBridgeRuntimeAccountId(accountId = "", { config = null, env = process.env, fetchImpl = fetch } = {}) {
  const requested = pickString(accountId);
  if (!requested) return "";
  const resolvedConfig = config || await readConnectorConfig("whatsapp", env).catch(() => ({}));
  const bridgeUrl = configuredBridgeUrl(resolvedConfig, env);
  if (!bridgeUrl) return requested;
  const status = await getWhatsAppStatus(env, fetchImpl).catch(() => null);
  const account = findWhatsAppAccountByAnyId(status?.accounts || [], requested, env);
  return pickString(account?.runtimeAccountId, requested);
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

function normalizeHistoryMessage(message = {}) {
  const rawTimestamp = pickString(message.timestamp, message.createdAt, message.t);
  const numericTimestamp = Number(rawTimestamp || 0);
  const timestamp = rawTimestamp && Number.isFinite(Date.parse(rawTimestamp))
    ? new Date(rawTimestamp).toISOString()
    : numericTimestamp > 0
      ? new Date((numericTimestamp < 10_000_000_000 ? numericTimestamp * 1000 : numericTimestamp)).toISOString()
      : null;
  return {
    id: pickString(message.id, message.messageId, message._serialized),
    body: pickString(message.body, message.text, message.message, message.content),
    type: pickString(message.type),
    fromMe: message.fromMe === true,
    from: pickString(message.from, message.fromId, message.sender),
    to: pickString(message.to, message.toId),
    author: pickString(message.author, message.participant, message.senderId),
    timestamp,
    hasMedia: message.hasMedia === true,
  };
}

function normalizeHistoryMessages(payload = {}) {
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
  return messages.map(normalizeHistoryMessage);
}

export function mapLocalWhatsAppStatusFromHealth(health) {
  const publicHealth = publicLocalBridgeHealth(health);
  const accounts = publicHealth.accounts || [];
  if (hasReadySignal(health)) {
    return {
      state: "paired",
      summary: "Built-in WhatsApp bridge is paired.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health: publicHealth,
      accounts,
      qrAvailable: false,
    };
  }
  if (health.qrAvailable) {
    return {
      state: "qr_needed",
      summary: "Built-in WhatsApp bridge is ready for pairing; scan a QR code.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health: publicHealth,
      accounts,
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
      health: publicHealth,
      accounts,
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
      health: publicHealth,
      accounts,
      qrAvailable: false,
    };
  }
  if (health.state === "failed") {
    return {
      state: "unreachable",
      summary: firstAccountError(health.accounts) || "Built-in WhatsApp bridge could not start.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health: publicHealth,
      accounts,
      qrAvailable: false,
    };
  }
  if (health.state === "starting") {
    return {
      state: "unpaired",
      summary: "Built-in WhatsApp bridge is starting. QR codes will appear shortly.",
      mode: "local",
      bridgeUrl: localWhatsAppBridgeBasePath,
      health: publicHealth,
      accounts,
      qrAvailable: false,
    };
  }
  return {
    state: "unpaired",
    summary: "Start WhatsApp 1 or WhatsApp 2 and scan the QR code.",
    mode: "local",
    bridgeUrl: localWhatsAppBridgeBasePath,
    health: publicHealth,
    accounts,
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
  const headers = bridgeRequestHeaders(config, env);
  try {
    const health = await fetchJson(whatsappBridgeEndpointUrl(bridgeUrl, "/health"), fetchImpl, { headers, env });
    if (!health.ok) {
      if ([401, 403].includes(Number(health.status || 0)) && Object.keys(headers || {}).length) {
        return {
          state: "send_ready_scoped",
          summary: "WhatsApp parent bridge is configured for scoped sending; status is not readable with this token.",
          bridgeUrl,
          health: publicExternalBridgeHealth(health.payload),
          accounts: [],
          qrAvailable: false,
        };
      }
      return {
        state: "failed",
        summary: `WhatsApp bridge returned HTTP ${health.status}.`,
        bridgeUrl,
        health: publicExternalBridgeHealth(health.payload),
        qrAvailable: false,
      };
    }
    if (hasReadySignal(health.payload)) {
      const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl, headers, env);
      return {
        state: "paired",
        summary: "WhatsApp bridge is reachable and paired.",
        bridgeUrl,
        health: publicExternalBridgeHealth(health.payload),
        accounts,
        qrAvailable: false,
      };
    }
    const qrAvailable = await fetchOk(whatsappBridgeEndpointUrl(bridgeUrl, "/qr.svg"), fetchImpl, { headers, env });
    const accounts = await externalBridgeAccounts(bridgeUrl, health.payload, fetchImpl, headers, env);
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
  const runtimeAccountId = await resolveBridgeRuntimeAccountId(accountId, { config, env, fetchImpl });
  if (runtimeAccountId) metaUrl.searchParams.set("accountId", runtimeAccountId);
  const response = await fetchImpl(metaUrl, {
    headers: bridgeRequestHeaders(config, env),
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
    runtimeAccountId,
    chatId: id,
    ready: true,
    isGroup: Boolean(payload?.isGroup),
    participants: normalizeParticipants(payload),
  };
}

function externalHistoryUrls(bridgeUrl = "", chatId = "", runtimeAccountId = "", limit = 30) {
  const id = encodeURIComponent(chatId);
  const account = encodeURIComponent(runtimeAccountId || "");
  const urls = [];
  const standalone = whatsappBridgeEndpointUrl(bridgeUrl, `/api/chats/${id}/history`);
  standalone.searchParams.set("limit", String(limit));
  if (runtimeAccountId) standalone.searchParams.set("accountId", runtimeAccountId);
  urls.push(standalone);
  if (runtimeAccountId) {
    const bridgeRoot = whatsappBridgeEndpointUrl(bridgeUrl, `/accounts/${account}/chats/${id}/history`);
    bridgeRoot.searchParams.set("limit", String(limit));
    urls.push(bridgeRoot);
    const orkestrRoot = whatsappBridgeEndpointUrl(bridgeUrl, `/api/connectors/whatsapp/bridge/accounts/${account}/chats/${id}/history`);
    orkestrRoot.searchParams.set("limit", String(limit));
    urls.push(orkestrRoot);
  }
  return urls;
}

export async function getWhatsAppChatMessages({ accountId = "", chatId = "", limit = 30 } = {}, env = process.env, fetchImpl = fetch) {
  const id = pickString(chatId);
  if (!id) throw badRequest("whatsapp_chat_id_required");
  const max = Math.max(1, Math.min(100, Number(limit || 30) || 30));
  const config = await readConnectorConfig("whatsapp", env);
  const bridgeUrl = configuredBridgeUrl(config, env);
  if (!bridgeUrl && bridgeMode(config, env) === "local") {
    return listLocalWhatsAppChatMessages({ accountId, chatId: id, limit: max, env });
  }
  if (!bridgeUrl) {
    return { accountId, chatId: id, ready: false, messages: [] };
  }
  const runtimeAccountId = await resolveBridgeRuntimeAccountId(accountId, { config, env, fetchImpl });
  const headers = bridgeRequestHeaders(config, env);
  const urls = externalHistoryUrls(bridgeUrl, id, runtimeAccountId, max);
  let lastError = null;
  for (const url of urls) {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(Number(env.WHATSAPP_HISTORY_TIMEOUT_MS || env.ORKESTR_WHATSAPP_HISTORY_TIMEOUT_MS || 5000)),
    }).catch((error) => {
      lastError = error;
      return null;
    });
    if (!response) continue;
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404) {
      lastError = new Error(payload?.error || `whatsapp_chat_history_failed_${response.status}`);
      continue;
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `whatsapp_chat_history_failed_${response.status}`);
      error.statusCode = response.status || 502;
      error.payload = payload;
      throw error;
    }
    return {
      accountId,
      runtimeAccountId,
      chatId: id,
      ready: payload.ready !== false,
      messages: normalizeHistoryMessages(payload),
    };
  }
  const error = new Error(lastError?.message || "whatsapp_chat_history_unavailable");
  error.statusCode = lastError?.statusCode || 502;
  throw error;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function routingConflict(message, failure = {}) {
  const error = new Error(message);
  error.statusCode = 409;
  error.routingFailure = {
    code: message,
    capability: "whatsapp",
    provider: "whatsapp",
    retryable: false,
    userFacingCategory: "connector",
    ...failure,
  };
  return error;
}

function whatsappInboundSecurityError(decision = {}, context = {}) {
  const error = new Error("whatsapp_inbound_sender_denied");
  error.statusCode = 403;
  error.routingFailure = {
    code: "whatsapp_inbound_sender_denied",
    capability: "whatsapp",
    provider: "whatsapp",
    retryable: false,
    userFacingCategory: "connector",
    safeMessage: pickString(decision.safeMessage) || "This WhatsApp sender is not allowed to control this Orkestr chat.",
    reason: pickString(decision.reason, "inbound_sender_denied"),
    routerTraceId: pickString(context.routerTraceId),
    accountId: pickString(context.accountId, decision.participant?.accountId),
    bindingId: pickString(decision.participant?.bindingId),
    threadId: pickString(context.threadId, decision.participant?.threadId),
    chatId: pickString(context.chatId, decision.participant?.chatId),
    principalKind: "whatsapp-participant",
    principalId: pickString(decision.participant?.senderId, decision.participant?.participantId),
  };
  return error;
}

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function nonRetryableWhatsAppOutboundError(error) {
  const message = pickString(error?.message, error);
  return /\bunknown_whatsapp_account\b/i.test(message);
}

function uncertainWhatsAppOutboundDeliveryError(error) {
  const message = pickString(error?.message, error);
  return /\bwhatsapp_send_not_confirmed\b/i.test(message) ||
    /\bwhatsapp_local_bridge_not_ready_recovered_after_send_runtime_error\b/i.test(message);
}

function uncertainWhatsAppConnectorOutboxJob(job = {}) {
  if (pickString(job.state).toLowerCase() !== "failed_retryable") return false;
  return uncertainWhatsAppOutboundDeliveryError(
    pickString(job.error, job.metadata?.lastError, job.metadata?.failureReason),
  );
}

async function findPriorUncertainWhatsAppConnectorOutboxJob({
  chatId = "",
  threadId = "",
  deliveryType = "",
  accountId = "",
  sourceMessageId = "",
  messageId = "",
  parentMessageId = "",
  textKey = "",
} = {}, env = process.env) {
  const sourceId = pickString(sourceMessageId, messageId);
  const parentId = pickString(parentMessageId);
  if ((!sourceId && !parentId) || !chatId) return null;
  const listed = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "delivery_uncertain failed_retryable",
    chatId,
    threadId,
    deliveryType,
  }, env).catch(() => ({ jobs: [] }));
  return (listed.jobs || []).find((job) => {
    const jobState = pickString(job.state).toLowerCase();
    if (jobState === "failed_retryable" && !uncertainWhatsAppConnectorOutboxJob(job)) return false;
    if (jobState !== "delivery_uncertain" && jobState !== "failed_retryable") return false;
    const jobSourceId = pickString(job.sourceMessageId, job.sourceEventId);
    const sameSource = Boolean(sourceId && jobSourceId === sourceId);
    const sameParent = Boolean(parentId && pickString(job.metadata?.parentMessageId) === parentId);
    if (!sameSource && !sameParent) return false;
    if (accountId && pickString(job.accountId) && pickString(job.accountId) !== pickString(accountId)) return false;
    if (sameSource && textKey && pickString(job.metadata?.textKey) && pickString(job.metadata.textKey) !== pickString(textKey)) return false;
    return true;
  }) || null;
}

function canonicalWhatsAppEventId(value = "") {
  return String(value || "").trim().replace(/^(?:true|false)_/, "");
}

function sameWhatsAppSourceEvent(left = {}, right = {}) {
  const leftCanonical = canonicalWhatsAppEventId(left.canonicalEventId || left.eventId);
  const rightCanonical = canonicalWhatsAppEventId(right.canonicalEventId || right.eventId);
  if (!leftCanonical || !rightCanonical || leftCanonical !== rightCanonical) return false;
  const leftChat = pickString(left.chatId);
  const rightChat = pickString(right.chatId);
  return !leftChat || !rightChat || leftChat === rightChat;
}

function sameOptionalEventField(left = {}, right = {}, key = "") {
  const leftValue = pickString(left?.[key]);
  const rightValue = pickString(right?.[key]);
  return !leftValue || !rightValue || leftValue === rightValue;
}

function comparableWhatsAppBody(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function comparableWhatsAppTimestamp(value = "") {
  const raw = pickString(value);
  if (!raw) return "";
  const numeric = Number(raw);
  const ms = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}

function whatsappInboundContentDedupeKey({ chatId = "", from = "", text = "", promptFile = "", attachments = [], timestamp = "" } = {}) {
  const sourceTimestamp = comparableWhatsAppTimestamp(timestamp);
  if (!sourceTimestamp) return "";
  const attachmentKey = attachmentSetKey(attachments);
  const bodyKey = comparableWhatsAppBody(text) || (promptFile ? `prompt:${promptFile}` : "") || (attachmentKey ? "attachments" : "");
  if (!chatId || !bodyKey) return "";
  return [
    pickString(chatId),
    pickString(from).toLowerCase(),
    sourceTimestamp,
    bodyKey,
    attachmentKey,
  ].join("\x1f");
}

function comparableAccountKey(value = "") {
  return pickString(value).toLowerCase();
}

function comparableAccountKeys(values = []) {
  return new Set(values.map(comparableAccountKey).filter(Boolean));
}

function accountLookupKeys(account = {}, env = process.env) {
  return whatsappAccountLookupKeys(account || {}, env).map(comparableAccountKey).filter(Boolean);
}

function activeConnectorAccounts(state = {}) {
  return (Array.isArray(state.connectorAccounts) ? state.connectorAccounts : [])
    .filter((account) => account && typeof account === "object" && !account.deletedAt);
}

function splitAccountList(value = "") {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findConnectorAccountByAnyId(accounts = [], accountId = "", env = process.env) {
  return findWhatsAppAccountByAnyId(accounts, accountId, env) || null;
}

function configuredSenderAccountIds(config = {}, env = process.env) {
  return [
    env.ORKESTR_WHATSAPP_INBOUND_ACCOUNT_ID,
    env.WHATSAPP_INBOUND_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID,
    env.WHATSAPP_SENDER_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_SENDER_ROLE,
    env.WHATSAPP_SENDER_ROLE,
    config.inboundAccountId,
    config.senderAccountId,
    config.senderRole,
    "sender",
  ].map((value) => pickString(value)).filter(Boolean);
}

function configuredResponderAccountIds(config = {}, env = process.env) {
  return [
    env.ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID,
    env.WHATSAPP_RESPONDER_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_RESPONDER_ROLE,
    env.WHATSAPP_RESPONDER_ROLE,
    config.responderAccountId,
    config.responderRole,
    "responder",
  ].map((value) => pickString(value)).filter(Boolean);
}

function expandedAccountKeys(accountIds = [], accounts = [], env = process.env) {
  const keys = [];
  for (const accountId of accountIds) {
    keys.push(accountId);
    const account = findConnectorAccountByAnyId(accounts, accountId, env);
    if (account) keys.push(...accountLookupKeys(account, env));
  }
  return comparableAccountKeys(keys);
}

function accountKeyIntersection(left = new Set(), right = new Set()) {
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function senderOnlyInboundConfigured(config = {}, state = {}, env = process.env, accounts = activeConnectorAccounts(state)) {
  const senderIds = configuredSenderAccountIds(config, env);
  if (pickString(
    env.ORKESTR_WHATSAPP_INBOUND_ACCOUNT_ID,
    env.WHATSAPP_INBOUND_ACCOUNT_ID,
    env.ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID,
    env.WHATSAPP_SENDER_ACCOUNT_ID,
    config.inboundAccountId,
    config.senderAccountId,
  )) return true;
  const configuredAccounts = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  if (configuredAccounts.some((accountId) => senderIds.some((senderId) => comparableAccountKey(accountId) === comparableAccountKey(senderId)))) {
    return true;
  }
  return senderIds.some((senderId) => findConnectorAccountByAnyId(accounts, senderId, env));
}

function whatsappInboundAccountPolicy(input = {}, config = {}, state = {}, env = process.env) {
  const accountId = pickString(input.accountId);
  if (!accountId) return { allowed: true };
  const accounts = activeConnectorAccounts(state);
  if (!senderOnlyInboundConfigured(config, state, env, accounts)) return { allowed: true };
  const senderKeys = expandedAccountKeys(configuredSenderAccountIds(config, env), accounts, env);
  const responderKeys = expandedAccountKeys(configuredResponderAccountIds(config, env), accounts, env);
  const inputAccount = findConnectorAccountByAnyId(accounts, accountId, env);
  const inputKeys = comparableAccountKeys([
    accountId,
    ...(inputAccount ? accountLookupKeys(inputAccount, env) : accountLookupKeys({ accountId }, env)),
  ]);
  if (accountKeyIntersection(inputKeys, senderKeys)) return { allowed: true };
  if (accountKeyIntersection(inputKeys, responderKeys)) {
    return {
      allowed: false,
      reason: "non_sender_account",
      expectedAccountId: [...senderKeys][0] || "sender",
    };
  }
  return { allowed: true };
}

function whatsappBindingInboundAccountPolicy(input = {}, binding = {}, state = {}, env = process.env) {
  const accountId = pickString(input.accountId);
  const senderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
  if (!accountId || !senderAccountId) return { allowed: true };
  const accounts = activeConnectorAccounts(state);
  const senderKeys = expandedAccountKeys([senderAccountId], accounts, env);
  const inputAccount = findConnectorAccountByAnyId(accounts, accountId, env);
  const inputKeys = comparableAccountKeys([
    accountId,
    ...(inputAccount ? accountLookupKeys(inputAccount, env) : accountLookupKeys({ accountId }, env)),
  ]);
  if (accountKeyIntersection(inputKeys, senderKeys)) return { allowed: true };
  return {
    allowed: false,
    reason: "non_sender_account",
    expectedAccountId: [...senderKeys][0] || senderAccountId,
  };
}

function inputFromMe(input = {}) {
  return input.fromMe === true ||
    input.from_me === true ||
    String(input.fromMe || input.from_me || "").trim().toLowerCase() === "true";
}

function outboundDeliveryAckIds(delivery = {}) {
  const ack = delivery.bridgeResponse && typeof delivery.bridgeResponse === "object" && !Array.isArray(delivery.bridgeResponse)
    ? delivery.bridgeResponse
    : delivery.brokerAck && typeof delivery.brokerAck === "object" && !Array.isArray(delivery.brokerAck)
      ? delivery.brokerAck
      : null;
  return [
    ...(
      Array.isArray(ack?.ids)
        ? ack.ids
        : pickString(ack?.id)
          ? [ack.id]
          : []
    ),
    ...(
      Array.isArray(ack?.sent)
        ? ack.sent.map((item) => item?.id)
        : []
    ),
  ].map((value) => pickString(value)).filter(Boolean);
}

function shouldPatchAssistantMirrorDelivery(message = {}, deliveryType = "") {
  if (pickString(message?.role).toLowerCase() !== "assistant") return false;
  return ["final", "router_update", "signal"].includes(pickString(deliveryType).toLowerCase());
}

async function patchAssistantMirrorDeliveryState({
  kind = "",
  agentId = "",
  threadId = "",
  message = {},
  deliveryType = "",
  patch = {},
  env = process.env,
} = {}) {
  if (!shouldPatchAssistantMirrorDelivery(message, deliveryType)) return null;
  const messageId = pickString(message?.id);
  if (!messageId) return null;
  const nextPatch = {
    mirrorDeliveryType: pickString(deliveryType),
    ...patch,
  };
  if (kind === "thread" && pickString(threadId)) {
    return updateThreadMessage(threadId, messageId, nextPatch, env).catch(() => null);
  }
  if (kind === "agent" && pickString(agentId)) {
    return updateAgentMessage(agentId, messageId, nextPatch, env).catch(() => null);
  }
  return null;
}

function outboundEchoDeliveryRecord(job = {}) {
  return {
    kind: "thread",
    deliveryType: pickString(job.deliveryType),
    threadId: pickString(job.threadId),
    messageId: pickString(job.sourceMessageId),
    sourceMessageId: pickString(job.sourceMessageId, job.sourceEventId),
    connectorOutboxJobId: pickString(job.id),
    chatId: pickString(job.chatId),
    accountId: pickString(job.accountId),
    payloadText: pickString(job.payload?.text),
    deliveredAt: pickString(job.deliveredAt, job.terminalAt, job.updatedAt),
    brokerAck: job.brokerAck,
  };
}

function outboundEchoDeliveryForEvent(outboundDeliveries = [], connectorOutboxJobs = [], input = {}) {
  const fromMe = inputFromMe(input);
  const eventId = pickString(input.eventId, input.id, input.messageId);
  const canonicalEventId = canonicalWhatsAppEventId(eventId);
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId);
  if (!eventId && !canonicalEventId) return null;
  const records = [
    ...(outboundDeliveries || []),
    ...(connectorOutboxJobs || []).map((job) => outboundEchoDeliveryRecord(job)),
  ];
  return records.reverse().find((delivery) => {
    const deliveryChatId = pickString(delivery.chatId);
    if (chatId && deliveryChatId && chatId !== deliveryChatId) return false;
    const deliveryAccountId = pickString(delivery.accountId);
    if (fromMe && accountId && deliveryAccountId && accountId !== deliveryAccountId) return false;
    return outboundDeliveryAckIds(delivery).some((ackId) =>
      ackId === eventId ||
      (canonicalEventId && canonicalWhatsAppEventId(ackId) === canonicalEventId)
    );
  }) || null;
}

function outboundTextEchoTtlMs(env = process.env) {
  return positiveInteger(
    pickString(env.ORKESTR_WHATSAPP_OUTBOUND_TEXT_ECHO_TTL_MS, env.ORKESTR_WHATSAPP_OUTBOUND_ECHO_TTL_MS),
    7 * 24 * 60 * 60 * 1000,
    1000,
  );
}

function outboundDeliveryRecentlySent(delivery = {}, env = process.env, nowMs = Date.now()) {
  const deliveredAt = pickString(delivery.deliveredAt, delivery.sentAt, delivery.createdAt);
  const deliveredAtMs = Date.parse(deliveredAt);
  if (!Number.isFinite(deliveredAtMs)) return false;
  return Math.abs(nowMs - deliveredAtMs) <= outboundTextEchoTtlMs(env);
}

function comparableWhatsAppEchoText(value = "") {
  return comparableWhatsAppBody(comparableWhatsAppVisibleText(value));
}

function outboundEchoDeliveryForText(outboundDeliveries = [], connectorOutboxJobs = [], input = {}, env = process.env) {
  if (!inputFromMe(input)) return null;
  const inputText = comparableWhatsAppEchoText(pickString(input.text, input.body, input.message));
  if (!inputText) return null;
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId);
  const nowMs = Date.now();
  const records = [
    ...(outboundDeliveries || []),
    ...(connectorOutboxJobs || [])
      .filter((job) => pickString(job.state).toLowerCase() === "delivered")
      .map((job) => outboundEchoDeliveryRecord(job)),
  ];
  return records.reverse().find((delivery) => {
    const deliveryChatId = pickString(delivery.chatId);
    if (chatId && deliveryChatId && chatId !== deliveryChatId) return false;
    const deliveryAccountId = pickString(delivery.accountId);
    if (accountId && deliveryAccountId && accountId !== deliveryAccountId) return false;
    if (!outboundDeliveryRecentlySent(delivery, env, nowMs)) return false;
    const deliveryText = comparableWhatsAppEchoText(deliveredWhatsAppPayloadText(delivery, connectorOutboxJobs));
    return deliveryText && deliveryText === inputText;
  }) || null;
}

function desktopShareApproveChallengeId(text = "") {
  const value = String(text || "").trim();
  const match = value.match(/^(?:(?:\/?desktop\s+approve|orkestr\s+desktop\s+approve|\/?approve)\s+)?(desk-[A-Za-z0-9_-]{20,})$/i);
  return match?.[1] || "";
}

function messageSourceRevision(message = {}) {
  const parsed = Number(message?.revision || 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function deliverySourceRevision(delivery = {}) {
  const parsed = Number(delivery?.sourceRevision || 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
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

function messageMatchesWhatsAppChat(message = {}, chatId = "") {
  const targetChatId = pickString(chatId);
  const messageChatId = pickString(message?.chatId);
  return !targetChatId || !messageChatId || messageChatId === targetChatId;
}

function sameParentFinalReply(messages = [], message = {}, chatId = "") {
  const parentMessageId = pickString(message?.parentMessageId);
  if (!parentMessageId) return null;
  return messages.find((candidate) =>
    candidate?.id !== message?.id &&
    candidate?.role === "assistant" &&
    candidate?.state === "completed" &&
    candidate?.parentMessageId === parentMessageId &&
    shouldMirrorWhatsAppReply(candidate) &&
    messageMatchesWhatsAppChat(candidate, chatId)
  ) || null;
}

function supersededRuntimeInterruptionNotice(messages = [], message = {}, chatId = "", state = null) {
  const role = String(message?.role || "").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  const source = String(message?.source || "").trim().toLowerCase();
  if (role !== "assistant" || phase !== "runtime_interrupted" || source !== "orkestr_runtime") return false;
  if (sameParentFinalReply(messages, message, chatId)) return true;
  const noticeMs = messageTimeMs(message);
  if (!noticeMs) return false;
  return messages.some((candidate) =>
    String(candidate?.role || "").trim().toLowerCase() === "user" &&
    messageTimeMs(candidate) > noticeMs &&
    sameWhatsAppChat(candidate, chatId, state)
  );
}

function whatsappOvertakenProgressGraceMs(env = process.env) {
  return positiveInteger(env.ORKESTR_WHATSAPP_OVERTAKEN_PROGRESS_GRACE_MS, 15_000, 0);
}

function progressOvertakenByFinal(messages = [], message = {}, chatId = "", env = process.env) {
  const progressMs = messageTimeMs(message);
  if (!progressMs) return false;
  const graceMs = whatsappOvertakenProgressGraceMs(env);
  if (graceMs && Date.now() - progressMs <= graceMs) return false;
  const finalReply = sameParentFinalReply(messages, message, chatId);
  if (!finalReply) return false;
  const finalMs = messageTimeMs(finalReply);
  return Boolean(finalMs && finalMs >= progressMs);
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

async function principalForThread(thread = {}, env = process.env) {
  const ownerUserId = resourceOwnerUserId(thread, env);
  const user = await getUser(ownerUserId, env).catch(() => null);
  if (String(user?.role || "").trim().toLowerCase() === "admin") {
    return adminPrincipal({ id: ownerUserId, displayName: user.displayName || ownerUserId });
  }
  return userPrincipal({ id: ownerUserId, role: "user", displayName: user?.displayName || ownerUserId, source: "whatsapp-owner" });
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
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return false;
  return pickString(
    thread.runtimeKind,
    thread.runtime?.runtimeKind,
    thread.executor?.metadata?.runtimeKind,
    thread.executor?.transport,
  ).toLowerCase() === "codex-app-server" ||
    pickString(thread.executor?.transport).toLowerCase() === "app-server";
}

function deliveryModeRequestsInstantSteer(value = "") {
  const mode = pickString(value).toLowerCase().replace(/[\s-]+/g, "_");
  return ["instant_steer", "steer", "active_turn_steer", "steer_active_turn"].includes(mode);
}

function deliveryModeDisablesInstantSteer(value = "") {
  const mode = pickString(value).toLowerCase().replace(/[\s-]+/g, "_");
  return ["0", "false", "off", "no", "disabled", "disable", "none", "normal", "queue", "queued", "defer", "deferred"].includes(mode);
}

function bindingRequestsWhatsAppInstantSteer(binding = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  return binding.whatsappInboundInstantSteer === true ||
    binding.instantSteerWhatsAppInbound === true ||
    binding.steerWhatsAppInbound === true ||
    binding.steerActiveTurn === true ||
    deliveryModeRequestsInstantSteer(binding.inboundDeliveryMode) ||
    deliveryModeRequestsInstantSteer(binding.whatsappInboundDeliveryMode) ||
    deliveryModeRequestsInstantSteer(binding.codexDeliveryMode);
}

function bindingDisablesWhatsAppInstantSteer(binding = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  return binding.whatsappInboundInstantSteer === false ||
    binding.instantSteerWhatsAppInbound === false ||
    binding.steerWhatsAppInbound === false ||
    binding.steerActiveTurn === false ||
    deliveryModeDisablesInstantSteer(binding.inboundDeliveryMode) ||
    deliveryModeDisablesInstantSteer(binding.whatsappInboundDeliveryMode) ||
    deliveryModeDisablesInstantSteer(binding.codexDeliveryMode);
}

function whatsappInboundInstantSteerDefaultEnabled(env = process.env) {
  return ![
    env.ORKESTR_WHATSAPP_INBOUND_STEER_DEFAULT,
    env.ORKESTR_WHATSAPP_INBOUND_INSTANT_STEER_DEFAULT,
    env.ORKESTR_WHATSAPP_DEFAULT_STEER,
  ].some((value) => deliveryModeDisablesInstantSteer(value));
}

function whatsappInboundInstantSteerEnabled({ thread = null, binding = null, chatId = "", env = process.env } = {}) {
  const candidates = [
    binding,
    thread?.binding,
    thread?.runtime,
    thread,
  ];
  if (candidates.some((candidate) => bindingDisablesWhatsAppInstantSteer(candidate))) return false;
  const configuredThreads = new Set(splitAccountList([
    env.ORKESTR_WHATSAPP_INBOUND_INSTANT_STEER_THREAD_IDS,
    env.ORKESTR_WHATSAPP_INSTANT_STEER_THREAD_IDS,
    env.ORKESTR_WHATSAPP_INBOUND_INSTANT_STEER_THREADS,
  ].filter(Boolean).join(",")));
  const threadKeys = [
    thread?.id,
    thread?.name,
    thread?.title,
    thread?.bindingName,
    binding?.threadId,
    binding?.threadName,
  ].map((value) => pickString(value)).filter(Boolean);
  if (threadKeys.some((key) => configuredThreads.has(key))) return true;
  const configuredChats = new Set(splitAccountList([
    env.ORKESTR_WHATSAPP_INBOUND_INSTANT_STEER_CHAT_IDS,
    env.ORKESTR_WHATSAPP_INSTANT_STEER_CHAT_IDS,
  ].filter(Boolean).join(",")));
  const bindingChatId = pickString(binding?.chatId, thread?.binding?.chatId, chatId);
  if (bindingChatId && configuredChats.has(bindingChatId)) return true;
  if (candidates.some((candidate) => bindingRequestsWhatsAppInstantSteer(candidate))) return true;
  return isCodexAppServerThread(thread) && whatsappInboundInstantSteerDefaultEnabled(env);
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

const whatsappApiAgentKickTimers = new Map();

function codexDebugMetadataMissing(thread = {}) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  return !thread?.codexRateLimits && !metadata.codexRateLimits && !metadata.rateLimits;
}

async function threadWithLiveCodexDebugMetadata(thread = null, env = process.env) {
  if (!thread || !codexDebugMetadataMissing(thread)) return thread;
  const metadata = await resolveCodexThreadMetadata(thread, env).catch(() => ({}));
  const rateLimits = metadata.codexRateLimits || metadata.rateLimits || null;
  if (!rateLimits) return thread;
  const executor = thread.executor && typeof thread.executor === "object" ? thread.executor : {};
  const executorMetadata = executor.metadata && typeof executor.metadata === "object" ? executor.metadata : {};
  return {
    ...thread,
    codexModel: thread.codexModel || metadata.codexModel || null,
    codexModelProvider: thread.codexModelProvider || metadata.codexModelProvider || null,
    codexReasoningEffort: thread.codexReasoningEffort || metadata.codexReasoningEffort || null,
    codexContextWindow: thread.codexContextWindow || metadata.codexContextWindow || null,
    codexTokenUsage: thread.codexTokenUsage || metadata.codexTokenUsage || null,
    codexTotalTokenUsage: thread.codexTotalTokenUsage || metadata.codexTotalTokenUsage || null,
    codexRateLimits: rateLimits,
    executor: {
      ...executor,
      metadata: {
        ...executorMetadata,
        ...metadata,
        codexRateLimits: rateLimits,
      },
    },
  };
}

function whatsappInboundCoalesceMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_COALESCE_MS || 3000);
  if (!Number.isFinite(parsed)) return 3000;
  return Math.max(0, Math.min(15000, Math.floor(parsed)));
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

function scheduleWhatsAppApiAgentThreadKick(thread, env = process.env) {
  if (!thread?.id || !threadUsesApiAgent(thread, env) || !whatsappApiAgentAutoRun(env)) return;
  const delayMs = whatsappInboundCoalesceMs(env);
  if (delayMs <= 0) {
    kickWhatsAppApiAgentThread(thread, env);
    return;
  }
  const prior = whatsappApiAgentKickTimers.get(thread.id);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    whatsappApiAgentKickTimers.delete(thread.id);
    kickWhatsAppApiAgentThread(thread, env);
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  whatsappApiAgentKickTimers.set(thread.id, timer);
}

function tenantVmInboundForwardAuthorized(input = {}) {
  const context = input.machineAuthContext && typeof input.machineAuthContext === "object" ? input.machineAuthContext : null;
  if (!context) return false;
  const routeKind = pickString(context.routeKind, context.kind);
  if (routeKind === "whatsapp_inbound") return true;
  const scopes = Array.isArray(context.scopes) ? context.scopes.map((scope) => pickString(scope)).filter(Boolean) : [];
  return scopes.includes("whatsapp:inbound");
}

function tenantVmRuntimeId(env = process.env) {
  return pickString(env.ORKESTR_TENANT_VM_ID, env.ORKESTR_TENANT_SLICE_ID);
}

function tenantVmRuntimeEnabled(env = process.env) {
  return Boolean(tenantVmRuntimeId(env) || pickString(env.ORKESTR_TENANT_BOUNDARY).toLowerCase() === "tenant-vm");
}

function tenantVmBootstrapThreadCandidate(thread = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" && !Array.isArray(thread.binding) ? thread.binding : {};
  return binding.tenantVmBootstrap === true ||
    thread?.executor?.metadata?.tenantVmBootstrap === true ||
    thread?.runtime?.tenantVmBootstrap === true;
}

function tenantVmBootstrapReboundBinding(thread = {}, input = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" && !Array.isArray(thread.binding) ? thread.binding : {};
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  const accountId = pickString(input.accountId, binding.inboundAccountId, binding.senderAccountId, binding.responderAccountId, binding.outboundAccountId);
  const displayName = pickString(input.chatName, input.displayName, binding.displayName, thread.bindingName, thread.name, chatId);
  return {
    ...binding,
    connector: "whatsapp",
    chatId,
    displayName,
    enabled: binding.enabled !== false,
    routeEligible: binding.routeEligible !== false,
    generated: binding.generated !== false,
    tenantVmBootstrap: true,
    mirrorToWhatsApp: binding.mirrorToWhatsApp !== false,
    ...(accountId ? {
      senderAccountId: pickString(binding.senderAccountId, accountId),
      inboundAccountId: pickString(binding.inboundAccountId, accountId),
      receivingAccountId: pickString(binding.receivingAccountId, accountId),
      responderAccountId: pickString(binding.responderAccountId, accountId),
      outboundAccountId: pickString(binding.outboundAccountId, accountId),
    } : {}),
    updatedAt: new Date().toISOString(),
  };
}

async function maybeRebindTenantVmBootstrapThread(input = {}, env = process.env) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId);
  if (!chatId || !tenantVmRuntimeEnabled(env) || !tenantVmInboundForwardAuthorized(input)) return null;
  const threads = await listThreads(env);
  const candidates = threads.filter(tenantVmBootstrapThreadCandidate);
  if (candidates.length !== 1) return null;
  const thread = candidates[0];
  const binding = thread.binding && typeof thread.binding === "object" && !Array.isArray(thread.binding) ? thread.binding : {};
  if (!whatsappBindingIsRouteEligible(binding)) return null;
  if (pickString(binding.chatId) === chatId) return { threadId: thread.id, binding };
  const nextBinding = tenantVmBootstrapReboundBinding(thread, input);
  const updated = await updateThread(thread.id, {
    binding: nextBinding,
    bindingName: nextBinding.displayName,
  }, env);
  await appendEvent({
    type: "tenant_vm_whatsapp_bootstrap_binding_rebound",
    tenantVmId: tenantVmRuntimeId(env),
    threadId: updated.id,
    previousChatId: pickString(binding.chatId),
    chatId,
    accountId: pickString(input.accountId),
  }, env).catch(() => {});
  return { threadId: updated.id, binding: updated.binding || nextBinding };
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
  const whatsappStatus = await getWhatsAppStatus(env).catch(() => ({}));
  const registryRoute = await resolveWhatsAppBinding({ chatId, accountId }, { env, threads, status: whatsappStatus }).catch(() => null);
  const registryBinding = registryRoute?.selected || null;
  if (registryRoute?.ok && registryBinding?.threadId) {
    const sourceThread = threads.find((item) => item.id === registryBinding.threadId) || null;
    const sourceBinding = sourceThread?.binding && typeof sourceThread.binding === "object" && !Array.isArray(sourceThread.binding)
      ? sourceThread.binding
      : null;
    const binding = registryBinding.source === "thread" && sourceBinding
      ? {
        ...registryBinding,
        ...sourceBinding,
        id: pickString(registryBinding.id, sourceBinding.id),
        bindingId: pickString(registryBinding.bindingId, sourceBinding.bindingId, registryBinding.id),
        level: pickString(registryBinding.level, sourceBinding.level),
        source: pickString(registryBinding.source, sourceBinding.source),
        threadId: pickString(registryBinding.threadId, sourceThread?.id),
        threadName: pickString(registryBinding.threadName, sourceThread?.name, sourceThread?.title, sourceThread?.bindingName),
        routeEligible: registryBinding.routeEligible !== false && sourceBinding.routeEligible !== false,
        acl: sourceBinding.acl || registryBinding.acl,
        accountIds: registryBinding.accountIds,
        legacyFields: registryBinding.legacyFields,
      }
      : registryBinding;
    return { threadId: registryBinding.threadId, binding };
  }
  if (registryRoute?.error === "wa_binding_ambiguous") {
    throw routingConflict("wa_binding_ambiguous", {
      reason: registryRoute.reason || "Multiple WhatsApp bindings matched this inbound chat.",
      chatId,
      accountId,
      bindingId: (registryRoute.diagnostics?.ambiguousBindingIds || []).join(","),
      safeMessage: "Multiple Orkestr WhatsApp bindings matched this chat. Retire one duplicate binding or create a narrower binding.",
    });
  }
  const matchedThreads = threads.filter((item) => whatsappInboundThreadMatchesBinding({
    thread: item,
    chatId,
    accountId,
    from,
    fromMe,
    aclContext: input.machineAuthContext || null,
  }));
  if (matchedThreads.length > 1) {
    throw routingConflict("wa_binding_ambiguous", {
      reason: "Multiple legacy WhatsApp thread bindings matched this inbound chat.",
      chatId,
      accountId,
      bindingId: matchedThreads.map((thread) => pickString(thread.binding?.id, thread.binding?.bindingId) || `thread:${thread.id}:whatsapp`).join(","),
      safeMessage: "Multiple Orkestr WhatsApp bindings matched this chat. Retire one duplicate binding or create a narrower binding.",
    });
  }
  const thread = matchedThreads[0] || null;
  if (thread) return { threadId: thread.id, binding: thread.binding || null };
  const chatBoundThreads = threads.filter((item) => {
    const binding = item?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return false;
    if (!whatsappBindingIsRouteEligible(binding)) return false;
    if (pickString(binding.chatId) !== chatId) return false;
    const accounts = bindingAccountIds(binding);
    return !accounts.size || !accountId || accounts.has(accountId);
  });
  if (chatBoundThreads.length > 1) {
    throw routingConflict("wa_binding_ambiguous", {
      reason: "Multiple legacy WhatsApp bindings matched this chat before sender authorization.",
      chatId,
      accountId,
      bindingId: chatBoundThreads.map((item) => pickString(item.binding?.id, item.binding?.bindingId) || `thread:${item.id}:whatsapp`).join(","),
      safeMessage: "Multiple Orkestr WhatsApp bindings matched this chat. Retire one duplicate binding or create a narrower binding.",
    });
  }
  const chatBoundThread = chatBoundThreads[0] || null;
  return chatBoundThread
    ? { threadId: chatBoundThread.id, binding: chatBoundThread.binding || null, senderAuthorizationPending: true }
    : { threadId: "", binding: null };
}

async function readWhatsAppState(env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.whatsapp, { inboundEvents: [] });
}

function latestOutboundIntentForMessage(state = {}, messageId = "") {
  const id = pickString(messageId);
  if (!id) return null;
  const intents = Array.isArray(state?.outboundIntents) ? state.outboundIntents : [];
  for (let index = intents.length - 1; index >= 0; index -= 1) {
    if (pickString(intents[index]?.messageId) === id) return intents[index];
  }
  return null;
}

export async function whatsappOutboundDeliveryResultForMessage(messageId = "", env = process.env) {
  const state = await readWhatsAppState(env).catch(() => null);
  const intent = latestOutboundIntentForMessage(state, messageId);
  if (!intent) return null;
  const status = pickString(intent?.status).toLowerCase();
  if (status === "delivered") {
    return {
      ok: true,
      state: "delivered",
      delivered: {
        messageId: pickString(intent.messageId),
        threadId: pickString(intent.threadId) || null,
        chatId: pickString(intent.chatId) || null,
        deliveredAt: pickString(intent.deliveredAt || intent.updatedAt) || null,
        intent,
      },
    };
  }
  if (status === "failed") {
    return {
      ok: false,
      state: "failed",
      statusCode: 502,
      failure: {
        messageId: pickString(intent.messageId),
        threadId: pickString(intent.threadId) || null,
        chatId: pickString(intent.chatId) || null,
        reason: pickString(intent.error || intent.reason) || "failed",
        intent,
      },
    };
  }
  if (status === "skipped") {
    return {
      ok: false,
      state: "skipped",
      statusCode: 409,
      skipped: {
        messageId: pickString(intent.messageId),
        threadId: pickString(intent.threadId) || null,
        chatId: pickString(intent.chatId) || null,
        reason: pickString(intent.reason || intent.error) || "skipped",
        intent,
      },
    };
  }
  return {
    ok: false,
    state: status || "pending",
    pending: {
      messageId: pickString(intent.messageId),
      threadId: pickString(intent.threadId) || null,
      chatId: pickString(intent.chatId) || null,
      reason: pickString(intent.error || intent.reason) || status || "pending",
      intent,
    },
  };
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export async function waitForWhatsAppOutboundDeliveryResultForMessage(
  messageId = "",
  { env = process.env, timeoutMs = 10_000, intervalMs = 250 } = {},
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let latest = null;
  do {
    latest = await whatsappOutboundDeliveryResultForMessage(messageId, env);
    if (latest?.ok || ["failed", "skipped"].includes(String(latest?.state || ""))) return latest;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(Math.max(1, Number(intervalMs) || 250), Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return latest;
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

function comparableWhatsAppState(state = {}) {
  const comparable = { ...(state || {}) };
  delete comparable.updatedAt;
  return JSON.stringify(comparable);
}

export function clearWhatsAppDeliveryIdleCache() {
  whatsappDeliveryIdleCache = null;
  whatsappDeliveryRunCache = null;
  whatsappMirrorMessageFileCache.clear();
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
  const merged = mergeWhatsAppState(existing, state, env);
  if (comparableWhatsAppState(existing) === comparableWhatsAppState(merged)) return;
  await writeJson(paths.whatsapp, merged);
  clearWhatsAppDeliveryIdleCache();
}

function connectorOutboxJobIntentMatches(job = {}, intent = {}) {
  const jobId = pickString(job.id);
  if (jobId && pickString(intent.connectorOutboxJobId) === jobId) return true;
  const routerOutboxId = pickString(job.metadata?.routerOutboxId);
  if (routerOutboxId && pickString(intent.outboxId) === routerOutboxId) return true;
  const sourceMessageId = pickString(job.sourceMessageId, job.sourceEventId);
  const intentSource = pickString(intent.sourceMessageId, intent.messageId);
  const sameSource = Boolean(sourceMessageId && (sourceMessageId === intentSource || sourceMessageId === pickString(intent.messageId)));
  return sameSource &&
    (!job.chatId || pickString(intent.chatId) === pickString(job.chatId)) &&
    (!job.accountId || pickString(intent.accountId) === pickString(job.accountId)) &&
    (!job.deliveryType || pickString(intent.deliveryType) === pickString(job.deliveryType));
}

function connectorOutboxJobDeliveryMatches(job = {}, delivery = {}) {
  const jobId = pickString(job.id);
  if (jobId && pickString(delivery.connectorOutboxJobId) === jobId) return true;
  const routerOutboxId = pickString(job.metadata?.routerOutboxId);
  if (routerOutboxId && pickString(delivery.outboxId) === routerOutboxId) return true;
  const sourceMessageId = pickString(job.sourceMessageId, job.sourceEventId);
  const deliverySource = pickString(delivery.sourceMessageId, delivery.messageId);
  const sameSource = Boolean(sourceMessageId && (sourceMessageId === deliverySource || sourceMessageId === pickString(delivery.messageId)));
  return sameSource &&
    (!job.chatId || pickString(delivery.chatId) === pickString(job.chatId)) &&
    (!job.accountId || pickString(delivery.accountId) === pickString(job.accountId)) &&
    (!job.deliveryType || pickString(delivery.deliveryType) === pickString(job.deliveryType)) &&
    (!job.metadata?.textKey || pickString(delivery.textKey) === pickString(job.metadata.textKey));
}

function deliveredConnectorOutboxEvidence(job = {}, outboundDeliveries = [], outboundIntents = []) {
  const delivery = [...(outboundDeliveries || [])].reverse().find((item) => connectorOutboxJobDeliveryMatches(job, item)) || null;
  if (delivery) {
    return {
      deliveredAt: pickString(delivery.deliveredAt) || new Date().toISOString(),
      brokerAck: delivery.bridgeResponse && typeof delivery.bridgeResponse === "object" && !Array.isArray(delivery.bridgeResponse)
        ? delivery.bridgeResponse
        : delivery.brokerAck && typeof delivery.brokerAck === "object" && !Array.isArray(delivery.brokerAck)
          ? delivery.brokerAck
          : null,
      source: "whatsapp_delivery_ledger",
    };
  }
  const intent = [...(outboundIntents || [])].reverse().find((item) =>
    connectorOutboxJobIntentMatches(job, item) &&
    pickString(item.status).toLowerCase() === "delivered"
  ) || null;
  if (!intent) return null;
  return {
    deliveredAt: pickString(intent.deliveredAt) || new Date().toISOString(),
    brokerAck: null,
    source: "whatsapp_outbound_intent",
  };
}

async function reconcileWhatsAppConnectorOutboxFromLedger(state = {}, env = process.env) {
  const outbox = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "pending claimed sent_to_broker failed_retryable delivery_uncertain",
  }, env).catch(() => ({ jobs: [] }));
  const jobs = outbox.jobs || [];
  if (!jobs.length) return { reconciled: 0 };
  const outboundDeliveries = Array.isArray(state.outboundDeliveries) ? state.outboundDeliveries : [];
  const outboundIntents = Array.isArray(state.outboundIntents) ? state.outboundIntents : [];
  let reconciled = 0;
  let intentsChanged = false;
  for (const job of jobs) {
    const evidence = deliveredConnectorOutboxEvidence(job, outboundDeliveries, outboundIntents);
    if (!evidence) continue;
    await markConnectorOutboxJob(job.id, {
      state: "delivered",
      deliveredAt: evidence.deliveredAt,
      brokerAck: evidence.brokerAck || job.brokerAck || null,
      error: "",
    }, env);
    const intent = outboundIntents.find((item) => connectorOutboxJobIntentMatches(job, item)) || null;
    if (intent?.intentId && pickString(intent.status).toLowerCase() !== "delivered") {
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, {
        status: "delivered",
        deliveredAt: evidence.deliveredAt,
        deliveryMessageId: pickString(job.sourceMessageId, job.sourceEventId),
        error: "",
        connectorOutboxJobId: job.id,
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
      intentsChanged = true;
    }
    const routerOutboxId = pickString(job.metadata?.routerOutboxId);
    if (routerOutboxId) {
      await markRouterOutboxItem(routerOutboxId, { status: "delivered", deliveredAt: evidence.deliveredAt }, env).catch(() => null);
    }
    reconciled += 1;
    await appendEvent({
      type: "connector_outbox_reconciled_from_whatsapp_delivery",
      outboxJobId: job.id,
      connector: "whatsapp",
      source: evidence.source,
      chatId: pickString(job.chatId),
      accountId: pickString(job.accountId),
      threadId: pickString(job.threadId),
      sourceMessageId: pickString(job.sourceMessageId),
      deliveryType: pickString(job.deliveryType),
      deliveredAt: evidence.deliveredAt,
    }, env).catch(() => null);
  }
  if (intentsChanged) await writeWhatsAppState(state, env);
  return { reconciled };
}

function connectorOutboxIntentPatch(action = "", job = {}, options = {}) {
  const now = new Date().toISOString();
  const normalized = pickString(action).toLowerCase().replace(/-/g, "_");
  const reason = pickString(options.reason || options.error);
  if (normalized === "retry" || normalized === "replay") {
    return {
      status: "pending",
      error: "",
      deliveredAt: "",
      skippedAt: "",
      failedAt: "",
      cancelledAt: "",
      updatedAt: now,
      lastChangedAt: now,
      connectorOutboxJobId: pickString(job.id),
      [`${normalized}RequestedAt`]: now,
      ...(reason ? { [`${normalized}Reason`]: reason } : {}),
    };
  }
  if (normalized === "suppress" || normalized === "dead_letter") {
    return {
      status: "skipped",
      skippedAt: now,
      error: reason || `connector_outbox_${normalized}`,
      updatedAt: now,
      lastChangedAt: now,
      connectorOutboxJobId: pickString(job.id),
    };
  }
  if (normalized === "mark_delivered") {
    return {
      status: "delivered",
      deliveredAt: pickString(options.deliveredAt) || now,
      error: "",
      updatedAt: now,
      lastChangedAt: now,
      connectorOutboxJobId: pickString(job.id),
    };
  }
  return null;
}

async function writeWhatsAppStateForOperatorAction(state = {}, env = process.env) {
  const paths = dataPaths(env);
  await writeJson(paths.whatsapp, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
  clearWhatsAppDeliveryIdleCache();
}

export async function applyWhatsAppConnectorOutboxAction(job = {}, action = "", options = {}, env = process.env) {
  if (pickString(job.connector).toLowerCase() !== "whatsapp") return { ok: true, skipped: "not_whatsapp" };
  const patch = connectorOutboxIntentPatch(action, job, options);
  if (!patch) return { ok: false, error: "whatsapp_outbox_action_invalid" };
  const state = await readWhatsAppState(env);
  const outboundIntents = Array.isArray(state.outboundIntents) ? state.outboundIntents : [];
  const outboundDeliveries = Array.isArray(state.outboundDeliveries) ? state.outboundDeliveries : [];
  let matchedIntents = 0;
  const nextIntents = outboundIntents.map((intent) => {
    if (!connectorOutboxJobIntentMatches(job, intent)) return intent;
    matchedIntents += 1;
    return {
      ...intent,
      ...patch,
    };
  });
  const normalized = pickString(action).toLowerCase().replace(/-/g, "_");
  let removedDeliveries = 0;
  const nextDeliveries = normalized === "retry" || normalized === "replay"
    ? outboundDeliveries.filter((delivery) => {
        const matched = connectorOutboxJobDeliveryMatches(job, delivery);
        if (matched) removedDeliveries += 1;
        return !matched;
      })
    : outboundDeliveries;
  if (!matchedIntents && !removedDeliveries) {
    return { ok: true, matchedIntents: 0, removedDeliveries: 0 };
  }
  await writeWhatsAppStateForOperatorAction({
    ...state,
    outboundIntents: nextIntents,
    outboundDeliveries: nextDeliveries,
  }, env);
  await appendEvent({
    type: "whatsapp_connector_outbox_operator_action",
    outboxJobId: pickString(job.id),
    action: normalized,
    sourceMessageId: pickString(job.sourceMessageId),
    chatId: pickString(job.chatId),
    accountId: pickString(job.accountId),
    matchedIntents,
    removedDeliveries,
  }, env).catch(() => {});
  return { ok: true, matchedIntents, removedDeliveries };
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
  return outboundIntentFieldKey(intent) === outboundIntentFieldKey(input);
}

function outboundIntentFieldKey(input = {}) {
  return [
    pickString(input.kind),
    pickString(input.deliveryType),
    pickString(input.routerUpdateType),
    pickString(input.messageId),
    pickString(input.sourceMessageId),
    pickString(input.chatId),
    pickString(input.accountId),
  ].join("\x1f");
}

const whatsappOutboundIntentIndexCache = new WeakMap();

function outboundIntentIndexIdentity(intent = {}) {
  return pickString(intent.intentId, outboundIntentKey(intent), intent.messageId);
}

function whatsappOutboundIntentIndex(outboundIntents = []) {
  if (!Array.isArray(outboundIntents)) return { byIntentId: new Map(), byFields: new Map() };
  const signature = [
    outboundIntents.length,
    outboundIntentIndexIdentity(outboundIntents[0]),
    outboundIntentIndexIdentity(outboundIntents[outboundIntents.length - 1]),
  ].join("\x1e");
  const cached = whatsappOutboundIntentIndexCache.get(outboundIntents);
  if (cached?.signature === signature) return cached;
  const byIntentId = new Map();
  const byFields = new Map();
  for (const intent of outboundIntents) {
    const intentId = outboundIntentIndexIdentity(intent);
    if (intentId && !byIntentId.has(intentId)) byIntentId.set(intentId, intent);
    const fieldKey = outboundIntentFieldKey(intent);
    if (fieldKey && !byFields.has(fieldKey)) byFields.set(fieldKey, intent);
  }
  const indexed = { signature, byIntentId, byFields };
  whatsappOutboundIntentIndexCache.set(outboundIntents, indexed);
  return indexed;
}

function findWhatsAppOutboundIntent(outboundIntents = [], input = {}) {
  const exactIntentId = input.textKey ? outboundIntentKey(input) : "";
  const index = whatsappOutboundIntentIndex(outboundIntents);
  if (exactIntentId) {
    const exact = index.byIntentId.get(exactIntentId);
    if (exact) return exact;
  }
  const fieldKey = outboundIntentFieldKey(input);
  return index.byFields.get(fieldKey) || null;
}

function whatsappUpdateDeliverySuppressed({ kind, deliveryType, thread, chatId, env } = {}) {
  if (kind !== "thread") return false;
  if (!suppressibleWhatsAppUpdateDeliveryTypes.has(pickString(deliveryType).toLowerCase())) return false;
  return threadSuppressesWhatsAppUpdates(thread, chatId, env);
}

async function skipSuppressedWhatsAppUpdateCandidate({ skipped, ...input } = {}) {
  await skipWhatsAppOutboundCandidate({
    ...input,
    reason: "updates_suppressed",
  });
  skipped?.push({
    agentId: input.agentId,
    threadId: input.threadId,
    messageId: input.messageId,
    reason: "updates_suppressed",
  });
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
  const activeJobs = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "pending claimed sent_to_broker failed_retryable",
    chatId,
    threadId,
    deliveryType,
  }, env).catch(() => ({ jobs: [] }));
  const now = new Date().toISOString();
  for (const job of activeJobs.jobs || []) {
    if (pickString(job.sourceMessageId, job.sourceEventId) !== pickString(sourceMessageId, messageId)) continue;
    if (accountId && pickString(job.accountId) && pickString(job.accountId) !== pickString(accountId)) continue;
    await markConnectorOutboxJob(job.id, {
      state: "skipped",
      skippedAt: now,
      error: reason || "obsolete_outbound_notice",
      metadata: {
        ...(job.metadata || {}),
        skippedBy: "whatsapp_mirror",
        skippedReason: reason || "obsolete_outbound_notice",
      },
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

async function suppressProgressRetriesAfterFinal({
  state,
  outboundIntents,
  threadId,
  chatId,
  accountId,
  parentMessageId,
  finalMessageId,
  reason = "overtaken_by_final",
  env,
} = {}) {
  const parentId = pickString(parentMessageId);
  if (!parentId || !chatId) return { suppressed: 0 };
  const now = new Date().toISOString();
  let suppressed = 0;
  let intentsChanged = false;
  const nextIntents = outboundIntents.map((intent) => {
    if (pickString(intent.deliveryType).toLowerCase() !== "progress") return intent;
    if (pickString(intent.parentMessageId) !== parentId) return intent;
    if (pickString(intent.chatId) !== pickString(chatId)) return intent;
    if (threadId && pickString(intent.threadId) && pickString(intent.threadId) !== pickString(threadId)) return intent;
    if (accountId && pickString(intent.accountId) && pickString(intent.accountId) !== pickString(accountId)) return intent;
    const status = pickString(intent.status).toLowerCase();
    if (["delivered", "skipped", "cancelled"].includes(status)) return intent;
    intentsChanged = true;
    suppressed += 1;
    return {
      ...intent,
      status: "skipped",
      skippedAt: now,
      error: reason,
      supersededByMessageId: pickString(finalMessageId),
      updatedAt: now,
      lastChangedAt: now,
    };
  });
  if (intentsChanged) {
    outboundIntents.splice(0, outboundIntents.length, ...nextIntents);
    state.outboundIntents = outboundIntents;
    await writeWhatsAppState(state, env);
  }
  const activeJobs = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "pending claimed sent_to_broker failed_retryable",
    chatId,
    threadId,
    deliveryType: "progress",
  }, env).catch(() => ({ jobs: [] }));
  for (const job of activeJobs.jobs || []) {
    if (pickString(job.metadata?.parentMessageId) !== parentId) continue;
    if (accountId && pickString(job.accountId) && pickString(job.accountId) !== pickString(accountId)) continue;
    await markConnectorOutboxJob(job.id, {
      state: "skipped",
      skippedAt: now,
      error: reason,
      metadata: {
        ...(job.metadata || {}),
        skippedBy: "whatsapp_mirror",
        skippedReason: reason,
        supersededByMessageId: pickString(finalMessageId),
      },
    }, env).catch(() => null);
    suppressed += 1;
  }
  if (suppressed) {
    await appendEvent({
      type: "whatsapp_progress_retries_suppressed_after_final",
      threadId: pickString(threadId),
      chatId: pickString(chatId),
      accountId: pickString(accountId),
      parentMessageId: parentId,
      finalMessageId: pickString(finalMessageId),
      suppressed,
      reason,
    }, env).catch(() => null);
  }
  return { suppressed };
}

function terminalWhatsAppOutboundIntentWithReason(intent = null, reason = "") {
  const status = pickString(intent?.status).toLowerCase();
  if (status !== "skipped" && status !== "cancelled") return false;
  return pickString(intent?.error).toLowerCase() === pickString(reason).toLowerCase();
}

async function skipWhatsAppMirroringDisabledCandidate({
  state,
  outboundIntents,
  skipped,
  existingIntent,
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
  env,
} = {}) {
  if (terminalWhatsAppOutboundIntentWithReason(existingIntent, "mirroring_disabled")) return;
  await skipWhatsAppOutboundCandidate({
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
    reason: "mirroring_disabled",
    env,
  });
  skipped?.push({ agentId, threadId, messageId, reason: "mirroring_disabled_terminal" });
}

const mutationNoticeSourceTypes = new Set(["final", "progress", "router_update"]);

function latestDeliveredWhatsAppSourceDelivery(outboundDeliveries = [], sourceMessageId = "") {
  const id = pickString(sourceMessageId);
  if (!id) return null;
  return [...(outboundDeliveries || [])].reverse().find((item) => {
    const sourceId = pickString(item?.sourceMessageId, item?.messageId);
    if (sourceId !== id) return false;
    return mutationNoticeSourceTypes.has(pickString(item?.deliveryType).toLowerCase());
  }) || null;
}

function latestDeliveredWhatsAppSourceRevision(outboundDeliveries = [], sourceMessageId = "") {
  const delivery = latestDeliveredWhatsAppSourceDelivery(outboundDeliveries, sourceMessageId);
  if (!delivery) return 0;
  if (!pickString(delivery.sourceRevision)) return Number.MAX_SAFE_INTEGER;
  return deliverySourceRevision(delivery);
}

function deliveredWhatsAppPayloadText(delivery = null, connectorOutboxJobs = []) {
  if (!delivery) return "";
  const ledgerText = pickString(delivery.payloadText, delivery.text);
  if (ledgerText) return ledgerText;
  const job = [...(connectorOutboxJobs || [])].reverse().find((item) => connectorOutboxJobDeliveryMatches(item, delivery)) || null;
  return pickString(job?.payload?.text);
}

function comparableWhatsAppVisibleText(value = "") {
  return stripWhatsAppDebugFooter(formatWhatsAppOutboundText(pickString(value))).trim();
}

function whatsappMutationNoticeTarget({ message = {}, parent = null, thread = null, kind = "", outboundDeliveries = [], connectorOutboxJobs = [] } = {}) {
  if (String(message?.role || "").trim().toLowerCase() !== "assistant") return null;
  if (String(message?.state || "").trim().toLowerCase() !== "completed") return null;
  if (!shouldMirrorWhatsAppReply(message) && !shouldMirrorWhatsAppProgress(message)) return null;
  const whatsappOrigin =
    parent?.connector === "whatsapp" ||
    parent?.source === "whatsapp_inbound" ||
    message.connector === "whatsapp" ||
    boundThreadWhatsAppAssistantOrigin({ message, thread, kind });
  if (!whatsappOrigin) return null;
  const sourceRevision = messageSourceRevision(message);
  const deliveredSource = latestDeliveredWhatsAppSourceDelivery(outboundDeliveries, message.id);
  const deliveredRevision = deliveredSource
    ? pickString(deliveredSource.sourceRevision) ? deliverySourceRevision(deliveredSource) : Number.MAX_SAFE_INTEGER
    : 0;
  const deleted = Boolean(pickString(message.deletedAt));
  if (!deleted && (!deliveredRevision || sourceRevision <= deliveredRevision)) return null;
  if (!deleted) {
    const deliveredText = comparableWhatsAppVisibleText(deliveredWhatsAppPayloadText(deliveredSource, connectorOutboxJobs));
    const currentText = comparableWhatsAppVisibleText(message.text);
    if (deliveredText && currentText && deliveredText === currentText) return null;
  }
  const chatId = pickString(message.chatId, parent?.chatId, thread?.binding?.chatId);
  if (!chatId) return null;
  const accountId = kind === "thread"
    ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
    : pickString(message.accountId, parent?.accountId);
  return {
    chatId,
    accountId,
    sourceRevision,
    deliveredRevision,
    deliveryType: deleted ? "delete_notice" : "edit_notice",
    action: deleted ? "deleted" : "edited",
    priorDelivery: deliveredRevision > 0,
  };
}

function formatWhatsAppMutationNotice(message = {}, target = {}) {
  if (target.action === "deleted") {
    const reason = pickString(message.deleteReason);
    return [
      "A previous Orkestr message was deleted.",
      "WhatsApp cannot remove the already-sent bridge copy, so this tombstone is recorded as a correction notice.",
      ...(reason ? [`Reason: ${reason}`] : []),
    ].join("\n");
  }
  const text = formatWhatsAppOutboundText(pickString(message.text));
  return ["Correction to my previous message:", "", text].join("\n").trim();
}

async function markUnsupportedWhatsAppMutation({
  thread,
  kind,
  agentId,
  threadId,
  message,
  target,
  env,
} = {}) {
  const job = await ensureConnectorOutboxJob({
    tenantId: resourceOwnerUserId(thread || {}, env),
    ownerUserId: resourceOwnerUserId(thread || {}, env),
    connector: "whatsapp",
    accountId: target.accountId,
    chatId: target.chatId,
    threadId: threadId || "",
    agentId: agentId || "",
    sourceEventId: pickString(message?.eventId, message?.sourceEventId, message?.id),
    sourceMessageId: pickString(message?.id),
    sourceRevision: String(target.sourceRevision || messageSourceRevision(message)),
    deliveryType: target.deliveryType,
    state: "skipped",
    error: "unsupported_connector_action_original_not_delivered",
    payload: {
      action: target.action,
      deletedAt: pickString(message?.deletedAt),
    },
    metadata: {
      kind,
      unsupportedConnectorAction: true,
    },
  }, env);
  await appendEvent({
    type: "whatsapp_outbound_mutation_skipped",
    reason: "unsupported_connector_action_original_not_delivered",
    outboxJobId: job.job.id,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message?.id || null,
    chatId: target.chatId,
    deliveryType: target.deliveryType,
  }, env).catch(() => null);
  return job;
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
    sourceRevision: String(messageSourceRevision(message)),
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
    const outboxState = String(outboxResult.job?.state || "").trim().toLowerCase();
    if (intent?.intentId) {
      const now = new Date().toISOString();
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, outboxState === "delivered" ? {
        status: "delivered",
        deliveredAt: pickString(outboxResult.job?.deliveredAt) || now,
        deliveryMessageId: messageId,
        error: "",
      } : {
        status: outboxState === "cancelled" ? "cancelled" : "skipped",
        skippedAt: pickString(outboxResult.job?.skippedAt) || now,
        error: pickString(outboxResult.job?.error, `connector_outbox_${outboxState}`),
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
      await writeWhatsAppState(state, env);
    }
    if (outboxState === "delivered") {
      const deliveredAt = pickString(outboxResult.job?.deliveredAt, outboxResult.job?.terminalAt, outboxResult.job?.updatedAt, new Date().toISOString());
      const ackIds = outboundDeliveryAckIds({ brokerAck: outboxResult.job?.brokerAck });
      await patchAssistantMirrorDeliveryState({
        kind,
        agentId,
        threadId,
        message,
        deliveryType,
        patch: {
          mirrorOutboxJobId: outboxResult.job.id,
          deliveryState: "delivered",
          deliveryLastAttemptAt: deliveredAt,
          deliveredAt,
          deliveryError: "",
          ...(ackIds.length ? { whatsappMessageId: ackIds[0], whatsappMessageIds: ackIds } : {}),
        },
        env,
      });
    } else {
      await patchAssistantMirrorDeliveryState({
        kind,
        agentId,
        threadId,
        message,
        deliveryType,
        patch: {
          mirrorOutboxJobId: outboxResult.job.id,
          deliveryState: outboxState || "skipped",
          deliveryLastAttemptAt: pickString(outboxResult.job?.terminalAt, outboxResult.job?.updatedAt, new Date().toISOString()),
          deliveryError: pickString(outboxResult.job?.error),
        },
        env,
      });
    }
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
  const uncertainSourceJob = uncertainWhatsAppConnectorOutboxJob(outboxResult.job)
    ? outboxResult.job
    : await findPriorUncertainWhatsAppConnectorOutboxJob({
        chatId,
        threadId,
        deliveryType,
        accountId,
        sourceMessageId,
        messageId,
        parentMessageId,
        textKey,
      }, env);
  if (uncertainSourceJob) {
    const now = new Date().toISOString();
    const errorText = pickString(uncertainSourceJob.error, "whatsapp_send_not_confirmed");
    if (uncertainSourceJob.id !== outboxResult.job.id) {
      await markConnectorOutboxJob(uncertainSourceJob.id, {
        state: "delivery_uncertain",
        failedAt: pickString(uncertainSourceJob.failedAt) || now,
        terminalAt: now,
        error: errorText,
        metadata: {
          ...(uncertainSourceJob.metadata || {}),
          deliveryUncertain: true,
          retrySuppressed: true,
          terminalizedAt: now,
        },
      }, env).catch(() => null);
    }
    await markConnectorOutboxJob(outboxResult.job.id, {
      state: "delivery_uncertain",
      failedAt: pickString(outboxResult.job.failedAt, uncertainSourceJob.failedAt) || now,
      terminalAt: now,
      error: errorText,
      metadata: {
        ...(outboxResult.job.metadata || {}),
        deliveryUncertain: true,
        retrySuppressed: true,
        terminalizedAt: now,
        ...(uncertainSourceJob.id !== outboxResult.job.id ? { priorDeliveryUncertainJobId: uncertainSourceJob.id } : {}),
      },
    }, env).catch(() => null);
    if (intent?.intentId) {
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, {
        status: "skipped",
        skippedAt: now,
        failedAt: pickString(outboxResult.job.failedAt, uncertainSourceJob.failedAt) || now,
        error: errorText,
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
      await writeWhatsAppState(state, env);
    }
    await patchAssistantMirrorDeliveryState({
      kind,
      agentId,
      threadId,
      message,
      deliveryType,
      patch: {
        mirrorOutboxJobId: outboxResult.job.id,
        deliveryState: "delivery_uncertain",
        deliveryLastAttemptAt: now,
        deliveryError: errorText,
      },
      env,
    });
    await markRouterOutboxItem(intent?.outboxId, {
      status: "skipped",
      error: errorText,
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: "skipped",
      reason: "connector_outbox_delivery_uncertain",
      threadId,
      messageId,
      chatId,
      accountId,
      deliveryType,
      routerUpdateType,
      outboxId: intent?.outboxId,
      connectorOutboxJobId: outboxResult.job.id,
      terminal: true,
    }, env).catch(() => {});
    return { skipped: { reason: "connector_outbox_delivery_uncertain" } };
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
  await patchAssistantMirrorDeliveryState({
    kind,
    agentId,
    threadId,
    message,
    deliveryType,
    patch: {
      mirrorOutboxJobId: outboxClaim.job.id,
      deliveryState: "mirror_claimed",
      deliveryLastAttemptAt: new Date().toISOString(),
      deliveryError: "",
    },
    env,
  });
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
      sourceRevision: messageSourceRevision(message),
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(routerTraceId ? { routerTraceId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(intent?.outboxId ? { outboxId: intent.outboxId } : {}),
      connectorOutboxJobId: outboxClaim.job.id,
      chatId,
      accountId,
      textKey,
      payloadText: text,
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
    const ackIds = outboundDeliveryAckIds(delivery);
    await patchAssistantMirrorDeliveryState({
      kind,
      agentId,
      threadId,
      message,
      deliveryType,
      patch: {
        mirrorOutboxJobId: outboxClaim.job.id,
        deliveryState: "delivered",
        deliveryLastAttemptAt: delivery.deliveredAt,
        deliveredAt: delivery.deliveredAt,
        deliveryError: "",
        ...(ackIds.length ? { whatsappMessageId: ackIds[0], whatsappMessageIds: ackIds } : {}),
      },
      env,
    });
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
    const errorText = error.message || String(error);
    const terminalFailure = nonRetryableWhatsAppOutboundError(error);
    const uncertainDelivery = uncertainWhatsAppOutboundDeliveryError(error);
    const terminalOutboxState = terminalFailure
      ? "dead_letter"
      : uncertainDelivery
        ? "delivery_uncertain"
        : "failed_retryable";
    const now = new Date().toISOString();
    const retryBackoffMs = terminalFailure || uncertainDelivery ? 0 : connectorOutboxRetryBackoffMs(env);
    const retryAt = retryBackoffMs > 0 ? new Date(Date.now() + retryBackoffMs).toISOString() : "";
    if (intent?.intentId) {
      const previousAttempts = Number(intent.attempts || 0) || 0;
      const marked = markWhatsAppOutboundIntent(outboundIntents, intent.intentId, terminalFailure || uncertainDelivery ? {
        status: "skipped",
        attempts: previousAttempts + 1,
        skippedAt: now,
        failedAt: now,
        error: errorText,
      } : {
        status: "pending",
        attempts: previousAttempts + 1,
        failedAt: now,
        error: errorText,
      });
      outboundIntents.splice(0, outboundIntents.length, ...marked);
      state.outboundIntents = outboundIntents;
    }
    await finishOutboundDeliveryClaim({ state, claim: claimResult.claim, filePath: claimResult.filePath, status: "failed", error: errorText }, env, { persistState: writeWhatsAppState }).catch(() => {});
    await markConnectorOutboxJob(outboxClaim.job.id, {
      state: terminalOutboxState,
      failedAt: now,
      error: errorText,
      claimExpiresAt: retryAt,
      claimedBy: retryAt ? "retry_backoff" : "",
      claimedAt: "",
      ...(terminalFailure || uncertainDelivery ? { terminalAt: now } : {}),
      metadata: {
        ...(outboxClaim.job.metadata || {}),
        ...(terminalFailure ? { nonRetryable: true } : {}),
        ...(uncertainDelivery ? { deliveryUncertain: true, retrySuppressed: true } : {}),
        ...(!terminalFailure && !uncertainDelivery ? { retryAfterAt: retryAt } : {}),
      },
    }, env).catch(() => null);
    await patchAssistantMirrorDeliveryState({
      kind,
      agentId,
      threadId,
      message,
      deliveryType,
      patch: {
        mirrorOutboxJobId: outboxClaim.job.id,
        deliveryState: terminalFailure ? "failed" : uncertainDelivery ? "delivery_uncertain" : "failed_retryable",
        deliveryLastAttemptAt: now,
        deliveryError: errorText,
      },
      env,
    });
    await markRouterOutboxItem(intent?.outboxId, {
      status: terminalFailure || uncertainDelivery ? "skipped" : "failed",
      attempts: Number(intent?.attempts || 0) + 1,
      error: errorText,
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      phase: terminalFailure || uncertainDelivery ? "skipped" : "mirror_failed",
      threadId,
      messageId,
      chatId,
      accountId,
      deliveryType,
      routerUpdateType,
      outboxId: intent?.outboxId,
      connectorOutboxJobId: outboxClaim.job.id,
      error,
      terminal: terminalFailure || uncertainDelivery || undefined,
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

function generatedWhatsAppQueueNoticeText(text = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  return [
    /^Queued for the next Codex turn(?:[:.]\s|$)/i,
    /^Added after the current Codex turn(?:[:.]\s|$)/i,
    /^Queued your message while Orkestr prepares this thread(?:[:.]\s|$)/i,
    /^Runtime handoff is taking longer than expected(?:[:.]\s|$)/i,
    /^Waking this Orkestr thread and queued your message(?:[:.]\s|$)/i,
    /^Waking this thread\. Your message will run after startup(?:[:.]\s|$)/i,
    /^Queued your latest message while current work is still running(?:[:.]\s|$)/i,
    /^Queued behind current work(?:[:.]\s|$)/i,
    /^Interrupting the current Codex turn and queued your message(?:[:.]\s|$)/i,
    /^Queued your latest message while Orkestr recovers this thread(?:[:.]\s|$)/i,
    /^Delivery is paused to avoid duplicates\. Orkestr is recovering this thread(?:[:.]\s|$)/i,
    /^Queued your message while Codex is waiting for approval(?:[:.]\s|$)/i,
    /^Codex is waiting for approval\. Your message is held(?:[:.]\s|$)/i,
    /^Queued your latest message behind background work on this thread(?:[:.]\s|$)/i,
    /^Interrupting Codex and sending now(?:[:.]\s|$)/i,
  ].some((pattern) => pattern.test(value));
}

function whatsappRouterStatusCommand(text = "") {
  return /^\/status(?:\s|$)/i.test(pickString(text));
}

function numberCount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function compactDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (totalSeconds < 5) return "just now";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) {
    const minutes = totalMinutes % 60;
    return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  return `${days}d`;
}

function timestampValueMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageTimestampMs(message = {}) {
  return timestampValueMs(message.deliveredAt || message.updatedAt || message.createdAt || message.timestamp);
}

function latestMessageBy(messages = [], predicate = () => false) {
  return [...(Array.isArray(messages) ? messages : [])].reverse().find(predicate) || null;
}

function earliestMessageBy(messages = [], predicate = () => false) {
  return (Array.isArray(messages) ? messages : []).find(predicate) || null;
}

function relativeTimestamp(value, nowMs = Date.now()) {
  const ms = timestampValueMs(value);
  if (!ms) return "";
  const delta = nowMs - ms;
  if (delta < -1000) {
    const future = compactDuration(Math.abs(delta));
    return future === "just now" ? "soon" : `in ${future}`;
  }
  const past = compactDuration(delta);
  return past === "just now" ? past : `${past} ago`;
}

function shortStatusId(value = "") {
  const text = pickString(value);
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function whatsappStatusRuntimeLabel(thread = {}, status = {}) {
  const kind = pickString(
    status.runtimeKind,
    status.runtimeState,
    thread.runtimeKind,
    thread.runtime?.runtimeKind,
    thread.executor?.metadata?.runtimeKind,
    thread.executor?.transport,
    thread.executor?.type,
  ).toLowerCase();
  if (kind === "codex-app-server" || kind === "app-server") return "Codex API";
  if (kind === "raw-terminal") return "Terminal";
  if (kind === "api-agent") return "API agent";
  if (kind === "codex-tmux" || kind === "live") return "Terminal";
  if (kind === "none") return "Not started";
  return kind || "Unknown";
}

function whatsappStatusLabel(status = {}) {
  const state = pickString(status.state, status.status).toLowerCase();
  const lifecycle = status.turnLifecycle || {};
  if (status.error) return "Status unavailable";
  if (lifecycle.awaitingApproval === true || state === "awaiting_approval") return "Awaiting approval";
  if (status.frozen === true || state === "frozen") return "Frozen";
  if (status.working === true || lifecycle.running === true || state === "working" || state === "running") return "Working";
  if (state === "waking") return "Waking";
  if (numberCount(status.pendingCount) || numberCount(status.awaitingAckCount) || lifecycle.queued === true) return "Queued";
  if (state === "sleeping" || state === "unloaded" || status.hibernated === true) return "Sleeping";
  if (state === "ready") return "Ready";
  if (state === "failed") return "Failed";
  if (state === "migration_required") return "Migration required";
  return state ? state.replace(/_/g, " ") : "Unknown";
}

function whatsappStatusSinceMs({ label = "", status = {}, thread = {}, messages = [] } = {}) {
  const activeTurnId = pickString(status.activeTurnId, status.turnId, status.turnLifecycle?.activeTurnId);
  if (activeTurnId) {
    const activeMessage = latestMessageBy(messages, (message) =>
      message?.role === "user" &&
      [message.codexTurnId, message.executorTurnId].some((value) => pickString(value) === activeTurnId)
    );
    const activeMs = messageTimestampMs(activeMessage);
    if (activeMs) return activeMs;
  }
  const normalized = pickString(label).toLowerCase();
  if (normalized === "working") {
    const running = latestMessageBy(messages, (message) => message?.role === "user" && message.state === "running");
    const runningMs = messageTimestampMs(running);
    if (runningMs) return runningMs;
  }
  if (normalized === "queued" || normalized === "waking" || normalized === "awaiting approval") {
    const pending = earliestMessageBy(messages, (message) =>
      message?.role === "user" &&
      ["queued", "pending_delivery", "awaiting_ack", "running"].includes(String(message.state || ""))
    );
    const pendingMs = messageTimestampMs(pending);
    if (pendingMs) return pendingMs;
  }
  return timestampValueMs(status.lease?.startedAt || thread.runtime?.activeTurnObservedAt || thread.runtime?.updatedAt || thread.updatedAt);
}

function formatWhatsAppRouterStatus({ thread = {}, status = {}, messages = [], nowMs = Date.now() } = {}) {
  const label = whatsappStatusLabel(status);
  const sinceMs = whatsappStatusSinceMs({ label, status, thread, messages });
  const statusLine = sinceMs ? `${label} for ${compactDuration(nowMs - sinceMs)}` : label;
  const pendingCount = numberCount(status.pendingCount) || messages.filter((message) => message?.role === "user" && ["queued", "pending_delivery"].includes(String(message.state || ""))).length;
  const runningCount = numberCount(status.runningCount) || messages.filter((message) => message?.role === "user" && message.state === "running").length;
  const awaitingAckCount = numberCount(status.awaitingAckCount) || messages.filter((message) => message?.role === "user" && message.state === "awaiting_ack").length;
  const activeTurnId = pickString(status.activeTurnId, status.turnId, status.turnLifecycle?.activeTurnId);
  const lastInput = latestMessageBy(messages, (message) => message?.role === "user");
  const lastReply = latestMessageBy(messages, (message) => message?.role === "assistant" && message.state === "completed");
  const lines = [
    `Thread: ${pickString(thread.name, thread.title, thread.id)}`,
    `Status: ${statusLine}`,
    `Runtime: ${whatsappStatusRuntimeLabel(thread, status)}`,
    `Queue: ${pendingCount} pending, ${runningCount} running, ${awaitingAckCount} awaiting ack`,
  ];
  if (activeTurnId) lines.push(`Active turn: ${shortStatusId(activeTurnId)}`);
  const lastInputText = relativeTimestamp(lastInput?.createdAt || lastInput?.deliveredAt || lastInput?.updatedAt, nowMs);
  if (lastInputText) lines.push(`Last input: ${lastInputText}`);
  const lastReplyText = relativeTimestamp(lastReply?.createdAt || lastReply?.deliveredAt || lastReply?.updatedAt, nowMs);
  if (lastReplyText) lines.push(`Last reply: ${lastReplyText}`);
  const retryText = relativeTimestamp(status.nextDeliveryAttemptAt, nowMs);
  if (retryText) lines.push(`Next retry: ${retryText}`);
  if (status.error) lines.push(`Error: ${String(status.error || "").slice(0, 180)}`);
  return lines.join("\n");
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function sameWhatsAppInboundSender(left = {}, right = {}) {
  const leftFrom = pickString(left.from, left.sender, left.author);
  const rightFrom = pickString(right.from, right.sender, right.author);
  return !leftFrom || !rightFrom || leftFrom === rightFrom;
}

function coalescedWhatsAppText(left = "", right = "") {
  const first = String(left || "").trim();
  const second = String(right || "").trim();
  if (!first) return second;
  if (!second || first.includes(second)) return first;
  return `${first}\n\n${second}`;
}

function coalescedWhatsAppAttachments(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const attachment of Array.isArray(group) ? group : []) {
      const key = [
        pickString(attachment?.path, attachment?.url, attachment?.id),
        pickString(attachment?.filename, attachment?.name),
        pickString(attachment?.mimetype, attachment?.type),
      ].join("\n");
      if (key.trim() && seen.has(key)) continue;
      if (key.trim()) seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function hasWhatsAppInboundAttachments(message = {}) {
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

function whatsappInboundPayloadsCanCoalesce(existing = {}, input = {}) {
  if (!hasWhatsAppInboundAttachments(existing) && !hasWhatsAppInboundAttachments(input)) return false;
  const existingText = String(existing.text || "").trim();
  const nextText = String(input.text || "").trim();
  if (existingText && nextText && existingText === nextText) return false;
  return true;
}

function recentCoalescibleWhatsAppInput(messages = [], input = {}, env = process.env) {
  const windowMs = whatsappInboundCoalesceMs(env);
  if (windowMs <= 0 || pickString(input.promptFile)) return null;
  const receivedMs = timestampMs(input.receivedAt || input.timestamp) || Date.now();
  return [...messages].reverse().find((message) => {
    if (message?.role !== "user") return false;
    if (message.source !== "whatsapp_inbound" || message.connector !== "whatsapp") return false;
    if (pickString(message.promptFile)) return false;
    if (!whatsappInboundPayloadsCanCoalesce(message, input)) return false;
    if (pickString(message.chatId) !== pickString(input.chatId)) return false;
    if (!sameWhatsAppInboundSender(message, input)) return false;
    const state = pickString(message.state).toLowerCase();
    if (state === "failed" || state === "cancelled") return false;
    const messageMs = timestampMs(message.createdAt || message.timestamp);
    if (!messageMs || receivedMs - messageMs < 0 || receivedMs - messageMs > windowMs) return false;
    return !messages.some((candidate) =>
      candidate?.role === "assistant" &&
      candidate.parentMessageId === message.id &&
      candidate.state === "completed"
    );
  }) || null;
}

async function coalesceWhatsAppInboundThreadMessage({ thread, messageInput, eventId, canonicalEventId, routerTraceId, turnId, accountId, env = process.env } = {}) {
  if (!thread?.id) return null;
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const existing = recentCoalescibleWhatsAppInput(messages, messageInput, env);
  if (!existing) return null;
  const coalescedEventIds = [
    ...new Set([
      ...(Array.isArray(existing.coalescedEventIds) ? existing.coalescedEventIds : []),
      pickString(existing.sourceEventId),
      eventId,
    ].filter(Boolean)),
  ];
  const patch = {
    text: coalescedWhatsAppText(existing.text, messageInput.text),
    attachments: coalescedWhatsAppAttachments(existing.attachments, messageInput.attachments),
    coalescedEventIds,
    coalescedAt: new Date().toISOString(),
    coalescedCount: coalescedEventIds.length,
  };
  if (messageInput.steerActiveTurn === true) patch.steerActiveTurn = true;
  if (pickString(messageInput.codexDeliveryMode)) patch.codexDeliveryMode = pickString(messageInput.codexDeliveryMode);
  const message = await updateThreadMessage(thread.id, existing.id, patch, env);
  await appendEvent({
    type: "whatsapp_inbound_coalesced",
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    threadId: thread.id,
    messageId: message.id,
    chatId: pickString(messageInput.chatId),
    accountId,
    coalescedCount: patch.coalescedCount,
  }, env).catch(() => {});
  return message;
}

async function handleWhatsAppRouterStatusCommand({
  input = {},
  thread,
  messageInput,
  state,
  eventId,
  canonicalEventId,
  routerTraceId,
  turnId,
  threadId,
  chatId,
  from,
  accountId,
  inboundDedupeKey,
  threadRoute = {},
  env = process.env,
} = {}) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const status = await runtimeStatus(thread.id, env, messages).catch((error) => ({
    state: "unknown",
    status: "unknown",
    runtimeState: "unknown",
    runtimeKind: pickString(thread.runtimeKind, thread.runtime?.runtimeKind, thread.executor?.metadata?.runtimeKind),
    pendingCount: messages.filter((message) => message?.role === "user" && ["queued", "pending_delivery"].includes(String(message.state || ""))).length,
    awaitingAckCount: messages.filter((message) => message?.role === "user" && message.state === "awaiting_ack").length,
    runningCount: messages.filter((message) => message?.role === "user" && message.state === "running").length,
    error: String(error?.message || error || "status_unavailable").slice(0, 200),
  }));
  const replyText = formatWhatsAppRouterStatus({ thread, status, messages });
  const message = await appendThreadMessage(thread.id, {
    ...messageInput,
    role: "user",
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: new Date().toISOString(),
    observedVia: "whatsapp_router_status_command",
  }, env);
  const event = {
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    agentId: null,
    threadId,
    messageId: message.id,
    chatId,
    from,
    accountId,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
    receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
  };
  if (message.duplicate) {
    const existingReply = messages.find((candidate) =>
      candidate?.role === "assistant" &&
      candidate?.source === "whatsapp_router" &&
      candidate?.parentMessageId === message.id &&
      sameOptionalEventField(candidate, { connector: "whatsapp" }, "connector") &&
      sameOptionalEventField(candidate, { chatId }, "chatId") &&
      sameOptionalEventField(candidate, { accountId }, "accountId")
    ) || null;
    if (existingReply) {
      state.inboundEvents = [...(state.inboundEvents || []), event];
      await writeWhatsAppState(state, env);
      await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: "completed" }, env).catch(() => null);
      await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "skipped", reason: "duplicate_status_command", terminal: true }, env).catch(() => {});
      await appendEvent({
        type: "whatsapp_inbound_duplicate",
        eventId,
        canonicalEventId,
        routerTraceId,
        agentId: null,
        threadId,
        messageId: message.id,
        replyMessageId: existingReply.id,
        duplicateReason: "duplicate_status_command",
      }, env).catch(() => {});
      return {
        duplicate: true,
        handledCommand: "status",
        event,
        agentId: null,
        threadId,
        ownerUserId: resourceOwnerUserId(thread, env),
        autoProvisioned: threadRoute.autoProvisioned === true,
        createdThread: threadRoute.createdThread === true,
        userId: threadRoute.user?.id || null,
        message,
        assistantMessage: existingReply,
        status,
      };
    }
  }
  const reply = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "whatsapp_router",
    phase: "final_answer",
    text: replyText,
    state: "completed",
    parentMessageId: message.id,
    connector: "whatsapp",
    routerTraceId,
    turnId,
    chatId,
    accountId,
  }, env);
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeWhatsAppState(state, env);
  await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: "completed" }, env).catch(() => null);
  await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "routed" }, env).catch(() => {});
  await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "completed", reason: "status_command", terminal: true }, env).catch(() => {});
  await appendEvent({
    type: "whatsapp_router_status_command",
    eventId,
    canonicalEventId,
    routerTraceId,
    threadId,
    messageId: message.id,
    replyMessageId: reply.id,
    chatId,
    accountId,
    runtimeKind: status.runtimeKind || null,
    runtimeState: status.state || status.status || null,
  }, env).catch(() => {});
  return {
    duplicate: false,
    handledCommand: "status",
    event,
    agentId: null,
    threadId,
    ownerUserId: resourceOwnerUserId(thread, env),
    autoProvisioned: threadRoute.autoProvisioned === true,
    createdThread: threadRoute.createdThread === true,
    userId: threadRoute.user?.id || null,
    message,
    assistantMessage: reply,
    status,
  };
}

export async function routeWhatsAppInbound(input = {}, env = process.env, fetchImpl = fetch) {
  const config = await readConnectorConfig("whatsapp", env);
  const eventId = pickString(input.eventId, input.id, input.messageId);
  const canonicalEventId = canonicalWhatsAppEventId(eventId);
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

  let state = await readWhatsAppState(env);
  let threadRoute = await routeThread(input, config, env);
  const securityApproval = await maybeApprovePairingChallengeFromWhatsApp({
    input,
    env,
    state,
    writeState: writeWhatsAppState,
    eventId,
    canonicalEventId,
    routerTraceId: initialTraceId,
    turnId: initialTurnId,
    chatId: initialChatId,
    accountId: initialAccountId,
    threadRoute,
  });
  if (securityApproval) return securityApproval;

  const accountPolicy = whatsappInboundAccountPolicy(input, config, state, env);
  if (!accountPolicy.allowed) {
    threadRoute = await routeThread(input, config, env);
  }
  if (!accountPolicy.allowed && !threadRoute?.binding) {
    await ensureRouterTurn({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      eventId,
      threadId: "",
      state: "skipped",
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      sourceEventId: eventId,
      phase: "skipped",
      reason: accountPolicy.reason,
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_inbound_non_sender_ignored",
      eventId,
      canonicalEventId,
      routerTraceId: initialTraceId,
      chatId: initialChatId,
      accountId: initialAccountId,
      expectedAccountId: accountPolicy.expectedAccountId || "",
      reason: accountPolicy.reason,
    }, env).catch(() => {});
    return {
      duplicate: false,
      skipped: accountPolicy.reason,
      ignoredNonSenderAccount: true,
      agentId: null,
      threadId: null,
      messageId: null,
    };
  }
  const incomingEventIdentity = { eventId, canonicalEventId, chatId: initialChatId };
  const existing = (state.inboundEvents || []).find((event) =>
    event.eventId === eventId || sameWhatsAppSourceEvent(event, incomingEventIdentity)
  );
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
      reason: existing.eventId === eventId ? "duplicate_event_id" : "duplicate_source_message",
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_inbound_duplicate",
      eventId,
      canonicalEventId,
      routerTraceId: pickString(existing.routerTraceId, initialTraceId),
      agentId: existing.agentId || null,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
      duplicateReason: existing.eventId === eventId ? "duplicate_event_id" : "duplicate_source_message",
    }, env);
    return {
      duplicate: true,
      event: existing,
      agentId: existing.agentId || null,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
    };
  }

  const connectorOutboxJobs = (await listConnectorOutboxJobs({
    connector: "whatsapp",
    limit: 1000,
  }, env).catch(() => ({ jobs: [] }))).jobs || [];
  const outboundEchoDeliveryByAck = outboundEchoDeliveryForEvent(state.outboundDeliveries || [], connectorOutboxJobs, input);
  const outboundEchoDeliveryByText = outboundEchoDeliveryByAck
    ? null
    : outboundEchoDeliveryForText(state.outboundDeliveries || [], connectorOutboxJobs, input, env);
  const outboundEchoDelivery = outboundEchoDeliveryByAck || outboundEchoDeliveryByText;
  if (outboundEchoDelivery) {
    const ignoredReason = outboundEchoDeliveryByAck ? "outbound_echo_delivery_ack" : "outbound_echo_delivery_text";
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      agentId: null,
      threadId: pickString(outboundEchoDelivery.threadId) || null,
      messageId: null,
      chatId: initialChatId,
      from: pickString(input.from, input.sender, input.author),
      accountId: initialAccountId,
      ignoredReason,
      outboundMessageId: pickString(outboundEchoDelivery.messageId),
      outboundDeliveryType: pickString(outboundEchoDelivery.deliveryType),
      connectorOutboxJobId: pickString(outboundEchoDelivery.connectorOutboxJobId),
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      eventId,
      threadId: pickString(outboundEchoDelivery.threadId) || "",
      state: "skipped",
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      sourceEventId: eventId,
      threadId: pickString(outboundEchoDelivery.threadId) || "",
      phase: "skipped",
      reason: ignoredReason,
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_outbound_echo_ignored",
      eventId,
      canonicalEventId,
      routerTraceId: initialTraceId,
      threadId: pickString(outboundEchoDelivery.threadId) || null,
      chatId: initialChatId,
      accountId: initialAccountId,
      messageId: pickString(outboundEchoDelivery.messageId),
      deliveryType: pickString(outboundEchoDelivery.deliveryType),
      ignoredReason,
    }, env).catch(() => {});
    return {
      duplicate: false,
      skipped: ignoredReason,
      ignoredOutboundEcho: true,
      event,
      agentId: null,
      threadId: pickString(outboundEchoDelivery.threadId) || null,
    };
  }

  const disabledThreadForInbound = async (routedThreadId = "") => {
    if (routedThreadId) return getThread(routedThreadId, env).catch(() => null);
    if (!initialChatId) return null;
    const threads = await listThreads(env).catch(() => []);
    return threads.find((thread) => {
      const binding = thread?.binding || {};
      if (binding.connector !== "whatsapp" || binding.enabled !== false || binding.retired === true || binding.deprecated === true) return false;
      if (pickString(binding.chatId) !== initialChatId) return false;
      const accounts = bindingAccountIds(binding);
      return !accounts.size || !initialAccountId || accounts.has(initialAccountId);
    }) || null;
  };

  const skipDisabledBinding = async (routedThreadId = "") => {
    const routedThread = await disabledThreadForInbound(routedThreadId);
    const binding = threadRoute.binding || routedThread?.binding || {};
    if (binding.connector === "whatsapp" && !whatsappBindingIsRouteEligible(binding)) {
      const disabledThreadId = routedThreadId || routedThread?.id || "";
      const event = {
        eventId,
        canonicalEventId,
        routerTraceId: initialTraceId,
        turnId: initialTurnId,
        agentId: null,
        threadId: disabledThreadId,
        messageId: null,
        chatId: initialChatId,
        from: pickString(input.from, input.sender, input.author),
        accountId: initialAccountId,
        ignoredReason: "disabled_whatsapp_binding",
        receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
      };
      state.inboundEvents = [...(state.inboundEvents || []), event];
      await writeWhatsAppState(state, env);
      await ensureRouterTurn({
        routerTraceId: initialTraceId,
        turnId: initialTurnId,
        connector: "whatsapp",
        accountId: initialAccountId,
        chatId: initialChatId,
        eventId,
        threadId: disabledThreadId,
        state: "skipped",
      }, env).catch(() => null);
      await recordRouterTraceEvent({
        routerTraceId: initialTraceId,
        turnId: initialTurnId,
        connector: "whatsapp",
        accountId: initialAccountId,
        chatId: initialChatId,
        sourceEventId: eventId,
        threadId: disabledThreadId,
        phase: "skipped",
        reason: "disabled_whatsapp_binding",
        terminal: true,
      }, env).catch(() => {});
      await appendEvent({
        type: "whatsapp_disabled_binding_inbound_ignored",
        eventId,
        canonicalEventId,
        routerTraceId: initialTraceId,
        threadId: disabledThreadId,
        chatId: initialChatId,
        accountId: initialAccountId,
      }, env).catch(() => {});
      return {
        duplicate: false,
        skipped: true,
        ignoredDisabledBinding: true,
        event,
        agentId: null,
        threadId: disabledThreadId,
      };
    }
    return null;
  };

  threadRoute ||= await routeThread(input, config, env);
  if (!threadRoute.threadId) {
    const rebound = await maybeRebindTenantVmBootstrapThread(input, env);
    if (rebound?.threadId) threadRoute = rebound;
  }
  if (!threadRoute.threadId) {
    const restoredBrokerBinding = await maybeBindApprovedBrokerChat({
      input,
      env,
      state,
      chatId: initialChatId,
      accountId: initialAccountId,
    }).catch((error) => {
      appendEvent({
        type: "whatsapp_approved_broker_chat_bind_recovery_failed",
        chatId: initialChatId,
        accountId: initialAccountId,
        error: String(error?.message || error || "approved_broker_bind_recovery_failed").slice(0, 240),
      }, env).catch(() => {});
      return null;
    });
    if (restoredBrokerBinding?.ok) threadRoute = await routeThread(input, config, env);
  }
  if (!threadRoute.threadId) threadRoute = await routeAutoProvisionedThread(input, config, env);
  const threadId = threadRoute.threadId;
  const agentId = threadId ? "" : routeAgentId(input, config);
  const bindingAccountPolicy = threadRoute.binding
    ? whatsappBindingInboundAccountPolicy(input, threadRoute.binding, state, env)
    : { allowed: true };
  if (!bindingAccountPolicy.allowed) {
    await ensureRouterTurn({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      eventId,
      threadId: threadId || "",
      state: "skipped",
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId: initialTraceId,
      turnId: initialTurnId,
      connector: "whatsapp",
      accountId: initialAccountId,
      chatId: initialChatId,
      sourceEventId: eventId,
      threadId: threadId || "",
      phase: "skipped",
      reason: bindingAccountPolicy.reason,
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_inbound_non_sender_ignored",
      eventId,
      canonicalEventId,
      routerTraceId: initialTraceId,
      threadId: threadId || null,
      chatId: initialChatId,
      accountId: initialAccountId,
      expectedAccountId: bindingAccountPolicy.expectedAccountId || "",
      reason: bindingAccountPolicy.reason,
    }, env).catch(() => {});
    return {
      duplicate: false,
      skipped: bindingAccountPolicy.reason,
      ignoredNonSenderAccount: true,
      agentId: null,
      threadId: threadId || null,
      messageId: null,
    };
  }
  if (!threadId && !agentId) {
    const disabledExplicit = await skipDisabledBinding(pickString(input.threadId, input.targetThreadId));
    if (disabledExplicit) return disabledExplicit;
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
  const disabledTarget = await skipDisabledBinding(threadId);
  if (disabledTarget) return disabledTarget;

  const text = stripWhatsAppDebugFooter(pickString(input.text, input.body, input.message));
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
  const inboundDedupeKey = whatsappInboundContentDedupeKey({
    chatId,
    from,
    text,
    promptFile,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    timestamp: pickString(input.timestamp, input.receivedAt),
  });
  const existingContentEvent = inboundDedupeKey
    ? [...(state.inboundEvents || [])].reverse().find((event) =>
        event.inboundDedupeKey === inboundDedupeKey &&
        event.messageId &&
        sameOptionalEventField(event, { chatId }, "chatId")
      ) || null
    : null;
  if (existingContentEvent) {
    await recordRouterTraceEvent({
      routerTraceId: pickString(existingContentEvent.routerTraceId, routerTraceId),
      turnId: pickString(existingContentEvent.turnId, turnId),
      connector: "whatsapp",
      accountId: pickString(existingContentEvent.accountId, accountId),
      chatId: pickString(existingContentEvent.chatId, chatId),
      sourceEventId: eventId,
      threadId: existingContentEvent.threadId || null,
      messageId: existingContentEvent.messageId,
      phase: "skipped",
      reason: "duplicate_source_content",
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_inbound_duplicate",
      eventId,
      canonicalEventId,
      routerTraceId: pickString(existingContentEvent.routerTraceId, routerTraceId),
      agentId: existingContentEvent.agentId || null,
      threadId: existingContentEvent.threadId || null,
      messageId: existingContentEvent.messageId,
      duplicateReason: "duplicate_source_content",
    }, env);
    return {
      duplicate: true,
      event: existingContentEvent,
      agentId: existingContentEvent.agentId || null,
      threadId: existingContentEvent.threadId || null,
      messageId: existingContentEvent.messageId,
    };
  }
  if (!promptFile && generatedWhatsAppQueueNoticeText(text)) {
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: agentId || null,
      threadId: threadId || null,
      messageId: null,
      chatId,
      from,
      accountId,
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
      ignoredReason: "generated_queue_notice",
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId: threadId || "", state: "skipped" }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      threadId: threadId || "",
      phase: "skipped",
      reason: "generated_queue_notice",
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_generated_queue_notice_ignored",
      eventId,
      routerTraceId,
      agentId: agentId || null,
      threadId: threadId || null,
      chatId,
    }, env);
    return {
      duplicate: false,
      skipped: true,
      ignoredGeneratedQueueNotice: true,
      event,
      agentId: agentId || null,
      threadId: threadId || null,
    };
  }
  const messageInput = {
    role: "user",
    source: "whatsapp_inbound",
    originSurface: "whatsapp",
    originTransport: "whatsapp-local-bridge",
    connector: "whatsapp",
    externalId: canonicalEventId || eventId,
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
  const inboundSecurity = evaluateWhatsAppInboundSecurity({
    binding: {
      ...(thread?.binding || {}),
      ...(threadRoute.binding || {}),
    },
    input: { ...input, chatId, from, accountId, text },
    state,
    thread: thread || {},
    env,
  });
  messageInput.externalPrincipal = inboundSecurity.participant;
  messageInput.senderParticipantId = inboundSecurity.participant?.senderId || "";
  messageInput.senderTrustLevel = inboundSecurity.trustLevel || "unknown";
  messageInput.senderPolicyMode = inboundSecurity.policyMode || "";
  messageInput.securityClassification = inboundSecurity.classified || null;
  if (!inboundSecurity.allowed) {
    const blocked = inboundSecurity.action === "block";
    if (blocked) state = addWhatsAppInboundSecurityBlock(state, inboundSecurity);
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: agentId || null,
      threadId: threadId || null,
      messageId: null,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
      ignoredReason: blocked ? "inbound_security_blocked" : "inbound_security_denied",
      inboundSecurity: {
        reason: inboundSecurity.reason,
        action: inboundSecurity.action || "deny",
        trustLevel: inboundSecurity.trustLevel,
        policyMode: inboundSecurity.policyMode,
        classified: inboundSecurity.classified,
      },
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId: thread?.id || threadId || "", state: "skipped" }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      threadId: thread?.id || threadId || "",
      phase: "skipped",
      reason: event.ignoredReason,
      terminal: true,
    }, env).catch(() => {});
    await appendEvent({
      type: blocked ? "whatsapp_inbound_security_blocked" : "whatsapp_inbound_security_denied",
      eventId,
      canonicalEventId,
      routerTraceId,
      threadId: thread?.id || threadId || null,
      chatId,
      accountId,
      from,
      reason: inboundSecurity.reason,
      trustLevel: inboundSecurity.trustLevel,
      policyMode: inboundSecurity.policyMode,
    }, env).catch(() => {});
    throw whatsappInboundSecurityError(inboundSecurity, {
      routerTraceId,
      accountId,
      chatId,
      threadId: thread?.id || threadId || "",
    });
  }
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
  if (threadId && thread && whatsappRouterStatusCommand(text)) {
    return handleWhatsAppRouterStatusCommand({
      input,
      thread,
      messageInput,
      state,
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      threadId,
      chatId,
      from,
      accountId,
      inboundDedupeKey,
      threadRoute,
      env,
    });
  }
  const desktopApproveChallenge = desktopShareApproveChallengeId(text);
  if (threadId && thread && desktopApproveChallenge) {
    const message = await appendThreadMessage(thread.id, {
      ...messageInput,
      role: "user",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "desktop_share_approve_command",
      deliveredAt: new Date().toISOString(),
    }, env);
    let replyText = "";
    let approved = null;
    try {
      approved = await approveDesktopShareChallenge(desktopApproveChallenge, {
        env,
        approvedBy: `whatsapp:${thread.id}`,
      });
      const desktopLabel = pickString(approved.share?.desktopSlug, "desktop");
      replyText = `Desktop access approved for ${desktopLabel}. The desktop link should open in the browser where you generated the challenge.`;
    } catch {
      replyText = "That desktop challenge is not pending or has expired. Open a fresh desktop link and paste the new challenge here.";
    }
    await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop_share_approve",
      phase: "final_answer",
      text: replyText,
      state: "completed",
      parentMessageId: message.id,
      connector: "whatsapp",
      routerTraceId,
      turnId,
      chatId,
      accountId,
      desktopShareChallengeId: desktopApproveChallenge,
      desktopShareId: pickString(approved?.share?.id),
    }, env);
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: message.id, state: "completed" }, env).catch(() => null);
    await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "routed" }, env).catch(() => {});
    await recordRouterTraceEvent({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, sourceEventId: eventId, threadId, messageId: message.id, phase: "completed", reason: approved ? "desktop_share_approved" : "desktop_share_approve_failed", terminal: true }, env).catch(() => {});
    await appendEvent({
      type: approved ? "whatsapp_desktop_share_challenge_approved" : "whatsapp_desktop_share_challenge_approve_failed",
      eventId,
      canonicalEventId,
      threadId,
      messageId: message.id,
      chatId,
      desktopShareChallengeId: desktopApproveChallenge,
      desktopShareId: pickString(approved?.share?.id),
    }, env);
    return {
      duplicate: false,
      handledCommand: "desktop_share_approve",
      desktopShareApproved: Boolean(approved),
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
  if (threadId && thread && googleWorkspaceConnectCommand(text)) {
    const message = await appendThreadMessage(thread.id, {
      ...messageInput,
      role: "user",
      state: "completed",
      deliveryState: "delivered",
      observedVia: "google_workspace_connect_command",
      deliveredAt: new Date().toISOString(),
    }, env);
    const connect = await createGoogleWorkspaceConnectLink({
      principal: await principalForThread(thread, env),
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
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
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
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId: threadId || null,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
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
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: message.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
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
  if (whatsappInboundInstantSteerEnabled({ thread, binding: threadRoute.binding, chatId, env })) {
    messageInput.codexDeliveryMode = "instant_steer";
    messageInput.steerActiveTurn = true;
  }
  const coalescedMessage = threadId && thread
    ? await coalesceWhatsAppInboundThreadMessage({
        thread,
        messageInput,
        eventId,
        canonicalEventId,
        routerTraceId,
        turnId,
        accountId,
        env,
      })
    : null;
  if (coalescedMessage) {
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId,
      messageId: coalescedMessage.id,
      chatId,
      from,
      accountId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
      coalesced: true,
      receivedAt: pickString(input.timestamp, input.receivedAt) || new Date().toISOString(),
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeWhatsAppState(state, env);
    await ensureRouterTurn({ routerTraceId, turnId, connector: "whatsapp", accountId, chatId, eventId, threadId, messageId: coalescedMessage.id, state: "queued" }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      threadId,
      messageId: coalescedMessage.id,
      phase: "queued",
      reason: "coalesced_inbound_burst",
    }, env).catch(() => {});
    if (thread && input.deferApiAgentAutoRun !== true) scheduleWhatsAppApiAgentThreadKick(thread, env);
    return {
      duplicate: false,
      coalesced: true,
      event,
      agentId: null,
      threadId,
      ownerUserId: resourceOwnerUserId(thread, env),
      autoProvisioned: threadRoute.autoProvisioned === true,
      createdThread: threadRoute.createdThread === true,
      userId: threadRoute.user?.id || null,
      message: coalescedMessage,
    };
  }
  let message = threadId
    ? await enqueueThreadInputForPrincipal(threadId, messageInput, await principalForThread(thread, env), env)
    : await enqueueAgentMessage(agentId, messageInput, env);
  const contentDuplicate = Boolean(message.duplicate);
  if (threadId && !contentDuplicate) {
    message = await annotateInitialThreadQueueNotice(threadId, message, env);
  }
  const event = {
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId: message.id,
    chatId,
    from,
    accountId,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    ...(inboundDedupeKey ? { inboundDedupeKey } : {}),
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
  if (thread && !contentDuplicate && input.deferApiAgentAutoRun !== true) scheduleWhatsAppApiAgentThreadKick(thread, env);
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

async function listMessageSets(env, state = null) {
  const paths = await ensureDataDirs(env);
  const files = await fs.readdir(paths.messages).catch(() => []);
  const sets = [];
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const agentId = path.basename(file, ".json");
    const messageSetKey = outboundMirrorMessageSetKey({ kind: "agent", agentId });
    const messages = await readWhatsAppMirrorMessageSet(path.join(paths.messages, file), messageSetKey, state, env);
    if (Array.isArray(messages)) sets.push({ agentId, messages });
  }
  return sets;
}

function safeMessageFileId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function whatsappMirrorScanOverlap(env = process.env) {
  return positiveInteger(env.ORKESTR_WHATSAPP_OUTBOUND_SCAN_CURSOR_OVERLAP, 25, 0);
}

function whatsappMirrorInitialTailLimit(env = process.env) {
  return positiveInteger(env.ORKESTR_WHATSAPP_OUTBOUND_SCAN_TAIL_LIMIT, 250, 1);
}

function recentApiSessionWhatsAppReply(message = {}, env = process.env) {
  if (pickString(message?.source) !== "api-session") return false;
  if (pickString(message?.role).toLowerCase() !== "assistant") return false;
  if (pickString(message?.state).toLowerCase() !== "completed") return false;
  if (pickString(message?.connector).toLowerCase() !== "whatsapp") return false;
  if (!pickString(message?.chatId)) return false;
  const windowMs = whatsappLiveOutputRecoveryWindowMs(env);
  if (!windowMs) return false;
  const createdMs = messageTimeMs(message);
  return Boolean(createdMs && Date.now() - createdMs <= windowMs);
}

function mergeCursorScanMessages(messages = [], extras = []) {
  const merged = [];
  const seen = new Set();
  for (const message of [...messages, ...extras]) {
    const id = pickString(message?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(message);
  }
  return merged.sort((left, right) =>
    outboundMirrorMessageCursor(left, 0) - outboundMirrorMessageCursor(right, 0)
  );
}

function messagesAfterMirrorCursor(messages = [], cursor = 0, env = process.env) {
  const list = Array.isArray(messages) ? messages : [];
  const numericCursor = Math.max(0, Number(cursor || 0) || 0);
  let start = Math.max(0, list.length - whatsappMirrorInitialTailLimit(env));
  const recentApiSessionReplies = list.filter((message) => recentApiSessionWhatsAppReply(message, env));
  if (numericCursor > 0) {
    const threshold = Math.max(0, numericCursor - whatsappMirrorScanOverlap(env));
    const cursorStart = list.findIndex((message, index) => outboundMirrorMessageCursor(message, index) > threshold);
    if (cursorStart < 0) return recentApiSessionReplies;
    start = cursorStart;
  }
  const cursorMessages = list.slice(start).map((message, index) =>
    Number(message?.cursor || 0) > 0 ? message : { ...message, cursor: start + index + 1 }
  );
  return mergeCursorScanMessages(cursorMessages, recentApiSessionReplies);
}

async function readWhatsAppMirrorMessageSet(filePath, messageSetKey, state = null, env = process.env) {
  const cursor = Number(outboundMirrorCursorMap(state?.outboundMirrorCursors || []).get(messageSetKey)?.cursor || 0) || 0;
  const stat = await fs.stat(filePath).catch(() => null);
  const signature = stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
  const stateSignature = whatsappMirrorStateSignature(state, messageSetKey, cursor);
  const cacheKey = `${filePath}:${messageSetKey}`;
  const cached = whatsappMirrorMessageFileCache.get(cacheKey);
  if (
    cursor > 0 &&
    !messageSetHasActiveWhatsAppOutboundIntent(state, messageSetKey) &&
    cached?.signature === signature &&
    cached?.stateSignature === stateSignature
  ) return null;
  const messages = await readJson(filePath, []);
  whatsappMirrorMessageFileCache.set(cacheKey, { signature, stateSignature });
  return messagesAfterMirrorCursor(messages, cursor, env);
}

function messageSetHasActiveWhatsAppOutboundIntent(state = null, messageSetKey = "") {
  return (state?.outboundIntents || []).some((intent) => {
    if (String(intent?.messageSetKey || "") !== String(messageSetKey || "")) return false;
    const status = String(intent?.status || "pending").trim().toLowerCase();
    return status !== "delivered" && status !== "skipped" && status !== "cancelled";
  });
}

function whatsappMirrorStateSignature(state = null, messageSetKey = "", cursor = 0) {
  const recentIntentState = (state?.outboundIntents || []).slice(-100).map((intent) => [
    intent?.messageSetKey || "",
    intent?.messageId || "",
    intent?.status || "",
    intent?.error || "",
    intent?.deliveryType || "",
    intent?.updatedAt || "",
    intent?.deliveredAt || "",
    intent?.failedAt || "",
  ]);
  const recentDeliveryState = (state?.outboundDeliveries || []).slice(-100).map((delivery) => [
    delivery?.messageSetKey || "",
    delivery?.messageId || "",
    delivery?.parentMessageId || "",
    delivery?.deliveryType || "",
    delivery?.chatId || "",
    delivery?.accountId || "",
    delivery?.deliveredAt || "",
  ]);
  return JSON.stringify({ messageSetKey, cursor, recentIntentState, recentDeliveryState });
}

function threadConfiguredForWhatsAppRoute(thread = {}, config = {}) {
  const routes = Object.values(config.threadRoutes || config.threads || {}).map((value) => String(value || "").trim()).filter(Boolean);
  const defaultThreadId = pickString(config.defaultThreadId);
  const ids = [thread.id, thread.name, thread.bindingName].map((value) => String(value || "").trim()).filter(Boolean);
  return ids.some((id) => routes.includes(id) || id === defaultThreadId);
}

function threadEligibleForWhatsAppMirrorScan(thread = {}, config = {}) {
  if (thread?.binding?.chatId || String(thread?.binding?.connector || "").trim().toLowerCase() === "whatsapp") return true;
  return threadConfiguredForWhatsAppRoute(thread, config);
}

function bridgeErrorText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return value.message || String(value);
  if (typeof value !== "object") return String(value || "").trim();
  const code = pickString(value.code, value.errorCode, value.reason, value.status);
  const message = pickString(value.message, value.error, value.detail, value.details, value.description);
  if (code && message && code !== message) return `${code}: ${message}`;
  return pickString(message, code, JSON.stringify(value));
}

function whatsappSendFailureMessage(payload = {}, status = 0) {
  return pickString(
    bridgeErrorText(payload.error),
    bridgeErrorText(payload.reason),
    bridgeErrorText(payload.message),
    status ? `whatsapp_send_failed_${status}` : "whatsapp_send_failed",
  );
}

async function listThreadMessageSets(env, state = null, config = {}) {
  const paths = await ensureDataDirs(env);
  const sets = [];
  for (const thread of await listThreads(env)) {
    if (!threadEligibleForWhatsAppMirrorScan(thread, config)) continue;
    const messageSetKey = outboundMirrorMessageSetKey({ kind: "thread", threadId: thread.id });
    const filePath = path.join(paths.threadMessages, `${safeMessageFileId(thread.id)}.json`);
    const messages = await readWhatsAppMirrorMessageSet(filePath, messageSetKey, state, env);
    if (Array.isArray(messages)) sets.push({ threadId: thread.id, thread, messages });
  }
  return sets;
}

/**
 * @param {{ chatId?: string, text?: string, accountId?: string, attachments?: Array<Record<string, unknown>>, crossAccountEchoSuppression?: boolean, routeSentMessage?: boolean, config?: Record<string, unknown> | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} [options]
 */
export async function sendWhatsAppText({ chatId = "", text = "", accountId = "", attachments = [], crossAccountEchoSuppression = true, routeSentMessage = false, config = null, env = process.env, fetchImpl = fetch } = {}) {
  const resolvedConfig = config || await readConnectorConfig("whatsapp", env).catch(() => ({}));
  const bridgeUrl = configuredBridgeUrl(resolvedConfig, env);
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map((attachment) => ({
        ...attachment,
        path: String(attachment?.path || "").trim(),
      })).filter((attachment) => attachment.path)
    : [];
  if (!bridgeUrl && bridgeMode(resolvedConfig, env) === "local") {
    return sendLocalWhatsAppMessage({ chatId, text, accountId, attachments: normalizedAttachments, env, crossAccountEchoSuppression, routeSentMessage });
  }
  if (!bridgeUrl) throw badRequest("whatsapp_bridge_not_configured");
  const externalBridgeCanReadPaths = externalBridgeCanReadLocalAttachmentPaths(resolvedConfig, env);
  const inlineAttachments = externalBridgeCanReadPaths
    ? { attachments: [], skipped: [] }
    : await prepareExternalBridgeInlineAttachments(normalizedAttachments, env);
  const sendablePathAttachments = externalBridgeCanReadPaths ? normalizedAttachments : [];
  const sendableInlineAttachments = inlineAttachments.attachments;
  const outboundText = appendLocalAttachmentFailureNotes(text, inlineAttachments.skipped);
  const headers = bridgeRequestHeaders(resolvedConfig, env, { "content-type": "application/json" });
  const runtimeAccountId = await resolveBridgeRuntimeAccountId(accountId, { config: resolvedConfig, env, fetchImpl });
  const hasMedia = sendablePathAttachments.length || sendableInlineAttachments.length;
  const response = await fetchImpl(whatsappBridgeEndpointUrl(bridgeUrl, hasMedia ? "/send-media" : "/send-text"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: chatId,
      text: outboundText,
      ...(runtimeAccountId ? { accountId: runtimeAccountId } : {}),
      ...(sendablePathAttachments.length ? { paths: sendablePathAttachments.map((attachment) => attachment.path) } : {}),
      ...(sendableInlineAttachments.length ? { attachments: sendableInlineAttachments } : {}),
      ...(crossAccountEchoSuppression === false ? { crossAccountEchoSuppression: false } : {}),
      ...(routeSentMessage === true ? { routeSentMessage: true } : {}),
    }),
    signal: AbortSignal.timeout(Number(env.WHATSAPP_SEND_TIMEOUT_MS || 10_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(whatsappSendFailureMessage(payload, response.status));
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

function whatsappDeliveryIdleThrottleMs(env = process.env, fetchImpl = fetch) {
  const configured = pickString(env.ORKESTR_WHATSAPP_DELIVERY_IDLE_THROTTLE_MS);
  if (configured) return positiveInteger(configured, 0, 0);
  if (fetchImpl !== fetch) return 0;
  return 30000;
}

function whatsappDeliveryMinIntervalMs(env = process.env, fetchImpl = fetch) {
  if (fetchImpl !== fetch) return 0;
  return positiveInteger(env.ORKESTR_WHATSAPP_DELIVERY_MIN_INTERVAL_MS, 0, 0);
}

function cacheableWhatsAppDeliveryResult(result = {}) {
  return !(
    (result.delivered || []).length ||
    (result.failed || []).length ||
    (result.skipped || []).length ||
    Number(result?.skippedSummary?.count || 0) > 0
  );
}

async function fileSignature(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return `${filePath}:missing`;
  return `${filePath}:${stat.mtimeMs}:${stat.size}`;
}

async function jsonDirSignature(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const parts = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const filePath = path.join(dirPath, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      return stat ? `${entry.name}:${stat.mtimeMs}:${stat.size}` : `${entry.name}:missing`;
    }));
  return `${dirPath}:${parts.sort().join(";")}`;
}

async function whatsappDeliveryIdleSignature(env = process.env) {
  const paths = dataPaths(env);
  const parts = await Promise.all([
    fileSignature(paths.config),
    fileSignature(paths.threads),
    fileSignature(paths.whatsapp),
    fileSignature(paths.connectorOutbox),
    jsonDirSignature(paths.messages),
    jsonDirSignature(paths.threadMessages),
  ]);
  return `${paths.home}|${parts.join("|")}`;
}

function whatsappOutboundMirrorCursorPassed(state = null, messageSetKey = "", messageCursor = 0) {
  const cursor = Math.max(0, Number(messageCursor || 0) || 0);
  const existingCursor = outboundMirrorCursorMap(state?.outboundMirrorCursors || []).get(messageSetKey);
  return Boolean(existingCursor && cursor > 0 && cursor <= Number(existingCursor.cursor || 0));
}

function outOfBandNotificationBypassesMirrorCursor(message = {}) {
  const phase = pickString(message.phase).toLowerCase();
  return ["notification", "signal"].includes(phase) &&
    Boolean(pickString(message.chatId)) &&
    shouldMirrorWhatsAppReply(message);
}

function recoveredCodexHistoryFinalBypassesMirrorCursor(message = {}, parent = null) {
  return pickString(message.source).toLowerCase() === "codex-app-server-import" &&
    pickString(message.observedVia).toLowerCase() === "codex_app_server_history_sync" &&
    pickString(message.phase || "final_answer").toLowerCase() === "final_answer" &&
    Boolean(pickString(message.chatId, parent?.chatId));
}

function whatsappTerminalIntentVisibilityWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TERMINAL_INTENT_VISIBILITY_WINDOW_MS || 15 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 15 * 60 * 1000;
}

function whatsappIntentTerminalMs(intent = {}) {
  const ms = Date.parse(String(intent?.lastChangedAt || intent?.skippedAt || intent?.cancelledAt || intent?.updatedAt || intent?.createdAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function staleTerminalWhatsAppOutboundIntentPassedCursor({
  state = null,
  messageSetKey = "",
  messageCursor = 0,
  intent = null,
  env = process.env,
} = {}) {
  const status = String(intent?.status || "").trim().toLowerCase();
  if (status !== "skipped" && status !== "cancelled") return false;
  if (!whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) return false;
  const terminalMs = whatsappIntentTerminalMs(intent);
  if (!terminalMs) return false;
  return Date.now() - terminalMs > whatsappTerminalIntentVisibilityWindowMs(env);
}

export async function syncWhatsAppTypingIndicators(env = process.env, options = {}) {
  const config = await readConnectorConfig("whatsapp", env);
  if (bridgeMode(config, env) !== "local") return { ok: true, active: 0, skipped: "external_bridge" };
  const state = await readWhatsAppState(env);
  const statusImpl = options.statusImpl || runtimeStatus;
  const syncImpl = options.syncImpl || syncLocalWhatsAppTypingTargets;
  const targets = [];
  for (const { threadId, thread, messages } of await listThreadMessageSets(env, state, config)) {
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
  await reconcileWhatsAppConnectorOutboxFromLedger(state, env).catch((error) =>
    appendEvent({ type: "connector_outbox_reconcile_from_whatsapp_delivery_failed", error: error.message || String(error) }, env).catch(() => null)
  );
  const connectorOutboxJobs = (await listConnectorOutboxJobs({
    connector: "whatsapp",
    limit: 1000,
  }, env).catch(() => ({ jobs: [] }))).jobs || [];
  const deliveredIds = new Set((state.outboundDeliveries || []).map((delivery) => delivery.messageId));
  const deliveredTextKeys = new Set((state.outboundDeliveries || []).map((delivery) => delivery.textKey).filter(Boolean));
  const batchTextKeys = new Set();
  const outboundDeliveries = [...(state.outboundDeliveries || [])];
  const outboundIntents = [...(state.outboundIntents || [])];
  const delivered = [];
  const skipped = createWhatsAppDeliverySkippedCollector(env);
  const failed = [];

  const messageSets = [
    ...(await listMessageSets(env, state)).map((set) => ({ ...set, kind: "agent" })),
    ...(await listThreadMessageSets(env, state, config)).map((set) => ({ ...set, kind: "thread" })),
  ];
  await recoverParentsForAlreadyMirroredReplies(messageSets, deliveredIds, outboundDeliveries, state, env);
  for (const { agentId, threadId, thread, messages, kind } of messageSets) {
    const debugThread = kind === "thread" ? await threadWithLiveCodexDebugMetadata(thread, env) : thread;
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
        const accountId = kind === "thread" ? routerUpdateTarget.accountId : pickString(message.accountId, routerUpdateTarget.accountId);
        const existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
          kind,
          deliveryType: "router_update",
          routerUpdateType: routerUpdateTarget.routerUpdateType,
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          chatId,
          accountId,
        });
        if (staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
        if (!existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
        if (
          routerUpdateTarget.skipIfAssistantOutput &&
          (completedAssistantReplyForParent(messages, message, chatId, state) || latestProgressReplyForParent(messages, message.id, env))
        ) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "assistant_output_available" });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "router_update", thread, chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: "router_update",
            routerUpdateType: routerUpdateTarget.routerUpdateType,
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message,
            env,
          });
          continue;
        }
        const text = appendWhatsAppDebugFooter(routerUpdateTarget.text, {
          message,
          thread: debugThread,
          messages,
          deliveryType: "router_update",
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
        const chatId = queuedModeTarget.chatId;
        const text = appendWhatsAppDebugFooter(formatWhatsAppModeQueued(queuedModeTarget.mode), {
          message,
          thread: debugThread,
          messages,
          deliveryType: "mode_queued",
          env,
        });
        const accountId = kind === "thread" ? queuedModeTarget.accountId : pickString(message.accountId, queuedModeTarget.accountId);
        const existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
          kind,
          deliveryType: "mode_queued",
          agentId,
          threadId,
          messageId: deliveryId,
          chatId,
          accountId,
        });
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          await skipWhatsAppMirroringDisabledCandidate({
            state,
            outboundIntents,
            skipped,
            existingIntent,
            kind,
            deliveryType: "mode_queued",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message,
            env,
          });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "mode_queued", thread, chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: "mode_queued",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message,
            env,
          });
          continue;
        }
        if (staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
        if (!existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
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
        let queueMessage = message;
        let queueMessages = messages;
        let queueTarget = queuedInputTarget;
        let chatId = queueTarget.chatId;
        let accountId = kind === "thread" ? queueTarget.accountId : pickString(queueMessage.accountId, queueTarget.accountId);
        let existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
          kind,
          deliveryType: "queue_notice",
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          chatId,
          accountId,
        });
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          await skipWhatsAppMirroringDisabledCandidate({
            state,
            outboundIntents,
            skipped,
            existingIntent,
            kind,
            deliveryType: "queue_notice",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message: queueMessage,
            env,
          });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "queue_notice", thread, chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: "queue_notice",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
            message: queueMessage,
            env,
          });
          continue;
        }
        if (staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
        if (!existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
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
          existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
            kind,
            deliveryType: "queue_notice",
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId,
            accountId,
          });
          if (staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
          if (!existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
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
          thread: debugThread,
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
        const chatId = failedDeliveryTarget.chatId;
        const accountId = kind === "thread" ? failedDeliveryTarget.accountId : pickString(message.accountId, failedDeliveryTarget.accountId);
        const existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
          kind,
          deliveryType: "delivery_error",
          agentId,
          threadId,
          messageId: message.id,
          chatId,
          accountId,
        });
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          await skipWhatsAppMirroringDisabledCandidate({
            state,
            outboundIntents,
            skipped,
            existingIntent,
            kind,
            deliveryType: "delivery_error",
            agentId,
            threadId,
            messageId: message.id,
            chatId,
            accountId,
            message,
            env,
          });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "delivery_error", thread, chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: "delivery_error",
            agentId,
            threadId,
            messageId: message.id,
            chatId,
            accountId,
            message,
            env,
          });
          continue;
        }
        if (staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
        if (!existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
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
          thread: debugThread,
          messages,
          deliveryType: "delivery_error",
          env,
        });
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
      const mutationParent = messages.find((entry) => entry.id === message.parentMessageId);
      const mutationTarget = whatsappMutationNoticeTarget({
        message,
        parent: mutationParent,
        thread,
        kind,
        outboundDeliveries,
        connectorOutboxJobs,
      });
      if (mutationTarget) {
        const deliveryId = `${message.id}:${mutationTarget.deliveryType}:${mutationTarget.sourceRevision}`;
        if (deliveredIds.has(deliveryId)) continue;
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          await skipWhatsAppMirroringDisabledCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: mutationTarget.deliveryType,
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId: mutationTarget.chatId,
            accountId: mutationTarget.accountId,
            message,
            parent: mutationParent,
            env,
          });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "mutation_notice", thread, chatId: mutationTarget.chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: mutationTarget.deliveryType,
            agentId,
            threadId,
            messageId: deliveryId,
            sourceMessageId: message.id,
            chatId: mutationTarget.chatId,
            accountId: mutationTarget.accountId,
            message,
            parent: mutationParent,
            env,
          });
          continue;
        }
        if (!mutationTarget.priorDelivery) {
          await markUnsupportedWhatsAppMutation({
            thread,
            kind,
            agentId,
            threadId,
            message,
            target: mutationTarget,
            env,
          });
          skipped.push({
            agentId,
            threadId,
            messageId: message.id,
            reason: "unsupported_connector_action_original_not_delivered",
          });
          continue;
        }
        const noticeText = formatWhatsAppMutationNotice(message, mutationTarget);
        const text = appendWhatsAppDebugFooter(noticeText, {
          message,
          thread: debugThread,
          messages,
          deliveryType: mutationTarget.deliveryType,
          env,
        });
        if (!text) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "missing_text" });
          continue;
        }
        const textKey = deliveryTextKey(mutationTarget.chatId, `${deliveryId}\n${text}`);
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
          parent: mutationParent,
          thread,
          kind,
          deliveryType: mutationTarget.deliveryType,
          agentId,
          threadId,
          messageId: deliveryId,
          sourceMessageId: message.id,
          parentMessageId: message.parentMessageId,
          chatId: mutationTarget.chatId,
          accountId: mutationTarget.accountId,
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
            type: "whatsapp_outbound_mutation_notice_delivered",
            action: mutationTarget.action,
            agentId: agentId || null,
            threadId: threadId || null,
            messageId: message.id,
            chatId: mutationTarget.chatId,
            deliveryType: mutationTarget.deliveryType,
            sourceRevision: mutationTarget.sourceRevision,
          }, env);
        } else if (result.failure) {
          const error = result.failure.error;
          const failure = { kind, agentId: agentId || null, threadId: threadId || null, messageId: message.id, chatId: mutationTarget.chatId, error: error.message || String(error) };
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
        const chatId = pickString(message.chatId, parent?.chatId, thread?.binding?.chatId);
        const accountId = kind === "thread"
          ? pickString(thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
          : pickString(message.accountId, parent?.accountId);
        const existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
          kind,
          deliveryType: "progress",
          agentId,
          threadId,
          messageId: message.id,
          chatId,
          accountId,
        });
        if (!liveRecovery && staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
        if (!liveRecovery && !existingIntent && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
        if (!liveRecovery && !existingIntent && staleUntrackedWhatsAppProgress(message, outboundDeliveries, env)) {
          skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
          continue;
        }
        if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
          await skipWhatsAppMirroringDisabledCandidate({
            state,
            outboundIntents,
            skipped,
            existingIntent,
            kind,
            deliveryType: "progress",
            agentId,
            threadId,
            messageId: message.id,
            chatId,
            accountId,
            message,
            parent,
            env,
          });
          continue;
        }
        if (whatsappUpdateDeliverySuppressed({ kind, deliveryType: "progress", thread, chatId, env })) {
          await skipSuppressedWhatsAppUpdateCandidate({
            state,
            outboundIntents,
            skipped,
            kind,
            deliveryType: "progress",
            agentId,
            threadId,
            messageId: message.id,
            chatId,
            accountId,
            message,
            parent,
            env,
          });
          continue;
        }
        if (progressOvertakenByFinal(messages, message, chatId, env)) {
          await skipWhatsAppOutboundCandidate({
            state,
            outboundIntents,
            kind,
            deliveryType: "progress",
            agentId,
            threadId,
            messageId: message.id,
            chatId,
            accountId,
            message,
            parent,
            reason: "overtaken_by_final",
            env,
          });
          skipped.push({ agentId, threadId, messageId: message.id, reason: "overtaken_by_final" });
          continue;
        }
        const text = appendWhatsAppDebugFooter(formatWhatsAppOutboundText(pickString(message.text)), {
          message,
          thread: debugThread,
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
      const chatId = pickString(message.chatId, parent?.chatId, thread?.binding?.chatId);
      const accountId = kind === "thread"
        ? pickString(thread?.binding?.replyAccountId, thread?.binding?.bridgeAccountId, thread?.binding?.responderConnectorAccountId, thread?.binding?.responderAccountId, thread?.binding?.outboundAccountId, message.accountId, parent?.accountId)
        : pickString(message.accountId, parent?.accountId);
      const messagePhase = pickString(message.phase || "final_answer").toLowerCase();
      const deliveryType = messagePhase === "signal" ? "signal" : message.source === "orkestr_runtime" ? "router_update" : "final";
      const existingIntent = findWhatsAppOutboundIntent(outboundIntents, {
        kind,
        deliveryType,
        agentId,
        threadId,
        messageId: message.id,
        chatId,
        accountId,
      });
      if (!liveRecovery && staleTerminalWhatsAppOutboundIntentPassedCursor({ state, messageSetKey, messageCursor, intent: existingIntent, env })) continue;
      const notificationBypass = outOfBandNotificationBypassesMirrorCursor(message);
      const historyRecoveryBypass = recoveredCodexHistoryFinalBypassesMirrorCursor(message, parent);
      if (!liveRecovery && !existingIntent && !notificationBypass && !historyRecoveryBypass && whatsappOutboundMirrorCursorPassed(state, messageSetKey, messageCursor)) continue;
      if (!liveRecovery && !existingIntent && !historyRecoveryBypass && staleUntrackedWhatsAppReply(message, outboundDeliveries, env)) {
        skipped.push({ agentId, threadId, messageId: message.id, reason: "stale_untracked_reply" });
        continue;
      }
      if (kind === "thread" && !threadAllowsWhatsAppMirroring(thread)) {
        await skipWhatsAppMirroringDisabledCandidate({
          state,
          outboundIntents,
          skipped,
          existingIntent,
          kind,
          deliveryType,
          agentId,
          threadId,
          messageId: message.id,
          chatId,
          accountId,
          message,
          parent,
          env,
        });
        continue;
      }
      if (whatsappUpdateDeliverySuppressed({ kind, deliveryType, thread, chatId, env })) {
        await skipSuppressedWhatsAppUpdateCandidate({
          state,
          outboundIntents,
          skipped,
          kind,
          deliveryType,
          agentId,
          threadId,
          messageId: message.id,
          chatId,
          accountId,
          message,
          parent,
          env,
        });
        continue;
      }

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
      const outboundText = appendLocalAttachmentFailureNotes(preparedOutbound.text, resolvedOutboundAttachments.skipped);
      const formattedText = formatWhatsAppOutboundText(redactDeniedThreadAttachmentPaths(outboundText, {
        thread,
        principal: await principalForThread(thread || {}, env),
        env,
      }));
      const text = appendWhatsAppDebugFooter(appendRemoteAttachmentFailureNotes(formattedText, remoteMaterialized.skipped), {
        message,
        thread: debugThread,
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
        if (deliveryType === "final" || deliveryType === "router_update") {
          await suppressProgressRetriesAfterFinal({
            state,
            outboundIntents,
            threadId,
            chatId,
            accountId,
            parentMessageId: message.parentMessageId,
            finalMessageId: message.id,
            env,
          }).catch(() => null);
        }
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
  const minIntervalMs = whatsappDeliveryMinIntervalMs(env, fetchImpl);
  if (minIntervalMs > 0 && whatsappDeliveryRunCache && Date.now() - whatsappDeliveryRunCache.updatedAt <= minIntervalMs) {
    return whatsappDeliveryRunCache.result;
  }
  const throttleMs = whatsappDeliveryIdleThrottleMs(env, fetchImpl);
  if (throttleMs > 0 && whatsappDeliveryIdleCache) {
    const now = Date.now();
    if (now - whatsappDeliveryIdleCache.updatedAt <= throttleMs) {
      const signature = await whatsappDeliveryIdleSignature(env).catch(() => "");
      if (signature && signature === whatsappDeliveryIdleCache.signature) return whatsappDeliveryIdleCache.result;
    }
  }
  const result = await whatsappOutboundMirrorWorker.run(() => deliverWhatsAppRepliesOnce(env, fetchImpl));
  if (throttleMs > 0 && cacheableWhatsAppDeliveryResult(result)) {
    const signature = await whatsappDeliveryIdleSignature(env).catch(() => "");
    whatsappDeliveryIdleCache = signature ? { signature, result, updatedAt: Date.now() } : null;
  } else {
    clearWhatsAppDeliveryIdleCache();
  }
  if (minIntervalMs > 0) {
    whatsappDeliveryRunCache = { result, updatedAt: Date.now() };
  }
  return result;
}
