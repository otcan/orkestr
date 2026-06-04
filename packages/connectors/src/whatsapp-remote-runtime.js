import path from "node:path";
import { appendEvent } from "../../storage/src/store.js";
import { recordRouterTraceEvent } from "../../core/src/router-traces.js";
import { appendThreadMessage, listThreadMessages, listThreads, updateThreadMessage } from "../../core/src/threads.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBackendConfig(backendId, config = {}) {
  const input = typeof config === "string" ? { baseUrl: config } : config && typeof config === "object" ? config : {};
  const baseUrl = pickString(input.baseUrl, input.url, input.endpoint);
  if (!baseUrl) return null;
  return {
    id: backendId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token: pickString(input.token, input.apiToken, input.bearerToken),
    timeoutMs: Math.max(1000, Number(input.timeoutMs || input.timeout || 10_000) || 10_000),
    fetchLimit: Math.max(1, Math.min(500, Number(input.fetchLimit || input.messageLimit || 100) || 100)),
  };
}

export function configuredRemoteThreadBackends(env = process.env) {
  const backends = {};
  for (const [id, config] of Object.entries(parseJsonObject(
    env.ORKESTR_REMOTE_THREAD_BACKENDS_JSON ||
      env.ORKESTR_REMOTE_RUNTIME_BACKENDS_JSON ||
      env.ORKESTR_REMOTE_BACKENDS_JSON ||
      "{}",
  ))) {
    const normalized = normalizeBackendConfig(String(id || "").trim(), config);
    if (normalized) backends[normalized.id] = normalized;
  }
  const defaultId = pickString(
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    env.ORKESTR_REMOTE_BACKEND_ID,
    "default",
  );
  const defaultUrl = pickString(
    env.ORKESTR_REMOTE_THREAD_BACKEND_URL,
    env.ORKESTR_REMOTE_THREAD_BACKEND_BASE_URL,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_URL,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_BASE_URL,
  );
  if (defaultUrl) {
    const normalized = normalizeBackendConfig(defaultId, {
      baseUrl: defaultUrl,
      token: pickString(
        env.ORKESTR_REMOTE_THREAD_BACKEND_TOKEN,
        env.ORKESTR_REMOTE_RUNTIME_BACKEND_TOKEN,
        env.ORKESTR_REMOTE_BACKEND_TOKEN,
      ),
      timeoutMs: env.ORKESTR_REMOTE_THREAD_BACKEND_TIMEOUT_MS || env.ORKESTR_REMOTE_RUNTIME_BACKEND_TIMEOUT_MS,
      fetchLimit: env.ORKESTR_REMOTE_THREAD_BACKEND_FETCH_LIMIT || env.ORKESTR_REMOTE_RUNTIME_BACKEND_FETCH_LIMIT,
    });
    if (normalized) backends[normalized.id] = normalized;
  }
  return backends;
}

export function backendForBinding(binding = {}, env = process.env) {
  const backendId = pickString(
    binding.remoteBackend,
    binding.remoteRuntimeBackend,
    binding.runtimeBackend,
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    "default",
  );
  const backend = configuredRemoteThreadBackends(env)[backendId];
  if (!backend) {
    const error = new Error(`whatsapp_remote_backend_not_configured:${backendId}`);
    error.statusCode = 502;
    throw error;
  }
  return backend;
}

export function remoteWhatsAppRuntimeBinding(thread = null, env = process.env) {
  const binding = thread?.binding || {};
  if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") return null;
  if (binding.remoteRuntimeEnabled === false || binding.remoteRouterEnabled === false) return null;
  const remoteThreadId = pickString(binding.remoteThreadId, binding.remoteRuntimeThreadId, binding.delegatedThreadId);
  if (!remoteThreadId) return null;
  const backendId = pickString(
    binding.remoteBackend,
    binding.remoteRuntimeBackend,
    binding.runtimeBackend,
    env.ORKESTR_REMOTE_THREAD_BACKEND_ID,
    env.ORKESTR_REMOTE_RUNTIME_BACKEND_ID,
    "default",
  );
  return {
    backendId,
    remoteThreadId,
    binding,
  };
}

export function remoteEndpointUrl(backend, endpointPath) {
  const endpoint = String(endpointPath || "").trim().replace(/^\/+/, "");
  return new URL(`${backend.baseUrl}/${endpoint}`);
}

export function remoteHeaders(backend, extra = {}) {
  return {
    "content-type": "application/json",
    ...(backend.token ? { authorization: `Bearer ${backend.token}` } : {}),
    ...extra,
  };
}

async function remoteJson(backend, endpointPath, fetchImpl, options = {}) {
  const response = await fetchImpl(remoteEndpointUrl(backend, endpointPath), {
    ...options,
    headers: remoteHeaders(backend, options.headers || {}),
    signal: AbortSignal.timeout(backend.timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `remote_runtime_request_failed:${response.status}`);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function safeFilePart(value = "", fallback = "attachment") {
  return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || fallback;
}

function remoteMessageAttachmentId(attachment = {}) {
  return pickString(attachment.id, attachment.attachmentId, attachment.remoteAttachmentId, attachment.remoteArtifactId, attachment.artifactId);
}

function normalizeRemoteRuntimeAttachment(remote, remoteMessage = {}, attachment = {}, index = 0) {
  const id = remoteMessageAttachmentId(attachment);
  if (!id) return null;
  const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
  const filename = safeFilePart(pickString(attachment.filename, attachment.name, `attachment-${index + 1}`));
  return {
    kind: pickString(attachment.kind, "file"),
    filename,
    name: pickString(attachment.name, filename),
    mimetype: pickString(attachment.mimetype, attachment.type, "application/octet-stream"),
    size: Number(attachment.size || 0) || 0,
    source: "remote_runtime_attachment",
    downloadable: false,
    remote: true,
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId,
    remoteAttachmentId: id,
    ...(pickString(attachment.remoteArtifactId, attachment.artifactId) ? { remoteArtifactId: pickString(attachment.remoteArtifactId, attachment.artifactId) } : {}),
    ...(pickString(attachment.downloadUrl, attachment.remoteDownloadUrl) ? { remoteDownloadUrl: pickString(attachment.downloadUrl, attachment.remoteDownloadUrl) } : {}),
    ...(pickString(attachment.sha256) ? { sha256: pickString(attachment.sha256) } : {}),
  };
}

function remoteRuntimeAttachmentsForMessage(remote, remoteMessage = {}) {
  return (Array.isArray(remoteMessage.attachments) ? remoteMessage.attachments : [])
    .map((attachment, index) => normalizeRemoteRuntimeAttachment(remote, remoteMessage, attachment, index))
    .filter(Boolean);
}

export async function enqueueRemoteWhatsAppThreadInput({ thread, message, input = {} } = {}, env = process.env, fetchImpl = fetch) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  const backend = backendForBinding(remote.binding, env);
  const payload = await remoteJson(backend, `threads/${encodeURIComponent(remote.remoteThreadId)}/input`, fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      ...input,
      role: "user",
      source: input.source || "whatsapp_inbound",
      connector: "whatsapp",
      parseCommands: true,
      controlAllowed: true,
      originOwner: true,
      forwardedBy: "orkestr-public-whatsapp-router",
      publicThreadId: thread?.id || "",
      publicMessageId: message?.id || "",
    }),
  });
  return {
    ...remote,
    backend,
    payload,
    message: payload?.message || payload?.commandMessage || payload?.input || null,
    thread: payload?.thread || null,
  };
}

async function fetchRemoteThreadMessages(remote, env = process.env, fetchImpl = fetch) {
  const backend = backendForBinding(remote.binding, env);
  const payload = await remoteJson(
    backend,
    `threads/${encodeURIComponent(remote.remoteThreadId)}/messages?limit=${backend.fetchLimit}`,
    fetchImpl,
    { method: "GET" },
  );
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.history?.messages)
      ? payload.history.messages
      : [];
  return { backend, payload, messages };
}

function messageRole(message = {}) {
  return String(message.role || message.kind || "").trim().toLowerCase();
}

function completedAssistantMessage(message = {}) {
  return messageRole(message) === "assistant" &&
    String(message.state || "completed").trim().toLowerCase() === "completed" &&
    pickString(message.text);
}

function messageTimestamp(message = {}) {
  return pickString(message.createdAt, message.timestamp) || new Date().toISOString();
}

function publicParentIdForRemoteMessage(remoteMessage = {}, localByRemoteId = new Map()) {
  const remoteParentId = pickString(remoteMessage.parentMessageId, remoteMessage.parentId);
  const parent = remoteParentId ? localByRemoteId.get(remoteParentId) : null;
  return pickString(parent?.id);
}

async function updatePublicRemoteParent(thread, localMessage, remoteMessage, remote, env) {
  if (!localMessage || !remoteMessage) return null;
  const patch = {
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: pickString(remoteMessage.id, remoteMessage.messageId, localMessage.remoteMessageId),
    remoteSyncedAt: new Date().toISOString(),
  };
  const state = pickString(remoteMessage.state);
  const deliveryState = pickString(remoteMessage.deliveryState);
  const observedVia = pickString(remoteMessage.observedVia);
  const deliveredAt = pickString(remoteMessage.deliveredAt);
  if (state) patch.state = state;
  if (deliveryState) patch.deliveryState = deliveryState;
  if (observedVia) patch.observedVia = observedVia;
  if (deliveredAt) patch.deliveredAt = deliveredAt;
  return updateThreadMessage(thread.id, localMessage.id, patch, env).catch(() => null);
}

async function appendRemoteAssistantMessage({ thread, remote, remoteMessage, parentMessageId, parent, env }) {
  const binding = thread?.binding || {};
  const attachments = remoteRuntimeAttachmentsForMessage(remote, remoteMessage);
  const appended = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: pickString(remoteMessage.source, "remote-runtime"),
    phase: pickString(remoteMessage.phase, messageRole(remoteMessage) === "assistant" ? "final_answer" : ""),
    state: "completed",
    text: pickString(remoteMessage.text),
    parentMessageId,
    connector: "whatsapp",
    routerTraceId: pickString(remoteMessage.routerTraceId, parent?.routerTraceId),
    turnId: pickString(remoteMessage.turnId, parent?.turnId),
    chatId: pickString(remoteMessage.chatId, binding.chatId),
    accountId: pickString(binding.responderAccountId, binding.outboundAccountId, remoteMessage.accountId),
    createdAt: messageTimestamp(remoteMessage),
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: pickString(remoteMessage.id, remoteMessage.messageId),
    remoteParentMessageId: pickString(remoteMessage.parentMessageId, remoteMessage.parentId),
    remoteSyncedAt: new Date().toISOString(),
    ...(attachments.length ? { attachments } : {}),
  }, env);
  await recordRouterTraceEvent({
    routerTraceId: appended.routerTraceId,
    turnId: appended.turnId,
    connector: "whatsapp",
    accountId: appended.accountId,
    chatId: appended.chatId,
    threadId: thread.id,
    messageId: appended.id,
    phase: "assistant_seen",
    ownerProcess: remote.backendId,
  }, env).catch(() => {});
  return appended;
}

export async function syncRemoteWhatsAppThreadMessages(env = process.env, fetchImpl = fetch) {
  const results = [];
  for (const thread of await listThreads(env)) {
    const remote = remoteWhatsAppRuntimeBinding(thread, env);
    if (!remote || remote.binding.remoteMirrorEnabled === false) continue;
    try {
      const { messages: remoteMessages } = await fetchRemoteThreadMessages(remote, env, fetchImpl);
      const localMessages = await listThreadMessages(thread.id, env);
      const localByRemoteId = new Map(
        localMessages
          .map((message) => [pickString(message.remoteMessageId), message])
          .filter(([id]) => id),
      );
      let imported = 0;
      let updated = 0;
      for (const remoteMessage of remoteMessages) {
        const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
        if (!remoteMessageId) continue;
        const local = localByRemoteId.get(remoteMessageId);
        if (local && messageRole(remoteMessage) === "user") {
          if (await updatePublicRemoteParent(thread, local, remoteMessage, remote, env)) updated += 1;
          continue;
        }
        if (local || !completedAssistantMessage(remoteMessage)) continue;
        const parentMessageId = publicParentIdForRemoteMessage(remoteMessage, localByRemoteId);
        if (!parentMessageId && remote.binding.remoteMirrorOrphanReplies !== true) continue;
        const parent = parentMessageId ? localMessages.find((message) => message.id === parentMessageId) || null : null;
        const appended = await appendRemoteAssistantMessage({ thread, remote, remoteMessage, parentMessageId, parent, env });
        localByRemoteId.set(remoteMessageId, appended);
        imported += 1;
      }
      if (imported || updated) {
        await appendEvent({
          type: "whatsapp_remote_runtime_messages_synced",
          threadId: thread.id,
          remoteBackend: remote.backendId,
          remoteThreadId: remote.remoteThreadId,
          imported,
          updated,
        }, env);
      }
      results.push({ threadId: thread.id, remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, imported, updated });
    } catch (error) {
      await appendEvent({
        type: "whatsapp_remote_runtime_sync_failed",
        threadId: thread.id,
        remoteBackend: remote.backendId,
        remoteThreadId: remote.remoteThreadId,
        error: error.message || String(error),
      }, env).catch(() => {});
      results.push({ threadId: thread.id, remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, error: error.message || String(error) });
    }
  }
  return { ok: true, results };
}

export function remoteWhatsAppRuntimeAvailable(thread = null, env = process.env) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return false;
  try {
    backendForBinding(remote.binding, env);
    return true;
  } catch {
    return false;
  }
}
