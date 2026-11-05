import path from "node:path";
import { remoteBackendHasPushWatch } from "./whatsapp-remote-push-state.js";
import { withRemoteThreadSync } from "./whatsapp-remote-sync-lock.js";
import { appendEvent } from "../../storage/src/store.js";
import { threadMessageStoreFingerprint } from "../../storage/src/thread-message-registry.js";
import { recordRouterTraceEvent } from "../../core/src/router-traces.js";
import { appendThreadMessage, getThread, listThreadMessages, listThreads, updateThreadMessage } from "../../core/src/threads.js";
import { remoteWhatsAppRuntimeBinding } from "../../core/src/thread-remote-runtime-binding.js";
import { routeHeldLocalInputs } from "../../core/src/remote-runtime-held-inputs.js";
import { forwardLocalInputToRemote } from "./whatsapp-remote-local-input.js";
import { remoteParentExpectedFields, remoteParentRecoveryCandidate } from "./whatsapp-remote-parent.js";
import { acknowledgeRemoteMirrorDeliveries, remoteMirrorAckSupported } from "./whatsapp-remote-mirror-ack.js";
import { uploadRemoteInputAttachments } from "./whatsapp-remote-attachment-upload.js";
import { materializeRemoteTimerParent, remoteTimerParentSource } from "./whatsapp-remote-timer-parent.js";
import { remoteLayerMetadata } from "./whatsapp-remote-footer.js";
import { createTimerAccountLookup } from "./whatsapp-remote-timer-accounts.js";

export { remoteWhatsAppRuntimeBinding };

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
    // Opt-in: upload accepted inbound files and reference them by upload ID.
    attachmentUpload: input.attachmentUpload === true,
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

export async function remoteJson(backend, endpointPath, fetchImpl, options = {}) {
  const response = await fetchImpl(remoteEndpointUrl(backend, endpointPath), {
    ...options,
    headers: remoteHeaders(backend, options.headers || {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(backend.timeoutMs)]) : AbortSignal.timeout(backend.timeoutMs),
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
  const threadPath = `threads/${encodeURIComponent(remote.remoteThreadId)}`;
  const uploaded = backend.attachmentUpload
    ? await uploadRemoteInputAttachments({
        thread,
        message,
        env,
        post: (body) => remoteJson(backend, `${threadPath}/attachments`, fetchImpl, { method: "POST", body: JSON.stringify(body) }),
      })
    : null;
  const payload = await remoteJson(backend, `${threadPath}/input`, fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      ...input,
      ...(uploaded ? { attachments: uploaded } : {}),
      role: "user",
      source: input.source || "whatsapp_inbound",
      connector: "whatsapp",
      // Only owner input carries owner authority; a participant's never does.
      parseCommands: input.originOwner !== false,
      controlAllowed: input.originOwner !== false,
      originOwner: input.originOwner !== false,
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

export async function updateRemoteWhatsAppThreadInput({ thread, message, revisionId = "" } = {}, env = process.env, fetchImpl = fetch) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  const remoteMessageId = pickString(message?.remoteMessageId);
  if (!remoteMessageId) {
    const error = new Error("whatsapp_remote_input_edit_unsupported");
    error.statusCode = 409;
    throw error;
  }
  const backend = backendForBinding(remote.binding, env);
  const payload = await remoteJson(
    backend,
    `threads/${encodeURIComponent(remote.remoteThreadId)}/messages/${encodeURIComponent(remoteMessageId)}/whatsapp-inbound-revision`,
    fetchImpl,
    {
      method: "PATCH",
      body: JSON.stringify({
        publicMessageId: message?.id || "",
        revisionId: pickString(revisionId),
        text: pickString(message?.text),
        attachments: Array.isArray(message?.attachments) ? message.attachments : [],
      }),
    },
  );
  return {
    ...remote,
    backend,
    payload,
    message: payload?.message || null,
    duplicate: payload?.duplicate === true,
  };
}

async function fetchRemoteThreadMessages(remote, env = process.env, fetchImpl = fetch, signal = null) {
  const backend = backendForBinding(remote.binding, env);
  const payload = await remoteJson(
    backend,
    `threads/${encodeURIComponent(remote.remoteThreadId)}/messages?limit=${backend.fetchLimit}`,
    fetchImpl,
    { method: "GET", signal },
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

async function updatePublicRemoteParent(thread, localMessage, remoteMessage, remote, env, recovered = false) {
  if (!localMessage || !remoteMessage) return null;
  const patch = {
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: pickString(remoteMessage.id, remoteMessage.messageId, localMessage.remoteMessageId),
    remoteSyncedAt: new Date().toISOString(),
    ...(remoteMessage.origin === "v1_local" ? { remoteInputKind: "v1_local" } : {}),
  };
  const state = pickString(remoteMessage.state);
  const deliveryState = pickString(remoteMessage.deliveryState);
  const observedVia = pickString(remoteMessage.observedVia);
  const deliveredAt = pickString(remoteMessage.deliveredAt);
  if (state) patch.state = state;
  if (deliveryState) patch.deliveryState = deliveryState;
  if (observedVia) patch.observedVia = observedVia;
  if (deliveredAt) patch.deliveredAt = deliveredAt;
  if (recovered && ["completed", "delivered"].includes(state) && deliveryState === "delivered") patch.error = null;
  return updateThreadMessage(thread.id, localMessage.id, patch, env, {
    expectedFields: remoteParentExpectedFields(localMessage),
  }).catch(() => null);
}

// On a relay-bound thread (legacy mirror off) a reply to V1-local input
// (thread, agent, mailbox, CLI, UI) stays in this thread, where its requester
// reads it, exactly as a V1 reply to such input; it is never sent to the group.
export function remoteLocalInputParent(thread = null, parent = null) {
  return thread?.binding?.mirrorToWhatsApp === false &&
    parent?.role === "user" && pickString(parent.remoteInputKind) === "v1_local";
}

async function appendRemoteAssistantMessage({ thread, remote, remoteMessage, parentMessageId, parent, env }) {
  const binding = thread?.binding || {};
  const attachments = remoteRuntimeAttachmentsForMessage(remote, remoteMessage);
  const local = remoteLocalInputParent(thread, parent);
  const appended = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: pickString(remoteMessage.source, "remote-runtime"),
    phase: pickString(remoteMessage.phase, messageRole(remoteMessage) === "assistant" ? "final_answer" : ""),
    state: "completed",
    text: pickString(remoteMessage.text),
    parentMessageId,
    ...(local ? {
      // Recorded as not sent: the mirror acknowledgement reports `suppressed`.
      deliveryState: "suppressed",
      observedVia: "remote_runtime_local_reply",
    } : {
      connector: "whatsapp",
      chatId: pickString(remoteMessage.chatId, binding.chatId),
      accountId: pickString(binding.responderAccountId, binding.outboundAccountId, remoteMessage.accountId),
    }),
    routerTraceId: pickString(remoteMessage.routerTraceId, parent?.routerTraceId),
    turnId: pickString(remoteMessage.turnId, parent?.turnId),
    createdAt: messageTimestamp(remoteMessage),
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId: pickString(remoteMessage.id, remoteMessage.messageId),
    remoteParentMessageId: pickString(remoteMessage.parentMessageId, remoteMessage.parentId),
    // Optional remote provider/model, shown in the WhatsApp debug footer.
    ...(pickString(remoteMessage.provider) ? { remoteProvider: pickString(remoteMessage.provider).slice(0, 64) } : {}),
    ...(pickString(remoteMessage.model) ? { remoteModel: pickString(remoteMessage.model).slice(0, 64) } : {}),
    ...remoteLayerMetadata(remoteMessage, parent),
    ...(Number.isSafeInteger(remoteMessage.exportSequence) ? { remoteExportSequence: String(remoteMessage.exportSequence) } : {}),
    ...(pickString(remoteMessage.kind).toLowerCase() === "progress" ? { remoteKind: "progress" } : {}),
    remoteSyncedAt: new Date().toISOString(),
    ...(attachments.length ? { attachments } : {}),
  }, env);
  if (local) return appended;
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

export async function syncRemoteWhatsAppThreadMessages(env = process.env, fetchImpl = fetch, options = {}) {
  const results = [];
  const lookupTimerAccounts = createTimerAccountLookup(env, fetchImpl);
  for (const thread of await listThreads(env)) {
    if (options.threadIds && !options.threadIds.includes(thread.id)) continue;
    const remote = remoteWhatsAppRuntimeBinding(thread, env);
    if (!remote || remote.binding.remoteMirrorEnabled === false) continue;
    if (!options.push && remote.binding.mirrorToWhatsApp === false && remoteBackendHasPushWatch(remote.backendId, env)) continue;
    await withRemoteThreadSync(thread.id, env, async () => {
    // Retry V1-local input whose forward did not complete (restart, outage).
    await routeHeldLocalInputs(thread, env, { fetchImpl, forward: forwardLocalInputToRemote }).catch(() => null);
    try {
      const { backend, payload, messages: remoteMessages } = await fetchRemoteThreadMessages(remote, env, fetchImpl, options.signal);
      const currentRemote = remoteWhatsAppRuntimeBinding(await getThread(thread.id, env), env);
      if (!currentRemote || currentRemote.backendId !== remote.backendId || currentRemote.remoteThreadId !== remote.remoteThreadId || currentRemote.binding.remoteMirrorEnabled === false)
        throw new Error('remote_binding_changed_during_import');
      // Every store write bumps this revision, so an unchanged fingerprint after the
      // import loops proves localMessages is still what a fresh read would return.
      const listedFingerprint = await threadMessageStoreFingerprint(thread.id, env).catch(() => null);
      const localMessages = await listThreadMessages(thread.id, env);
      const localByRemoteId = new Map(
        localMessages
          .filter(message => message.remoteBackend === remote.backendId && message.remoteThreadId === remote.remoteThreadId)
          .map((message) => [pickString(message.remoteMessageId), message])
          .filter(([id]) => id),
      );
      let imported = 0;
      let updated = 0;
      let unmapped = 0;
      // Recover user acknowledgements first, even when replies precede them in
      // the fetched page. An assistant still needs an ordinary mapped parent.
      for (const remoteMessage of remoteMessages) {
        if (messageRole(remoteMessage) !== "user") continue;
        const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
        if (!remoteMessageId) continue;
        const known = localByRemoteId.get(remoteMessageId);
        // V2 timer turns have no V1 input; give their reply a local parent once.
        if (known?.source === remoteTimerParentSource) continue;
        if (!known && remoteMessage.source === remoteTimerParentSource) {
          const timerParent = await materializeRemoteTimerParent({ thread, remote, remoteMessage, remoteMessages, localMessages, env, fetchImpl, lookupAccounts: lookupTimerAccounts });
          if (timerParent) {
            localByRemoteId.set(remoteMessageId, timerParent.message);
            if (timerParent.created) imported += 1;
          }
          continue;
        }
        const local = known || remoteParentRecoveryCandidate(thread, remote, remoteMessage, localMessages, remoteMessages);
        if (!local || local.role !== "user") continue;
        const changed = await updatePublicRemoteParent(thread, local, remoteMessage, remote, env, !known);
        if (!changed) continue;
        localByRemoteId.set(remoteMessageId, changed);
        updated += 1;
      }
      for (const remoteMessage of remoteMessages) {
        const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
        if (!remoteMessageId) continue;
        const local = localByRemoteId.get(remoteMessageId);
        if (local || !completedAssistantMessage(remoteMessage)) continue;
        const parentMessageId = publicParentIdForRemoteMessage(remoteMessage, localByRemoteId);
        if (!parentMessageId && remote.binding.remoteMirrorOrphanReplies !== true) { unmapped += 1; continue; }
        const parent = parentMessageId ? localMessages.find((message) => message.id === parentMessageId) ||
          localByRemoteId.get(pickString(remoteMessage.parentMessageId, remoteMessage.parentId)) || null : null;
        const appended = await appendRemoteAssistantMessage({ thread, remote, remoteMessage, parentMessageId, parent, env });
        localByRemoteId.set(remoteMessageId, appended);
        imported += 1;
      }
      // Report outbox outcomes only to runtimes that hold replies until acknowledged.
      const acks = remoteMirrorAckSupported(payload)
        ? await acknowledgeRemoteMirrorDeliveries({
            thread,
            remote,
            env,
            // Skip a second full parse of long threads when nothing was written since the read.
            messages: listedFingerprint &&
              listedFingerprint === await threadMessageStoreFingerprint(thread.id, env).catch(() => null)
              ? localMessages
              : null,
            readState: options.readState,
            postAck: (body) => remoteJson(backend, `threads/${encodeURIComponent(remote.remoteThreadId)}/mirror-acks`, fetchImpl, {
              method: "POST",
              body: JSON.stringify(body),
            }),
          })
        : null;
      if (imported || updated || acks?.acknowledged || acks?.rejected) {
        await appendEvent({
          type: "whatsapp_remote_runtime_messages_synced",
          threadId: thread.id,
          remoteBackend: remote.backendId,
          remoteThreadId: remote.remoteThreadId,
          imported,
          updated,
          ...(acks ? { acknowledged: acks.acknowledged, ackRejected: acks.rejected, ackedThrough: payload.mirrorAck.ackedThrough } : {}),
        }, env);
      }
      results.push({
        threadId: thread.id, remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, imported, updated, unmapped,
        ...(acks ? { acks } : {}),
      });
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
    });
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
