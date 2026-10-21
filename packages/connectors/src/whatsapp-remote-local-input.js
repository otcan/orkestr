// V1-local input on a thread delegated to a remote runtime (Orkestr V2).
//
// The scoped relay forwards WhatsApp group input itself. Everything else V1
// queues for a delegated thread (thread-to-thread and agent messages, watch
// results, Worker assignments, mailbox and job signals, CLI `orkestr send`, the
// V1 web UI) is forwarded here as the adapter's `v1_local` input kind, with its
// source and origin. The reply comes back through the remote mirror import as
// an ordinary final answer on this thread, so the requester receives it the
// way V1 delivers any reply (a watch result, a bridge read, the UI). It is not
// sent to the WhatsApp group, exactly like a V1 reply to such input on a
// relay-bound thread.
//
// Forwarding is idempotent: the public message id keys the adapter's ledger,
// the body is deterministic, and the acknowledgement (`remoteMessageId`) is
// recorded on the local message. A restart re-sends an unacknowledged input and
// the adapter answers with the same remote id.
import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThreadMessage } from "../../core/src/threads.js";
import { backendForBinding, remoteJson, remoteWhatsAppRuntimeBinding } from "./whatsapp-remote-runtime.js";
import { uploadRemoteInputAttachments } from "./whatsapp-remote-attachment-upload.js";
import { scopedRelayRemoteAccountId } from "./whatsapp-scoped-relay-remote.js";

export const localInputKind = "v1_local";
export const localInputUnsupported = "remote_runtime_local_input_unsupported";
const textLimit = 24_000;
const labelLimit = 64;
const kindsCacheMs = 60_000;
const defaultMaxAgeMs = 24 * 60 * 60 * 1000;
const kindsCache = new Map();

const externalSources = new Set(["mailbox_route", "job_alert_email", "vm_mailbox_relay", "agent_job"]);
const sourceLabels = {
  ui: "Orkestr web UI",
  cli: "Orkestr CLI",
  mailbox_route: "Mailbox route",
  job_alert_email: "Job alert e-mail",
  vm_mailbox_relay: "Mailbox relay",
  agent_job: "Agent job",
  worker_assignment: "Worker assignment",
  orkestr_worker_handoff: "Worker handoff",
  thread_bridge_message: "Connected assistant",
  thread_watch: "Thread watch",
  manual: "Owner (manual)",
  manual_recovery: "Owner (manual recovery)",
};
const ownerSources = new Set(["ui", "web", "manual", "manual_recovery"]);

function clean(value) {
  return String(value ?? "").trim();
}

function label(value, fallback) {
  const text = clean(value).replace(/[\u0000-\u001f\u007f:]/g, " ").replace(/\s+/g, " ").trim().slice(0, labelLimit).trim();
  return text || fallback;
}

function senderRef(value) {
  const text = clean(value);
  return /^[A-Za-z0-9_.:@-]{1,128}$/.test(text) ? text : "";
}

function sourceType(message = {}) {
  const source = clean(message.source).toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 64);
  return /^[a-z0-9]/.test(source) ? source : "v1_input";
}

async function threadLabel(threadId, env) {
  const thread = threadId ? await getThread(threadId, env).catch(() => null) : null;
  return label(thread?.bindingName || thread?.name, threadId);
}

// Who sent this input, as the adapter's origin: owner | agent | external.
export async function localInputOrigin(message = {}, env = process.env) {
  const source = sourceType(message);
  const senderThreadId = clean(message.reportSourceThreadId || message.threadWatchSourceThreadId);
  if (senderThreadId) {
    return { role: "agent", label: await threadLabel(senderThreadId, env), ...(senderRef(senderThreadId) ? { senderRef: senderRef(senderThreadId) } : {}) };
  }
  if (clean(message.bridgeAgentId)) {
    const ref = senderRef(message.bridgeAgentId);
    return { role: "agent", label: sourceLabels.thread_bridge_message, ...(ref ? { senderRef: ref } : {}) };
  }
  if (externalSources.has(source) || clean(message.connector).toLowerCase() === "mailbox") {
    return { role: "external", label: label(sourceLabels[source], "External signal") };
  }
  return { role: ownerSources.has(source) ? "owner" : "agent", label: label(sourceLabels[source], `Orkestr ${source}`) };
}

function attachmentLines(message = {}) {
  return (Array.isArray(message.attachments) ? message.attachments : []).map((entry) => {
    const name = clean(entry?.name || entry?.filename);
    const where = clean(entry?.path || entry?.saved_path || entry?.url);
    return where ? `- ${name && !where.endsWith(name) ? `${name}: ` : ""}${where}` : name ? `- ${name}` : "";
  }).filter(Boolean);
}

// The text sent for one local input. Deterministic, so a re-send is idempotent.
export function localInputText(thread, message = {}, { attachmentUpload = false } = {}) {
  let text = clean(message.text);
  const promptFile = clean(message.promptFile);
  if (promptFile) text = text ? `${text}\n\nPrompt file: ${promptFile}` : `Run the prompt file: ${promptFile}`;
  if (text.length > textLimit) {
    text = `${text.slice(0, textLimit)}…\n(truncated by Orkestr V1; full text: orkestr watch read ${thread.id} --message ${message.id})`;
  }
  const files = attachmentUpload ? [] : attachmentLines(message);
  if (files.length) text = `${text}${text ? "\n\n" : ""}Attachments (files on the Orkestr host):\n${files.join("\n")}`;
  return text;
}

// Input V1 queued for a delegated thread that did not come from the WhatsApp
// group (thread-to-thread, agent, mailbox, CLI, UI ...). `body` is built by
// whatsapp-remote-local-input.js; files go through the same upload route.
export async function enqueueRemoteLocalThreadInput({ thread, message, body = {} } = {}, env = process.env, fetchImpl = fetch) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  const backend = backendForBinding(remote.binding, env);
  const threadPath = `threads/${encodeURIComponent(remote.remoteThreadId)}`;
  const uploaded = backend.attachmentUpload
    ? await uploadRemoteInputAttachments({
        thread,
        message,
        env,
        post: (upload) => remoteJson(backend, `${threadPath}/attachments`, fetchImpl, { method: "POST", body: JSON.stringify(upload) }),
      })
    : null;
  const payload = await remoteJson(backend, `${threadPath}/input`, fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      ...body,
      ...(uploaded?.length ? { attachments: uploaded } : {}),
      inputKind: "v1_local",
      role: "user",
      connector: "orkestr-v1",
      publicThreadId: thread?.id || "",
      publicMessageId: message?.id || "",
    }),
  });
  return { ...remote, backend, payload, message: payload?.message || null };
}

// The input kinds the remote runtime accepts for this thread (its health route).
export async function remoteThreadInputKinds(thread, env = process.env, fetchImpl = fetch) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return [];
  const backend = backendForBinding(remote.binding, env);
  const payload = await remoteJson(backend, `threads/${encodeURIComponent(remote.remoteThreadId)}/health`, fetchImpl, { method: "GET" });
  return Array.isArray(payload?.inputKinds) ? payload.inputKinds.map((kind) => clean(kind)).filter(Boolean) : [];
}

export function localInputMaxAgeMs(env = process.env) {
  const value = Number(env.ORKESTR_REMOTE_LOCAL_INPUT_MAX_AGE_MS || 0);
  return Number.isFinite(value) && value >= 60_000 ? value : defaultMaxAgeMs;
}

async function supportsLocalInput(thread, remote, env, fetchImpl, now) {
  const key = `${remote.backendId}\n${remote.remoteThreadId}`;
  const cached = kindsCache.get(key);
  if (cached && now - cached.at < kindsCacheMs) return cached.supported;
  const kinds = await remoteThreadInputKinds(thread, env, fetchImpl);
  const supported = kinds.includes(localInputKind);
  kindsCache.set(key, { at: now, supported });
  return supported;
}

export function resetLocalInputKindsCacheForTest() {
  kindsCache.clear();
}

function definiteRefusal(error) {
  const status = Number(error?.statusCode || 0);
  if (clean(error?.message) === "binding_capacity_reached") return false;
  return status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

function errorCode(error, fallback = "remote_runtime_request_failed") {
  const text = clean(error?.message);
  return /^[a-z0-9_:-]{1,120}$/i.test(text) ? text : fallback;
}

async function settleFailed(thread, message, remote, reason, env, extra = {}) {
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "failed",
    observedVia: "remote_runtime_refused",
    error: reason,
    remoteForwardFailedAt: new Date().toISOString(),
  }, env, { expectedFields: { state: message.state } }).catch(() => null);
  if (updated) {
    await appendEvent({
      type: "remote_runtime_local_input_failed", threadId: thread.id, messageId: message.id, source: clean(message.source) || null,
      remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, reason, ...extra,
    }, env).catch(() => {});
  }
  return updated;
}

// Records a transient hold once per distinct reason; returns null.
async function noteHeld(thread, message, remote, reason, env) {
  if (clean(message.remoteForwardHeld) === reason) return null;
  await updateThreadMessage(thread.id, message.id, { remoteForwardHeld: reason }, env, { expectedFields: { state: message.state } }).catch(() => null);
  await appendEvent({
    type: "remote_runtime_local_input_held", threadId: thread.id, messageId: message.id, source: clean(message.source) || null,
    remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, reason,
  }, env).catch(() => {});
  return null;
}

// Forwards one local input. Returns { forwarded | failed | held } and never
// throws: a transient failure leaves the input queued for the next pass.
export async function forwardLocalInputToRemote({ thread, message, remote }, env = process.env, fetchImpl = fetch, now = Date.now()) {
  const created = Date.parse(message.createdAt || "");
  const expired = Number.isFinite(created) && now - created > localInputMaxAgeMs(env);
  let supported;
  try {
    supported = await supportsLocalInput(thread, remote, env, fetchImpl, now);
  } catch (error) {
    if (expired) return { failed: await settleFailed(thread, message, remote, "remote_runtime_input_expired:unavailable", env) };
    return { held: await noteHeld(thread, message, remote, errorCode(error), env) };
  }
  if (!supported) {
    if (expired) return { failed: await settleFailed(thread, message, remote, `remote_runtime_input_expired:${localInputUnsupported}`, env) };
    return { held: await noteHeld(thread, message, remote, localInputUnsupported, env) };
  }
  const binding = remote.binding || {};
  let body;
  let result;
  try {
    // Files are uploaded when the backend accepts uploads, else named by path.
    const { attachmentUpload } = backendForBinding(binding, env);
    body = {
      source: sourceType(message),
      text: localInputText(thread, message, { attachmentUpload }),
      chatId: clean(binding.chatId),
      accountId: scopedRelayRemoteAccountId(binding),
      externalId: clean(message.clientMessageId || message.externalId || message.id),
      origin: await localInputOrigin(message, env),
    };
    result = await enqueueRemoteLocalThreadInput({ thread, message, body }, env, fetchImpl);
  } catch (error) {
    const code = errorCode(error);
    if (definiteRefusal(error)) return { failed: await settleFailed(thread, message, remote, `remote_runtime_refused:${code}`, env, { status: Number(error?.statusCode || 0) || null }) };
    if (expired) return { failed: await settleFailed(thread, message, remote, `remote_runtime_input_expired:${code}`, env) };
    return { held: await noteHeld(thread, message, remote, code, env) };
  }
  const remoteMessage = result?.message || {};
  const remoteMessageId = clean(remoteMessage.id || remoteMessage.messageId);
  if (!remoteMessageId) return { held: await noteHeld(thread, message, remote, "remote_runtime_unacknowledged", env) };
  const updated = await updateThreadMessage(thread.id, message.id, {
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId,
    remoteInputKind: localInputKind,
    remoteRoutedAt: new Date(now).toISOString(),
    remoteForwardHeld: null,
    state: clean(remoteMessage.state) || "delivered",
    deliveryState: clean(remoteMessage.deliveryState) || "delivered",
    observedVia: clean(remoteMessage.observedVia) || "remote_runtime_forwarded",
    error: null,
  }, env, { expectedFields: { state: message.state } }).catch(() => null);
  if (updated) {
    await appendEvent({
      type: "remote_runtime_local_input_forwarded", threadId: thread.id, messageId: message.id, source: body.source,
      originRole: body.origin.role, remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, remoteMessageId,
      duplicate: result?.payload?.duplicate === true,
    }, env).catch(() => {});
  }
  return { forwarded: updated };
}
