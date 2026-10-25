// Delegated (remote runtime) threads served by the scoped group relay.
//
// The scoped relay posts owner-authored group input to `/api/threads/<id>/input`
// and sends replies itself. For a thread with an enabled remote binding, V1 must
// not execute that input locally (the dispatch fence already holds it); it is
// forwarded to the remote backend instead. Replies come back through the
// existing remote mirror import and are sent by the relay, never by V1's legacy
// outbox: forwarding therefore requires the binding's legacy mirror to be off.
// After the relay confirms a send it reports the provider receipt here, which
// lets the existing mirror acknowledgement settle the remote input.
import crypto from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { appendThreadMessage, getThreadMessage, updateThreadMessage } from "../../core/src/threads.js";
import { enqueueRemoteWhatsAppThreadInput, remoteWhatsAppRuntimeBinding } from "./whatsapp-remote-runtime.js";

export const scopedRelaySource = "whatsapp_group_relay";
export const scopedRelayRefusalSource = "remote-runtime-relay-refusal";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function statusError(code, statusCode) {
  return Object.assign(new Error(code), { statusCode });
}

// Owner-authored relay input is forwarded as the thread owner. Input from an
// admitted group participant carries its own verified author instead (below).
export function scopedRelayRemotePrincipal(thread = {}) {
  return `scoped-owner:${pickString(thread.ownerUserId, "admin")}`;
}

export function scopedRelayRemoteAccountId(binding = {}) {
  return pickString(binding.inboundAccountId, binding.receivingAccountId, binding.senderAccountId, binding.responderAccountId, binding.accountId);
}

// Returns the remote binding when this relay input must be delegated, else null.
export function scopedRelayRemoteBinding(thread, body = {}, env = process.env) {
  if (pickString(body.source) !== scopedRelaySource) return null;
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  // Exactly one sender: with the legacy mirror on, V1's outbox would also send.
  if (remote.binding.mirrorToWhatsApp !== false) throw statusError("scoped_relay_delegation_requires_mirror_disabled", 409);
  if (!body.scopedParticipant) return remote;
  // A group participant the server already admitted for this thread
  // (checkScopedParticipant runs before this). It is forwarded with its own
  // author and never with owner or control authority; the remote runtime
  // applies its explicit participant list on top of V1's policy.
  return { ...remote, participant: scopedRelayRemoteParticipant(thread, body) };
}

const phoneJid = /^\d+@c\.us$/;
const lidJid = /^\d+@lid$/;

// The verified author of an admitted participant input, or a refusal.
export function scopedRelayRemoteParticipant(thread = {}, body = {}) {
  const proof = body.scopedParticipant || {};
  const authorId = pickString(proof.authorId);
  const phoneId = pickString(proof.phoneId);
  if (!phoneJid.test(phoneId) || !(authorId === phoneId || lidJid.test(authorId)) || pickString(body.from) !== authorId
      || proof.threadId !== thread.id || body.senderTrustLevel !== "trusted" || body.controlAllowed === true
      || body.originOwner === true) {
    throw statusError("scoped_relay_participant_unverified", 409);
  }
  return { authorId, phoneId, label: scopedRelayParticipantLabel(thread, authorId, phoneId) };
}

// The binding's display label for a participant, if the owner set one.
export function scopedRelayParticipantLabel(thread = {}, ...ids) {
  const labels = thread?.binding?.additionalParticipantLabels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return "";
  for (const id of ids) {
    const label = String(labels[id] || "").replace(/[\u0000-\u001f\u007f:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
    if (label) return label;
  }
  return "";
}

function definiteRefusal(error) {
  const status = Number(error?.statusCode || 0);
  return status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

// A relay input the remote runtime keeps refusing transiently (a paused or
// refused binding answers 503) is not retried forever: past this age it is
// closed like a definite refusal, so it never runs stale and the owner is told.
const defaultRelayInputMaxAgeMs = 30 * 60 * 1000;

export function scopedRelayInputMaxAgeMs(env = process.env) {
  const value = Number(env.ORKESTR_REMOTE_RELAY_INPUT_MAX_AGE_MS || 0);
  return Number.isFinite(value) && value >= 60_000 ? value : defaultRelayInputMaxAgeMs;
}

function inputExpired(message, env, now = Date.now()) {
  const at = Date.parse(message?.createdAt || "");
  return Number.isFinite(at) && now - at > scopedRelayInputMaxAgeMs(env);
}

// Forwards one relay-posted local user message. Transient failures throw (the
// relay retries the same idempotent input); a definite refusal is recorded and
// answered once so the relay can tell the owner and close the turn.
export async function forwardScopedRelayInputToRemote({ thread, message, remote }, env = process.env, fetchImpl = fetch) {
  if (!thread || !message?.id || !remote) throw statusError("scoped_relay_forward_invalid", 400);
  if (message.remoteMessageId && message.remoteBackend === remote.backendId && message.remoteThreadId === remote.remoteThreadId) {
    return { message, forwarded: false, duplicate: true };
  }
  if (message.observedVia === "remote_runtime_refused") return { message, forwarded: false, refused: true };
  const binding = remote.binding;
  const accountId = scopedRelayRemoteAccountId(binding);
  const chatId = pickString(binding.chatId);
  const participant = remote.participant;
  const principal = participant ? participant.authorId : scopedRelayRemotePrincipal(thread);
  const input = {
    source: "whatsapp_inbound",
    text: String(message.text || ""),
    chatId,
    accountId,
    from: principal,
    externalId: pickString(message.externalId, message.clientMessageId, message.id),
    externalPrincipal: {
      connector: "whatsapp", accountId, chatId, threadId: thread.id,
      senderId: principal, participantId: principal, fromMe: !participant,
      ...(participant ? { phoneId: participant.phoneId } : {}),
    },
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    senderParticipantId: principal,
    senderTrustLevel: participant ? "trusted" : "owner",
    senderEffectiveRole: participant ? "trusted" : "owner",
    originTransport: "whatsapp-scoped-group-relay",
    ...(participant ? {
      senderPhoneId: participant.phoneId,
      ...(participant.label ? { senderLabel: participant.label } : {}),
      senderPolicyMode: "this-thread-only",
      originOwner: false, controlAllowed: false, parseCommands: false,
    } : {}),
  };
  let result;
  try {
    result = await enqueueRemoteWhatsAppThreadInput({ thread, message, input }, env, fetchImpl);
  } catch (error) {
    const definite = definiteRefusal(error);
    const expired = !definite && inputExpired(message, env);
    const failure = /^[a-z0-9_:-]{1,120}$/i.test(String(error?.message || "")) ? error.message : "remote_runtime_request_failed";
    const reason = expired ? `remote_runtime_input_expired:${Number(error?.statusCode || 0) || "unavailable"}` : failure;
    await appendEvent({
      type: "whatsapp_scoped_relay_remote_forward_failed", threadId: thread.id, messageId: message.id,
      remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, error: failure,
      definite, expired,
    }, env).catch(() => {});
    if (!definite && !expired) throw statusError("scoped_relay_remote_unavailable", 502);
    const refused = await updateThreadMessage(thread.id, message.id, {
      state: "failed", deliveryState: "failed", observedVia: "remote_runtime_refused", error: reason,
      remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId,
    }, env).catch(() => message);
    await appendThreadMessage(thread.id, {
      role: "assistant", phase: "final_answer", state: "completed", source: scopedRelayRefusalSource,
      connector: "whatsapp", chatId, parentMessageId: message.id,
      clientMessageId: `remote-refusal:${message.id}`, dedupeAssistantByIdempotencyKey: true,
      text: `The Rust runtime did not accept this message (${reason}). It was not run.`,
    }, env);
    return { message: refused, forwarded: false, refused: true, error: reason };
  }
  const remoteMessage = result?.message || {};
  const remoteMessageId = pickString(remoteMessage.id, remoteMessage.messageId);
  if (!remoteMessageId) throw statusError("scoped_relay_remote_unacknowledged", 502);
  const updated = await updateThreadMessage(thread.id, message.id, {
    remoteBackend: remote.backendId,
    remoteThreadId: remote.remoteThreadId,
    remoteMessageId,
    remoteRoutedAt: new Date().toISOString(),
    state: pickString(remoteMessage.state, "delivered"),
    deliveryState: pickString(remoteMessage.deliveryState, "delivered"),
    observedVia: pickString(remoteMessage.observedVia, "remote_runtime_forwarded"),
    error: null,
  }, env);
  await appendEvent({
    type: "whatsapp_scoped_relay_remote_forwarded", threadId: thread.id, messageId: message.id,
    remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, remoteMessageId,
  }, env).catch(() => {});
  return { message: updated, forwarded: true };
}

function receiptIds(value) {
  if (!Array.isArray(value) || value.length > 32) throw statusError("scoped_relay_delivery_invalid", 400);
  const ids = value.map(item => pickString(item));
  if (ids.some(id => !id || id.length > 256)) throw statusError("scoped_relay_delivery_invalid", 400);
  return [...new Set(ids)];
}

const notSentOutcomes = new Set(["suppressed", "failed"]);

// Records the relay's confirmed provider send for one mirrored remote reply. The
// mirror acknowledgement loop then reports it as `delivered`. Never sends.
// `outcome: "suppressed"|"failed"` instead records a definite non-send (an
// expired or rejected notification) so the remote input can settle.
export async function recordScopedRelayRemoteDelivery({ thread, messageId, body = {} }, env = process.env) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) throw statusError("scoped_relay_delivery_not_delegated", 409);
  if (remote.binding.mirrorToWhatsApp !== false) throw statusError("scoped_relay_delegation_requires_mirror_disabled", 409);
  const message = await getThreadMessage(thread.id, messageId, env);
  if (!message) throw statusError("message_not_found", 404);
  if (message.role !== "assistant" || !pickString(message.remoteMessageId) ||
      message.remoteBackend !== remote.backendId || message.remoteThreadId !== remote.remoteThreadId) {
    throw statusError("scoped_relay_delivery_target_invalid", 409);
  }
  const outcome = pickString(body.outcome, "delivered");
  if (outcome !== "delivered") return recordNotSent({ thread, message, remote, outcome, body }, env);
  const requestIds = receiptIds(body.requestIds);
  const providerIds = receiptIds(body.connectorMessageIds || []);
  if (!requestIds.length) throw statusError("scoped_relay_delivery_invalid", 400);
  const outboxJobId = `scoped-relay:${crypto.createHash("sha256").update(requestIds.join("\n")).digest("hex").slice(0, 40)}`;
  if (notSentOutcomes.has(pickString(message.deliveryState))) throw statusError("scoped_relay_delivery_conflict", 409);
  if (pickString(message.deliveryState) === "delivered") {
    if (pickString(message.mirrorOutboxJobId) !== outboxJobId) throw statusError("scoped_relay_delivery_conflict", 409);
    return { message, duplicate: true };
  }
  const deliveredAt = Number.isFinite(Date.parse(body.deliveredAt)) ? new Date(Date.parse(body.deliveredAt)).toISOString() : new Date().toISOString();
  const updated = await updateThreadMessage(thread.id, message.id, {
    deliveryState: "delivered",
    deliveredAt,
    mirrorOutboxJobId: outboxJobId,
    whatsappMessageIds: providerIds,
    observedVia: "whatsapp_scoped_group_relay",
  }, env);
  await appendEvent({
    type: "whatsapp_scoped_relay_remote_delivery_recorded", threadId: thread.id, messageId: message.id,
    remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, outboxJobId, providerIds: providerIds.length,
  }, env).catch(() => {});
  return { message: updated, duplicate: false };
}

async function recordNotSent({ thread, message, remote, outcome, body }, env) {
  if (!notSentOutcomes.has(outcome)) throw statusError("scoped_relay_delivery_invalid", 400);
  const reason = /^[a-z0-9_:-]{1,120}$/i.test(String(body.reason || "")) ? String(body.reason) : outcome;
  const current = pickString(message.deliveryState);
  if (current === outcome) return { message, duplicate: true };
  if (current === "delivered" || notSentOutcomes.has(current)) throw statusError("scoped_relay_delivery_conflict", 409);
  const updated = await updateThreadMessage(thread.id, message.id, {
    deliveryState: outcome,
    deliveryReason: reason,
    observedVia: "whatsapp_scoped_group_relay",
  }, env);
  await appendEvent({
    type: "whatsapp_scoped_relay_remote_delivery_recorded", threadId: thread.id, messageId: message.id,
    remoteBackend: remote.backendId, remoteThreadId: remote.remoteThreadId, outcome, reason,
  }, env).catch(() => {});
  return { message: updated, duplicate: false };
}
